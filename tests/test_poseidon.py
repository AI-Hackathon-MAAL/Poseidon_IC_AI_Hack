import json
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock

from poseidon import contract, pipeline
from poseidon.agent import Context
from poseidon.gfw import GFWClient, GFWError, flatten_event, resolve_window
from poseidon.sample import SAMPLE_MPAS, SampleGFW, SampleLLM, SampleSearch, _event, V_B
from poseidon.search import SearchClient

MPAS = pipeline.select_mpas(SAMPLE_MPAS, search="sample")


def make_ctx(llm=None, search=True, gfw=None, mode="history"):
    return Context(gfw=gfw or SampleGFW(), window_start="2026-10-01", window_end="2026-10-31", mode=mode,
                   search=SampleSearch() if search else None, llm=llm)


def run(ctx, **kw):
    return pipeline.run(ctx, MPAS, log=lambda *_: None, **kw)


def case(out, vessel_id):
    return next(c for c in out["cases"] if c["vessel_id"] == vessel_id)


def steps(out, vessel_id):
    return [s for s in out["steps"] if s["case_id"].endswith(vessel_id)]


class WindowAndSelection(unittest.TestCase):
    def test_modes_differ_only_by_window(self):
        now = datetime(2026, 11, 14, 12, tzinfo=timezone.utc)
        self.assertEqual(resolve_window("live", lookback_days=30, now=now), ("2026-10-15", "2026-11-15"))
        self.assertEqual(resolve_window("history", "2025-01-01", "2025-12-31"), ("2025-01-01", "2025-12-31"))
        with self.assertRaises(ValueError):
            resolve_window("history", "2025-12-31", "2025-01-01")

    def test_mpa_search_ignores_accents_and_ids_win(self):
        mpas = [{"id": 11753, "label": "Galápagos - Reserva Marina"}, {"id": 191, "label": "Îles Galápagos"}, {"id": 5, "label": "Other"}]
        self.assertEqual([m["mpa_id"] for m in pipeline.select_mpas(mpas, search="galapagos")], ["11753", "191"])
        self.assertEqual([m["mpa_id"] for m in pipeline.select_mpas(mpas, search="galapagos", ids="191")], ["191"])
        with self.assertRaises(ValueError):
            pipeline.select_mpas(mpas, ids="999")


class PolicyDrivenRun(unittest.TestCase):
    """No language model: the rule-based policy must still run a full, adaptive investigation."""

    @classmethod
    def setUpClass(cls):
        cls.out = run(make_ctx())

    def test_every_case_investigated_and_scored(self):
        self.assertEqual(len(self.out["cases"]), 4)
        self.assertTrue(all(c["status"] in ("complete", "incomplete") for c in self.out["cases"]))
        self.assertTrue(all(s["decided_by"] == "policy" for s in self.out["steps"]))

    def test_unnamed_vessel_identity_resolved_first_then_scored_high(self):
        s = steps(self.out, "sample-vessel-dark")
        self.assertEqual(s[0]["tool"], "resolve_identity")
        self.assertIn("web_search_owner", [x["tool"] for x in s])   # only available once identity found an owner
        dark = case(self.out, "sample-vessel-dark")
        self.assertEqual(dark["vessel_name"], "SAMPLE DARK STAR")
        self.assertEqual(dark["longest_gap_hours"], 100.0)
        self.assertEqual(dark["risk_level"], "high")
        self.assertEqual(dark["status"], "complete")
        texts = " ".join(r["text"] for r in dark["reasons"])
        self.assertIn("within 48 hours", texts)       # from the activity check, not the region query
        self.assertIn("more than one flag", texts)
        self.assertIn("158 km", texts)
        self.assertTrue(any(src["kind"] == "web_search_vessel" for src in dark["sources"]))
        self.assertEqual(dark["risk_score"], min(100, sum(r["points"] for r in dark["reasons"])))

    def test_failed_identity_lookup_is_recorded_not_fatal(self):
        c = case(self.out, "sample-vessel-c")
        failed = [x for x in steps(self.out, "sample-vessel-c") if not x["ok"]]
        self.assertTrue(any(x["tool"] == "resolve_identity" for x in failed))
        self.assertEqual(c["status"], "incomplete")
        self.assertTrue(any("identity" in u.lower() for u in c["unknowns"]))
        self.assertIn("no-take zone", " ".join(r["text"] for r in c["reasons"]))

    def test_encounter_partner_tool_only_where_relevant(self):
        tools_d = [x["tool"] for x in steps(self.out, "sample-vessel-d")]
        tools_b = [x["tool"] for x in steps(self.out, "sample-vessel-b")]
        self.assertIn("encounter_partner", tools_d)
        self.assertNotIn("encounter_partner", tools_b)

    def test_generic_web_sources_do_not_score(self):
        b = case(self.out, "sample-vessel-b")
        self.assertFalse(any(r["basis"] == "web" for r in b["reasons"]))

    def test_news_feed_and_context(self):
        self.assertTrue(self.out["news"])
        self.assertTrue(all(n["url"].startswith("https://example.org/") for n in self.out["news"]))
        self.assertEqual({m["mpa_id"] for m in self.out["mpa_context"]}, {"sample-1", "sample-2"})

    def test_run_row_is_honest_about_no_llm(self):
        r = self.out["run"][0]
        self.assertEqual(r["llm_decisions"], 0)
        self.assertIsNone(r["llm_endpoint"])
        self.assertTrue(any("No language model" in n for n in r["notes"]))


class ModelDrivenRun(unittest.TestCase):
    def test_model_chooses_tools_and_decides_when_to_stop(self):
        out = run(make_ctx(llm=SampleLLM(finish_after=3)))
        s = steps(out, "sample-vessel-dark")
        self.assertTrue(all(x["decided_by"] == "llm" for x in s))
        self.assertEqual(s[-1]["tool"], "finish")
        self.assertEqual(len([x for x in s if x["tool"] != "finish"]), 3)
        dark = case(out, "sample-vessel-dark")
        self.assertEqual(dark["brief_written_by"], "llm")
        self.assertIn("example.org", dark["brief_markdown"])   # links appended when the model omits them
        self.assertGreater(out["run"][0]["llm_decisions"], 0)

    def test_brief_survives_code_fences_and_chatter(self):
        from poseidon.brief import clean_markdown
        self.assertEqual(clean_markdown("Here you go:\n```markdown\n# Title\n## What happened\n- x\n```"),
                         "# Title\n## What happened\n- x")
        self.assertIsNone(clean_markdown("I cannot help with that."))

    def test_unusable_model_answers_fall_back_to_policy(self):
        out = run(make_ctx(llm=lambda system, user: "I think we should look at the weather."))
        self.assertTrue(all(s["decided_by"] == "policy" for s in out["steps"]))
        self.assertTrue(all(c["brief_written_by"] == "template" for c in out["cases"]))

    def test_model_cannot_finish_with_zero_evidence(self):
        out = run(make_ctx(llm=lambda system, user: '{"tool": "finish", "reason": "done"}'))
        first = steps(out, "sample-vessel-dark")[0]
        self.assertEqual((first["decided_by"], first["tool"]), ("policy", "resolve_identity"))
        self.assertIn("Finish rejected", first["reason"])

    def test_model_cannot_pick_a_tool_that_is_not_allowed(self):
        out = run(make_ctx(llm=lambda system, user: '{"tool": "delete_database", "reason": "x"}'))
        self.assertNotIn("delete_database", {s["tool"] for s in out["steps"]})

    def test_model_outage_disables_it_and_run_completes(self):
        def broken(system, user):
            raise RuntimeError("429 rate limited")
        ctx = make_ctx(llm=broken)
        out = run(ctx)
        self.assertTrue(ctx.llm_disabled)
        self.assertEqual(len(out["cases"]), 4)
        self.assertTrue(any("disabled" in n for n in out["run"][0]["notes"]))


class Adaptation(unittest.TestCase):
    def test_temporary_outage_is_retried_once_but_not_found_is_not(self):
        class Flaky(SampleGFW):
            failures_left = 5   # one whole history check (5 event types) fails, then the service recovers

            def count_events(self, kind, start, end, vessel_id):
                if vessel_id == "sample-vessel-b" and self.failures_left:
                    self.failures_left -= 1
                    raise GFWError("GFW POST /events failed after 4 attempts (HTTP 503)")
                return super().count_events(kind, start, end, vessel_id)

        out = run(make_ctx(gfw=Flaky()))
        history_b = [x for x in steps(out, "sample-vessel-b") if x["tool"] == "vessel_history"]
        self.assertEqual([x["ok"] for x in history_b], [False, True])
        self.assertIn("try it once more", history_b[1]["reason"])
        identity_c = [x for x in steps(out, "sample-vessel-c") if x["tool"] == "resolve_identity"]
        self.assertEqual(len(identity_c), 1)   # HTTP 404 is not retried


class Memory(unittest.TestCase):
    def test_unchanged_cases_are_skipped_and_new_evidence_reopens(self):
        first = run(make_ctx())
        memory = pipeline.memory_from_rows(first["cases"])
        second = run(make_ctx(), memory=memory)
        self.assertEqual(second["run"][0]["n_skipped_unchanged"], 3)       # sample-vessel-c was incomplete
        self.assertEqual([c["vessel_id"] for c in second["cases"]], ["sample-vessel-c"])
        self.assertEqual(second["cases"][0]["change"], "retry")

        new_gap = _event("sg-new", "2026-10-25T00:00:00Z", "2026-10-26T06:00:00Z", V_B)
        third = run(make_ctx(gfw=SampleGFW({("sample-1", "gap"): [new_gap]})), memory=memory)
        b = case(third, "sample-vessel-b")
        self.assertEqual(b["change"], "updated")
        self.assertEqual(b["previous_risk_score"], case(first, "sample-vessel-b")["risk_score"])
        self.assertGreater(b["risk_score"], b["previous_risk_score"])

    def test_budget_queues_lower_priority_and_focus_jumps_the_queue(self):
        out = run(make_ctx(), max_cases=1)
        done = [c for c in out["cases"] if c["status"] != "queued"]
        self.assertEqual([c["vessel_id"] for c in done], ["sample-vessel-dark"])   # 100 h gap, unnamed: top priority
        self.assertEqual(sum(c["status"] == "queued" for c in out["cases"]), 3)
        focused = run(make_ctx(), max_cases=1, focus=["vessel b"])
        self.assertEqual([c["vessel_id"] for c in focused["cases"] if c["status"] != "queued"], ["sample-vessel-b"])

    def test_overlapping_areas_keep_each_event_once(self):
        gfw = SampleGFW({("sample-2", "gap"): [_event("sg-2", "2026-10-11T18:00:00Z", "2026-10-12T07:00:00Z", V_B)]})
        out = run(make_ctx(gfw=gfw))
        rows = [e for e in out["events"] if e["event_id"] == "sg-2"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["mpa_id"], rows[0]["also_in_mpas"]), ("sample-1", ["sample-2"]))


class Clients(unittest.TestCase):
    def response(self, status, payload=None, text=""):
        r = Mock(status_code=status, text=text)
        r.json.return_value = payload or {}
        return r

    def test_gfw_retries_then_paginates(self):
        session = Mock(headers={})
        session.request.side_effect = [
            self.response(429),
            self.response(200, {"entries": [{"id": "a"}], "nextOffset": 1, "total": 2}),
            self.response(200, {"entries": [{"id": "b"}], "nextOffset": None, "total": 2}),
        ]
        client = GFWClient("token", session=session, sleep=lambda s: None)
        rows, complete = client.events("gap", "2026-10-01", "2026-10-31", mpa_id="11753", page_size=1)
        self.assertEqual(([r["id"] for r in rows], complete), (["a", "b"], True))
        body = session.request.call_args.kwargs["json"]
        self.assertEqual(body["region"], {"dataset": "public-mpa-all", "id": 11753})
        self.assertEqual(session.request.call_args.kwargs["params"]["offset"], 1)

    def test_gfw_client_error_is_not_retried(self):
        session = Mock(headers={})
        session.request.return_value = self.response(401, text="Unauthorized")
        with self.assertRaises(GFWError) as ctx:
            GFWClient("token", session=session, sleep=lambda s: None).mpas()
        self.assertIn("401", str(ctx.exception))
        self.assertEqual(session.request.call_count, 1)

    def test_flatten_gap_event(self):
        row = flatten_event({"id": 7, "start": "2026-10-02T04:00:00Z", "end": "2026-10-06T08:00:00Z",
                             "vessel": {"id": "v", "name": "", "ssvid": "1"},
                             "gap": {"offPosition": {"lat": 1, "lon": 2}, "onPosition": {"lat": 3, "lon": 4}, "distanceKm": 9}},
                            "gap", 11753, "X")
        self.assertEqual((row["duration_hours"], row["lat"], row["end_lon"], row["vessel_name"]), (100.0, 1, 4, None))
        self.assertEqual(row["details"], {"gap_distance_km": 9})

    def test_linkup_request_and_retry_without_filters(self):
        session = Mock()
        session.post.side_effect = [
            self.response(400, text="bad filter"),
            self.response(200, {"answer": "A", "sources": [{"name": "T", "url": "https://x.org/1", "snippet": "S"},
                                                           {"name": "T2", "url": "https://x.org/1", "snippet": "dup"}]}),
        ]
        res = SearchClient("key", session=session).search("q", from_date="2026-08-01")
        first, second = session.post.call_args_list
        self.assertEqual(first.kwargs["json"]["fromDate"], "2026-08-01")
        self.assertEqual(first.kwargs["json"]["outputType"], "sourcedAnswer")
        self.assertNotIn("fromDate", second.kwargs["json"])
        self.assertEqual(res["sources"], [{"title": "T", "url": "https://x.org/1", "snippet": "S"}])


class Contract(unittest.TestCase):
    def test_rows_fit_tables_and_snapshot_is_json(self):
        out = run(make_ctx(llm=SampleLLM()))
        for table, key in (("events", "events"), ("cases", "cases"), ("agent_steps", "steps"), ("runs", "run"),
                           ("news", "news"), ("mpa_context", "mpa_context")):
            cols = {c for c, _ in contract.TABLES[table]["columns"]}
            for row in out[key]:
                self.assertEqual(set(row) - cols, set(), f"{table} has undeclared fields")
            tuples = contract.to_table_rows(table, out[key])
            self.assertTrue(all(isinstance(v, (str, type(None))) for t in tuples for v in t))
        snap = contract.build_snapshot(out["run"], out["cases"], out["events"], out["steps"], out["news"],
                                       out["mpa_context"], "2026-11-14T20:00:00+00:00")
        json.dumps(snap)
        self.assertEqual(snap["cases"][0]["vessel_id"], "sample-vessel-dark")
        self.assertTrue(snap["cases"][0]["events"] and snap["cases"][0]["steps"])
        reserve = next(m for m in snap["mpas"] if m["mpa_id"] == "sample-1")
        self.assertEqual((reserve["n_cases"], reserve["n_gap"], reserve["n_fishing"]), (3, 2, 1))

    def test_snapshot_accepts_rows_read_back_from_tables(self):
        out = run(make_ctx())
        stringly = [dict(zip([c for c, _ in contract.TABLES["cases"]["columns"]], t))
                    for t in contract.to_table_rows("cases", out["cases"])]
        snap = contract.build_snapshot(out["run"], stringly, out["events"], out["steps"], [], [], "now")
        self.assertIsInstance(snap["cases"][0]["reasons"], list)
        self.assertEqual(snap["mpas"][0]["top_risk_score"], case(out, "sample-vessel-dark")["risk_score"])


class GlobeLayer(unittest.TestCase):
    def test_outline_is_simplified_and_centred(self):
        import math
        from poseidon import geo
        circle = [[math.cos(i / 500 * 2 * math.pi) * 2 - 90, math.sin(i / 500 * 2 * math.pi) * 2] for i in range(5000)]
        circle.append(circle[0])
        feature = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [circle]}}]}
        g = geo.simplify_geometry(feature, max_points=200)
        n = sum(len(r) for poly in g["coordinates"] for r in poly)
        self.assertTrue(8 <= n <= 200, n)
        bbox, lat, lon = geo.bbox_and_center(g)
        self.assertAlmostEqual(lat, 0, delta=0.1)
        self.assertAlmostEqual(lon, -90, delta=0.1)
        self.assertIsNone(geo.simplify_geometry({"type": "Point", "coordinates": [0, 0]}))

    def test_boundary_falls_back_from_gfw_to_wdpa(self):
        from poseidon import geo
        gfw = Mock()
        gfw._request.side_effect = GFWError("HTTP 404")
        session = Mock()
        ok = Mock(status_code=200)
        ok.json.return_value = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {
            "type": "Polygon", "coordinates": [[[-92, -2], [-89, -2], [-89, 1], [-92, 1], [-92, -2]]]}}]}
        session.get.return_value = ok
        b = geo.fetch_boundary("11753", gfw=gfw, session=session)
        self.assertIn("WDPA", b["source"])
        self.assertEqual(b["bbox"], [-92, -2, -89, 1])
        self.assertEqual(session.get.call_args.kwargs["params"]["where"], "WDPAID=11753")
        session.get.return_value = Mock(status_code=500)
        self.assertIsNone(geo.fetch_boundary("11753", gfw=gfw, session=session)["geometry"])

    def test_news_is_placed_by_area_then_country_else_unplaced(self):
        from poseidon import intel
        areas = [{"mpa_id": "11753", "mpa_name": "Galápagos - Reserva Marina", "center_lat": -0.5, "center_lon": -90.5}]
        self.assertEqual(intel.place("Fleet returns to the Galapagos boundary", areas)["place_type"], "mpa")
        self.assertEqual(intel.place("Marine reserve patrols increase", areas)["place_type"], "none")   # generic words do not match
        self.assertEqual(intel.place("Navy of Senegal seizes trawler", areas)["place_name"], "Senegal")
        rows = intel.global_news(SampleSearch(), [{"mpa_id": "sample-2", "mpa_name": "Sample Seamount Sanctuary (synthetic)",
                                                   "center_lat": -3.3, "center_lon": -88}], "2026-10-31", log=lambda *_: None)
        self.assertEqual({r["place_type"] for r in rows}, {"mpa", "country", "none"})

    def test_snapshot_carries_outlines_and_global_news(self):
        from poseidon import geo
        from poseidon.sample import SAMPLE_BOUNDARIES
        out = run(make_ctx(), max_cases=1, per_area=True)
        self.assertEqual(sum(c["status"] != "queued" for c in out["cases"]), 2)   # one per area
        g = geo.simplify_geometry(SAMPLE_BOUNDARIES["sample-1"])
        bbox, lat, lon = geo.bbox_and_center(g)
        shapes = [{"mpa_id": "sample-1", "mpa_name": "x", "geometry": g, "bbox": bbox, "center_lat": lat, "center_lon": lon, "source": "synthetic"},
                  {"mpa_id": "999", "mpa_name": "Not investigated yet", "geometry": g, "bbox": bbox, "center_lat": 1, "center_lon": 2, "source": "synthetic"}]
        snap = contract.build_snapshot(out["run"], out["cases"], out["events"], out["steps"], [], [], "now",
                                       boundaries=shapes, global_news=[{"news_id": "a", "title": "t"}])
        by_id = {m["mpa_id"]: m for m in snap["mpas"]}
        self.assertEqual(by_id["sample-1"]["boundary"]["type"], "MultiPolygon")
        self.assertIsNone(by_id["sample-2"]["boundary"])
        self.assertIsNotNone(by_id["sample-2"]["center_lat"])    # centred on its cases
        self.assertEqual(by_id["999"]["n_cases"], 0)             # outline-only area still on the globe
        self.assertEqual(len(snap["global_news"]), 1)
        json.dumps(snap)

    def test_several_search_terms(self):
        mpas = [{"id": 1, "label": "Galápagos - Reserva Marina"}, {"id": 2, "label": "Îles Galápagos"},
                {"id": 3, "label": "Archipiélago de Colón (Galápagos)"}, {"id": 4, "label": "Revillagigedo"}]
        got = pipeline.select_mpas(mpas, search="galapagos, revillagigedo")
        self.assertEqual([m["mpa_id"] for m in got], ["1", "2", "4"])    # at most 2 per term


class RealDataFixes(unittest.TestCase):
    def test_gear_buoys_and_tour_boats_are_not_cases(self):
        buoy = {"id": "sample-buoy", "name": "D-RUFFO001-99%", "ssvid": "772851001", "flag": None, "type": "GEAR"}
        tour = {"id": "sample-tour", "name": "TOUR BOAT", "ssvid": "735000001", "flag": "ECU", "type": "PASSENGER"}
        gfw = SampleGFW({("sample-1", "gap"): [_event("b1", "2026-10-01T00:00:00Z", "2026-10-30T00:00:00Z", buoy),
                                                _event("t1", "2026-10-03T00:00:00Z", "2026-10-04T00:00:00Z", tour)]})
        out = run(make_ctx(gfw=gfw))
        self.assertNotIn("sample-buoy", {c["vessel_id"] for c in out["cases"]})
        self.assertNotIn("sample-tour", {c["vessel_id"] for c in out["cases"]})
        self.assertNotIn("b1", {e["event_id"] for e in out["events"]})
        self.assertTrue(any("non-fishing vessel types" in n for n in out["run"][0]["notes"]))
        everything = pipeline.run(make_ctx(gfw=gfw), MPAS, log=lambda *_: None, exclude_types=())
        self.assertIn("sample-buoy", {c["vessel_id"] for c in everything["cases"]})

    def test_vessel_database_pages_are_not_web_risk_hits(self):
        from poseidon.scoring import web_risk_hits
        sources = [{"url": "https://maritimeoptima.com/public/vessels/pages/imo:9679634/F_V_BELLE_ISLE.html",
                    "title": "F/V BELLE ISLE", "snippet": "BELLE ISLE fishing vessel. Check IUU vessel lists."},
                   {"url": "https://news.example.org/a", "title": "BELLE ISLE detained", "snippet": "The BELLE ISLE was detained."}]
        self.assertEqual(web_risk_hits(sources, ["BELLE ISLE"]), ["https://news.example.org/a"])

    def test_flagship_selection_prefers_the_reserve_over_overlapping_designations(self):
        mpas = [{"id": 191, "label": "Îles Galápagos - World Heritage Site (natural or mixed)"},
                {"id": 10708, "label": "Archipiélago de Colón (Galápagos) - UNESCO-MAB Biosphere Reserve"},
                {"id": 11753, "label": "Galápagos - Reserva Marina"},
                {"id": 7, "label": "Revillagigedo - World Heritage Site"}, {"id": 8, "label": "Revillagigedo - Parque Nacional"},
                {"id": 9, "label": "Cocos Island National Park"}]
        got = pipeline.select_mpas(mpas, search="galapagos, revillagigedo, isla del coco|cocos island", per_term=1)
        self.assertEqual([m["mpa_id"] for m in got], ["11753", "8", "9"])


class ReviewFixes(unittest.TestCase):
    """Bugs found by checking the first real flagship run against its own data."""

    BOX = {"type": "MultiPolygon", "coordinates": [[[[-92.6, -2.0], [-88.9, -2.0], [-88.9, 1.2], [-92.6, 1.2], [-92.6, -2.0]]]]}

    def scored(self, events, evidence=None):
        from poseidon.agent import Case
        from poseidon.scoring import score_case
        c = Case("sample-1", "Sample Reserve", "v", "TEST VESSEL", "XXX", "1", "fishing", events)
        c.evidence = evidence or {}
        return score_case(c)

    def gap(self, hours, start_inside, end_inside):
        return {"event_id": "g", "event_type": "gap", "duration_hours": hours, "start_time": "2026-10-01T00:00:00Z",
                "end_time": "2026-10-05T00:00:00Z", "details": {"gap_start_inside": start_inside, "gap_end_inside": end_inside}}

    def test_gap_with_both_ends_outside_is_not_scored_as_dark_inside_the_area(self):
        crossing = self.scored([self.gap(1466, False, False)])
        inside = self.scored([self.gap(130, True, True)])
        self.assertEqual(crossing["risk_score"], 10)
        self.assertIn("presence inside is not established", crossing["reasons"][0]["text"])
        self.assertTrue(any("both ends of the gap lie outside" in c for c in crossing["caveats"]))
        self.assertEqual(inside["risk_score"], 45)   # 30 + 15 for 3+ days
        self.assertGreater(inside["risk_score"], crossing["risk_score"])

    def test_pipeline_locates_gaps_against_the_outline(self):
        out = run(make_ctx(), boundaries={"sample-1": self.BOX})
        gaps = {e["event_id"]: e["details"] for e in out["events"] if e["event_type"] == "gap"}
        self.assertEqual((gaps["sg-1"]["gap_start_inside"], gaps["sg-1"]["gap_end_inside"]), (True, True))
        self.assertNotIn("gap_start_inside", gaps["sg-3"])            # sample-2 has no outline
        self.assertIn("losing or regaining signal inside", case(out, "sample-vessel-dark")["headline"])
        self.assertTrue(any("could not be located" in n for n in out["run"][0]["notes"]))

    def test_spelling_variants_are_not_name_changes(self):
        from poseidon.scoring import distinct_names
        self.assertEqual(len(distinct_names(["CAP. DANNY B", "CAP.DANNY B"])), 1)
        self.assertEqual(len(distinct_names(["BELLERIVE", "F/V BELLE RIVE"])), 1)
        self.assertEqual(len(distinct_names(["DOÑA TERE", "DONA TERE", "TITIS"])), 2)
        self.assertEqual(len(distinct_names(["DIVA MARIA", "CHACAO"])), 2)

    def test_authorised_fishing_scores_less_than_unauthorised(self):
        def fish(status):
            return {"event_id": "f", "event_type": "fishing", "start_time": "2026-10-01T00:00:00Z", "end_time": None,
                    "duration_hours": 2, "details": {"authorization_status": status}}
        ok = self.scored([fish("publicly_authorized")])
        bad = self.scored([fish("not_matching_relevant_public_authorization")])
        self.assertEqual((ok["risk_score"], bad["risk_score"]), (5, 20))
        self.assertTrue(any("permitted" in c for c in ok["caveats"]))

    def test_loitering_alone_is_not_called_a_meeting(self):
        loiter = {"event_id": "l", "event_type": "loitering", "duration_hours": 3, "start_time": "2026-10-01T00:00:00Z", "details": {}}
        r = self.scored([loiter])["reasons"][0]
        self.assertEqual(r["points"], 5)
        self.assertNotIn("another vessel", r["text"])

    def test_web_hit_about_a_different_ship_with_the_same_name_is_ignored(self):
        from poseidon.scoring import web_risk_hits
        src = [{"url": "https://news.example.org/x", "title": "JUAN PABLO II (IMO 9252345) detained",
                "snippet": "Offshore supply ship JUAN PABLO II was detained."}]
        self.assertEqual(web_risk_hits(src, ["JUAN PABLO II"], imo="9831189"), [])
        self.assertEqual(len(web_risk_hits(src, ["JUAN PABLO II"], imo="9252345")), 1)

    def test_beacons_mistyped_as_fishing_vessels_are_dropped_by_name(self):
        self.assertTrue(pipeline.looks_like_gear("BUOY 064-732    12V6"))
        self.assertTrue(pipeline.looks_like_gear("BOYA 5 ROLTON 91%"))
        self.assertTrue(pipeline.looks_like_gear("HSD-NET-99%"))
        for real in ("CHACAO", "TUNA PESCA", "FONG KUO NO.688", "MARIBO 65", "JIN HUI 18", "NETTUNO", "SYY35-2023-01"):
            self.assertFalse(pipeline.looks_like_gear(real), real)

    def test_area_crossing_the_antimeridian_gets_a_usable_centre(self):
        from poseidon import geo
        g = {"type": "MultiPolygon", "coordinates": [[[[177, 20], [180, 20], [180, 30], [177, 30], [177, 20]]],
                                                     [[[-180, 20], [-161, 20], [-161, 30], [-180, 30], [-180, 20]]]]}
        bbox, lat, lon = geo.bbox_and_center(g)
        self.assertEqual(bbox, [177, 20, 199, 30])
        self.assertEqual((lat, lon), (25.0, -172.0))
        self.assertTrue(geo.point_in_geometry(-170, 25, g))
        self.assertFalse(geo.point_in_geometry(-150, 25, g))


if __name__ == "__main__":
    unittest.main()
