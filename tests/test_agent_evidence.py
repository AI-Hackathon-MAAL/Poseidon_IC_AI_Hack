import unittest
from unittest.mock import Mock

from poseidon.agent import Case, Context, assess, tool_activity_around_event, tool_vessel_history, tool_web_search_vessel
from poseidon.brief import write_brief
from poseidon.scoring import score_case
from poseidon.search import SearchClient, SearchError


class InvestigationEvidence(unittest.TestCase):
    def setUp(self):
        self.case = Case("mpa", "Reserve", "v", "Orion", "XX", None, None, [
            {"event_id": "gap", "event_type": "gap", "start_time": "2025-02-15T08:00:00Z",
             "end_time": "2025-02-17T08:00:00Z", "duration_hours": 48}])
        self.ctx = Context(gfw=Mock(), search=Mock(), window_start="2025-01-01", window_end="2025-12-31")

    def test_negated_and_unrelated_reports_remain_clickable_unscored_leads(self):
        titles = ["Orion was cleared of illegal fishing", "Orion rescues crew from a detained vessel"]
        sources = [{"title": t, "snippet": t, "url": f"https://example.org/{i}"} for i, t in enumerate(titles)]
        self.ctx.search.search.return_value = {"answer": "Orion was detained.", "sources": sources}
        before = score_case(self.case)["risk_score"]
        evidence, trace = tool_web_search_vessel(self.ctx, self.case)
        self.case.evidence["web_search_vessel"] = evidence
        report = assess(self.ctx, self.case)
        self.assertEqual(report["risk_score"], before)
        self.assertIn("analyst review", trace)
        self.assertTrue(any("why reporting stopped" in u for u in report["unknowns"]))
        text, _ = write_brief(self.ctx, self.case, report)
        self.assertIn(sources[1]["url"], text)
        self.assertNotIn("Orion was detained.", text)

    def test_history_ends_before_anchor_activity_is_limited_to_72_hours(self):
        self.ctx.gfw.count_events.return_value = 1
        history, _ = tool_vessel_history(self.ctx, self.case)
        self.assertLess(history["period_end"], "2025-02-15")
        # The date-level API can return rows from elsewhere in either edge day.
        raw = [{"id": "within", "start": "2025-02-20T08:00:00Z", "end": "2025-02-20T10:00:00Z"},
               {"id": "too_late", "start": "2025-02-20T09:00:00Z", "end": "2025-02-20T11:00:00Z"}]
        self.ctx.gfw.events.side_effect = lambda kind, *a, **kw: (raw, False) if kind == "fishing" else ([], True)
        activity, _ = tool_activity_around_event(self.ctx, self.case)
        self.assertEqual([r["hours_after"] for r in activity["after"]], [72])
        self.assertTrue(activity["partial_errors"])
        self.case.evidence.update(activity_around_event=activity, resolve_identity={"found": True},
                                  vessel_history=history, web_search_vessel={"sources": []})
        report = assess(self.ctx, self.case)
        self.assertEqual(report["status"], "incomplete")
        self.assertNotEqual(report["confidence"], "high")

    def test_search_provider_keeps_date_limits_and_rejects_invalid_filters(self):
        session = Mock()
        session.post.return_value.status_code = 400
        with self.assertRaises(SearchError):
            SearchClient("key", session=session).search("recent news", from_date="2025-01-01", to_date="2025-02-01")
        session.post.assert_called_once()
        self.assertEqual(session.post.call_args.kwargs["json"]["fromDate"], "2025-01-01")
        session.post.return_value.status_code = 200
        session.post.return_value.json.return_value = {"results": []}
        SearchClient("key", provider="tavily", session=session).search("news", from_date="2025-01-01", to_date="2025-02-01")
        body = session.post.call_args.kwargs["json"]
        self.assertEqual((body["start_date"], body["end_date"]), ("2025-01-01", "2025-02-01"))
