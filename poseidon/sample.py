"""Synthetic stand-ins for Global Fishing Watch, Linkup and the language model.

Used by the tests, by scripts/make_sample_snapshot.py and by the notebook's data_source=sample
option, so the whole agent can run without keys. Every vessel, owner and URL here is invented
(names start with SAMPLE, links point at example.org).
"""
from __future__ import annotations

import json

from .gfw import GFWError, parse_time

SAMPLE_MPAS = [{"id": "sample-1", "label": "Sample Marine Reserve (synthetic)"},
               {"id": "sample-2", "label": "Sample Seamount Sanctuary (synthetic)"}]


def _event(eid, start, end, vessel, **extra):
    return {"id": eid, "start": start, "end": end, "vessel": vessel, **extra}


V_DARK = {"id": "sample-vessel-dark", "name": None, "ssvid": "900000001", "flag": None, "type": "FISHING"}
V_B = {"id": "sample-vessel-b", "name": "SAMPLE VESSEL B", "ssvid": "900000002", "flag": "XXX", "type": "FISHING"}
V_C = {"id": "sample-vessel-c", "name": "SAMPLE VESSEL C", "ssvid": "900000003", "flag": "YYY", "type": "FISHING"}
V_D = {"id": "sample-vessel-d", "name": "SAMPLE VESSEL D", "ssvid": "900000004", "flag": "XXX", "type": "FISHING"}
V_CARRIER = {"id": "sample-carrier-e", "name": "SAMPLE CARRIER E", "ssvid": "900000005", "flag": "ZZZ", "type": "CARRIER"}

REGION_EVENTS = {
    ("sample-1", "gap"): [
        _event("sg-1", "2026-10-02T04:00:00Z", "2026-10-06T08:00:00Z", V_DARK,
               position={"lat": -0.62, "lon": -91.4},
               gap={"offPosition": {"lat": -0.62, "lon": -91.4}, "onPosition": {"lat": -1.35, "lon": -90.2},
                    "distanceKm": 158.0, "impliedSpeedKnots": 0.9}),
        _event("sg-2", "2026-10-11T18:00:00Z", "2026-10-12T07:00:00Z", V_B,
               position={"lat": -0.2, "lon": -90.9},
               gap={"offPosition": {"lat": -0.2, "lon": -90.9}, "onPosition": {"lat": -0.25, "lon": -90.8},
                    "distanceKm": 12.0, "impliedSpeedKnots": 0.5}),
    ],
    ("sample-1", "fishing"): [
        _event("sf-1", "2026-10-20T05:00:00Z", "2026-10-20T09:15:00Z", V_C, position={"lat": -0.9, "lon": -89.8},
               regions={"mpa": ["sample-1"], "mpaNoTake": ["sample-1"]}, fishing={"potentialRisk": True}),
    ],
    ("sample-2", "encounter"): [
        _event("se-1", "2026-10-21T00:00:00Z", "2026-10-21T05:00:00Z", V_D, position={"lat": -3.1, "lon": -88.0},
               encounter={"vessel": V_CARRIER, "type": "fishing-carrier"}),
    ],
    ("sample-2", "gap"): [
        _event("sg-3", "2026-10-19T02:00:00Z", "2026-10-19T20:00:00Z", V_D, position={"lat": -3.0, "lon": -88.1},
               gap={"offPosition": {"lat": -3.0, "lon": -88.1}, "onPosition": {"lat": -3.1, "lon": -88.0},
                    "distanceKm": 20.0}),
    ],
}

# What each vessel did around its main event (returned by vessel-level queries)
VESSEL_EVENTS = {
    ("sample-vessel-dark", "fishing"): [
        _event("sf-9", "2026-10-06T14:00:00Z", "2026-10-06T21:00:00Z", V_DARK, position={"lat": -1.36, "lon": -90.1},
               regions={"mpa": ["sample-1"]})],
    ("sample-vessel-dark", "port_visit"): [
        _event("sp-1", "2026-10-08T10:00:00Z", "2026-10-09T02:00:00Z", V_DARK,
               port_visit={"intermediateAnchorage": {"name": "SAMPLE PORT", "flag": "XXX"}})],
    ("sample-vessel-d", "loitering"): [
        _event("sl-1", "2026-10-20T08:00:00Z", "2026-10-20T15:00:00Z", V_D)],
}

IDENTITIES = {
    "sample-vessel-dark": {
        "registryInfo": [{"shipname": "SAMPLE DARK STAR", "flag": "XXX", "imo": "9000001", "callsign": "SMPL1",
                          "ssvid": "900000001", "geartypes": ["squid_jigger"]}],
        "registryOwners": [{"name": "SAMPLE OCEAN FISHERIES CO", "flag": "XXX"}],
        "selfReportedInfo": [{"id": "sample-vessel-dark", "shipname": "SAMPLE DARK STAR", "flag": "XXX", "ssvid": "900000001"},
                             {"id": "sample-vessel-dark-old", "shipname": "SAMPLE NIGHT STAR", "flag": "QQQ", "ssvid": "900000009"}],
        "combinedSourcesInfo": [{"geartypes": [{"name": "SQUID_JIGGER"}], "shiptypes": [{"name": "FISHING"}]}]},
    "sample-vessel-b": {"registryInfo": [], "registryOwners": [],
                        "selfReportedInfo": [{"id": "sample-vessel-b", "shipname": "SAMPLE VESSEL B", "flag": "XXX", "ssvid": "900000002"}]},
    "sample-vessel-d": {"registryInfo": [{"shipname": "SAMPLE VESSEL D", "flag": "XXX", "imo": "9000004"}], "registryOwners": [],
                        "selfReportedInfo": [{"id": "sample-vessel-d", "shipname": "SAMPLE VESSEL D", "flag": "XXX"}]},
    "sample-carrier-e": {"registryInfo": [{"shipname": "SAMPLE CARRIER E", "flag": "ZZZ"}], "registryOwners": [],
                         "selfReportedInfo": [], "combinedSourcesInfo": [{"shiptypes": [{"name": "CARRIER"}]}]},
}
HISTORY = {"sample-vessel-dark": {"gap": 5, "fishing": 41, "encounter": 2, "loitering": 3, "port_visit": 6},
           "sample-vessel-b": {"gap": 1, "fishing": 12, "encounter": 0, "loitering": 0, "port_visit": 9},
           "sample-vessel-d": {"gap": 2, "fishing": 20, "encounter": 3, "loitering": 4, "port_visit": 5}}


def _overlaps(event, start, end):
    s, e = parse_time(event["start"]), parse_time(event["end"])
    return e >= parse_time(start) and s <= parse_time(end)


class SampleGFW:
    """Same methods as GFWClient, answering from the synthetic data above.
    The identity lookup for SAMPLE VESSEL C fails on purpose, to exercise the agent's adaptation."""

    def __init__(self, extra_region_events=None):
        self.calls = 0
        self.region_events = {k: list(v) for k, v in REGION_EVENTS.items()}
        for key, events in (extra_region_events or {}).items():
            self.region_events.setdefault(key, []).extend(events)

    def mpas(self):
        self.calls += 1
        return SAMPLE_MPAS

    def events(self, kind, start, end, mpa_id=None, vessel_id=None, page_size=200, max_pages=50):
        self.calls += 1
        if vessel_id:
            pool = list(VESSEL_EVENTS.get((vessel_id, kind), []))
            for (_, k), events in self.region_events.items():
                if k == kind:
                    pool += [e for e in events if e["vessel"]["id"] == vessel_id]
        else:
            pool = self.region_events.get((str(mpa_id), kind), [])
        return [e for e in pool if _overlaps(e, start, end)], True

    def count_events(self, kind, start, end, vessel_id):
        self.calls += 1
        if vessel_id not in HISTORY:
            raise GFWError("GFW POST /events -> HTTP 503 (synthetic outage)")
        return HISTORY[vessel_id].get(kind, 0)

    def vessel(self, vessel_id):
        self.calls += 1
        if vessel_id not in IDENTITIES:
            raise GFWError(f"GFW GET /vessels/{vessel_id} -> HTTP 404: not found (synthetic)")
        return IDENTITIES[vessel_id]

    def search_vessels(self, query, limit=5):
        self.calls += 1
        return []


class SampleSearch:
    """Stands in for Linkup. Returns invented, clearly-labelled sources."""
    provider = "linkup"

    def __init__(self):
        self.calls = 0
        self.queries = []

    def search(self, query, from_date=None, to_date=None, max_results=6, depth="standard"):
        self.calls += 1
        self.queries.append(query)
        base = {"query": query, "provider": self.provider, "from_date": from_date, "to_date": to_date}
        if "SAMPLE DARK STAR" in query:
            return {**base, "answer": "Synthetic example: a regional fisheries body listed SAMPLE DARK STAR for unreported fishing in 2024.",
                    "sources": [{"title": "Synthetic: SAMPLE DARK STAR listed for IUU fishing", "url": "https://example.org/synthetic/iuu-list",
                                 "snippet": "Invented example. SAMPLE DARK STAR was listed for illegal, unreported fishing."},
                                {"title": "Synthetic: fleet overview", "url": "https://example.org/synthetic/fleet",
                                 "snippet": "Invented example. General article on distant-water squid fleets."}]}
        if "SAMPLE OCEAN FISHERIES" in query:
            return {**base, "answer": "Synthetic example: no public reports found about this company.",
                    "sources": [{"title": "Synthetic: company registry entry", "url": "https://example.org/synthetic/company",
                                 "snippet": "Invented example. SAMPLE OCEAN FISHERIES CO registry entry."}]}
        if "fishing rules" in query:
            return {**base, "answer": "Synthetic example: industrial fishing is prohibited throughout the reserve.",
                    "sources": [{"title": "Synthetic: reserve management plan", "url": "https://example.org/synthetic/rules",
                                 "snippet": "Invented example. Industrial fishing is prohibited inside the reserve."}]}
        if "Latest news" in query:
            return {**base, "answer": "Synthetic example: patrols reported a large squid fleet near the reserve boundary this month.",
                    "sources": [{"title": "Synthetic: fleet gathers at reserve boundary", "url": "https://example.org/synthetic/news-1",
                                 "snippet": "Invented example. Patrol aircraft counted vessels along the boundary."},
                                {"title": "Synthetic: navy boards vessel near reserve", "url": "https://example.org/synthetic/news-2",
                                 "snippet": "Invented example. A vessel was boarded for inspection."}]}
        return {**base, "answer": "Synthetic example: no relevant public reports found.", "sources": []}


class SampleLLM:
    """A scripted 'model' so tests can exercise the model-driven path deterministically.

    As planner it prefers identity -> activity -> web -> history, then finishes once it has
    three pieces of evidence. As writer it returns a short Markdown brief built from the facts.
    """

    def __init__(self, order=("resolve_identity", "activity_around_event", "web_search_vessel", "web_search_owner",
                              "vessel_history", "mpa_rules"), finish_after=5):
        self.order, self.finish_after, self.calls = order, finish_after, 0

    def __call__(self, system, user):
        self.calls += 1
        data = json.loads(user)
        if "available_tools" in data:
            done = len(data["evidence_so_far"])
            if done >= self.finish_after:
                return json.dumps({"tool": "finish", "reason": "Identity, behaviour and public record are covered."})
            failed = {f["tool"] for f in data["failed_attempts"]}
            for tool in self.order:
                if tool in data["available_tools"] and tool not in failed:
                    return 'Sure! {"tool": "%s", "reason": "Biggest remaining unknown."}' % tool
            return json.dumps({"tool": "finish", "reason": "Nothing useful remains."})
        cites = " ".join(f"[{s['n']}]" for s in data["sources"][:2])
        return (f"# {data['vessel_name']} — {data['risk_level']} risk lead\n"
                f"**Summary:** Risk score {data['risk_score']}/100 in {data['protected_area']}. "
                f"Investigation {data['investigation_status']}.\n\n## What happened\n"
                + "\n".join(f"- {e['start_time']}: {e['event_type']}" for e in data["events"])
                + "\n\n## Why it matters\n" + "\n".join(f"- {r}" for r in data["reasons"])
                + f"\n\n## What public sources say\nSee {cites or 'no sources'}.\n\n## What we don't know\n"
                + "\n".join(f"- {u}" for u in data["unknowns"]) + "\n\n## Suggested next steps\n- Request the vessel track.")
