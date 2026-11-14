import unittest

from poseidon.gfw import summarize_identity
from poseidon.contract import build_snapshot
from poseidon.pipeline import build_cases, fingerprint, triage


class ProviderUpdates(unittest.TestCase):
    def test_map_uses_the_events_underlying_the_displayed_brief(self):
        case = {"case_id": "a:v", "mpa_id": "a", "event_ids": ["current"]}
        events = [{"case_id": "a:v", "mpa_id": "a", "event_id": eid, "event_type": "gap"}
                  for eid in ("archived", "current")]
        snapshot = build_snapshot([], [case], events, [], [], [], "now")
        self.assertEqual([e["event_id"] for e in snapshot["cases"][0]["events"]], ["current"])
        self.assertEqual(snapshot["mpas"][0]["n_events"], 2)

    def test_identity_without_registry_entry_works_on_detail_and_search(self):
        ais = {"id": "abc", "shipname": "Fixture vessel", "ssvid": "123456789"}
        for identity in (ais, [ais]):
            with self.subTest(identity=identity):
                vessel = summarize_identity({"selfReportedInfo": identity})
                self.assertEqual(vessel["names"], ["Fixture vessel"])
                self.assertEqual(vessel["ais_identities"], 1)

    def test_corrected_endpoint_under_same_event_id_reopens_a_completed_case(self):
        event = {"event_type": "gap", "event_id": "gap-one", "mpa_id": "area", "mpa_name": "Area",
                 "vessel_id": "v1", "duration_hours": 100, "end_lon": None}
        case = build_cases([event])[0]
        memory = {case.case_id: {"fingerprint": fingerprint(case), "status": "complete", "risk_score": 50}}
        self.assertEqual(triage([case], memory)[0]["decision"], "skip_unchanged")
        updated = build_cases([{**event, "end_lon": -106.2}])[0]
        decision = triage([updated], memory)[0]
        self.assertEqual((decision["decision"], decision["change"]), ("investigate", "updated"))
