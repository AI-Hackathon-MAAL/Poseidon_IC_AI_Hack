"""Regression checks for the Python report entry point using the published fixture."""
import json
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from app.snapshot_case import generate_report
from poseidon.agent import Case
from poseidon.scoring import score_case


class SnapshotReportTests(unittest.TestCase):
    def setUp(self):
        sample = Path(__file__).resolve().parents[1] / "data" / "poseidon_snapshot.sample.json"
        self.snapshot = json.loads(sample.read_text(encoding="utf-8"))
        self.queued = next(row for row in self.snapshot["cases"] if row["status"] == "queued")

    def test_python_score_and_brief_use_only_exported_evidence(self):
        original = deepcopy(self.queued)
        with patch("socket.socket.connect", side_effect=AssertionError("unexpected network call")):
            row = generate_report(self.snapshot, original["case_id"])
        case = Case(row["mpa_id"], row["mpa_name"], row["vessel_id"], row["vessel_name"],
                    row["flag"], row["mmsi"], row["vessel_type"], row["events"], row["evidence"])
        score = score_case(case)
        self.assertEqual((row["risk_score"], row["reasons"]), (score["risk_score"], score["reasons"]))
        self.assertIn(f"{score['risk_score']}/100", row["brief_markdown"])
        self.assertEqual(row["brief_written_by"], "template")
        self.assertTrue(row["synthetic"])
        self.assertEqual(row["status"], "incomplete")
        self.assertNotIn("web_search_vessel", row["evidence"])
        self.assertNotIn("vessel_history", row["evidence"])
        self.assertEqual(row["llm_decisions"], 0)
        self.assertEqual(row["policy_decisions"], len(row["steps"]))
        self.assertEqual(self.queued, original)

    def test_completed_brief_is_preserved_and_stale_observations_are_rejected(self):
        row = next(c for c in self.snapshot["cases"] if c["status"] == "complete")
        self.assertEqual(generate_report(self.snapshot, row["case_id"]), row)
        self.queued["event_ids"] = []
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            generate_report(self.snapshot, self.queued["case_id"])

    def test_published_gap_endpoint_flags_take_precedence_over_display_boundary(self):
        row = next(c for c in self.snapshot["cases"] if any(e["event_type"] == "gap" for e in c["events"]))
        row.update(status="queued", brief_markdown="stale draft", evidence={})
        area = next(m for m in self.snapshot["mpas"] if m["mpa_id"] == row["mpa_id"])
        area["boundary"] = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
        gap = next(e for e in row["events"] if e["event_type"] == "gap")
        gap["details"].update(gap_start_inside=True, gap_end_inside=False)
        report = generate_report(self.snapshot, row["case_id"])
        checked = next(e for e in report["events"] if e["event_id"] == gap["event_id"])
        self.assertIs(checked["details"]["gap_start_inside"], True)
        self.assertIs(checked["details"]["gap_end_inside"], False)
        self.assertEqual(report["report_origin"], "snapshot-python")


if __name__ == "__main__":
    unittest.main()
