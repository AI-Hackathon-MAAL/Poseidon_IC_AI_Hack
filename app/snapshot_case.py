"""Run Poseidon's original Python policy, scorer and brief writer on a publication.

The command reads UTF-8 JSON {snapshot, caseId} on stdin and emits one case row.
All tools read from memory. No live services, model, credentials or writes are used.
"""

import json
import sys
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from poseidon import pipeline
from poseidon.agent import Context, assess, investigate
from poseidon.brief import write_brief
from poseidon.geo import point_in_geometry
from poseidon.gfw import GFWError, day, parse_time
from poseidon.search import SearchError


def sources(rows):
    """Keep the original citations, including their titles and source URLs."""
    return [
        dict(row, title=row.get("title") or row["url"], snippet=row.get("snippet") or "")
        for row in rows or [] if isinstance(row, dict) and row.get("url")
    ]


class PublishedEvidence:
    """Read only observations and results with matching vessel, scope and dates."""

    def __init__(self, cases, target):
        self.events_by_id = {}
        self.history = []
        self.queries = {}
        self.identity = None
        self.identity_source = None
        for row in cases:
            if row.get("vessel_id") != target["vessel_id"]:
                continue
            for event in row.get("events") or []:
                if event.get("vessel_id") == target["vessel_id"] and event.get("event_id"):
                    self.events_by_id.setdefault((event.get("event_type"), event["event_id"]), event)
            # Identity and vessel queries are not area-specific. Require the same
            # as-of date. Annual counts must also match the exact requested period.
            if row.get("window_end") != target.get("window_end") or row.get("report_origin") == "snapshot-python":
                continue
            evidence = row.get("evidence") or {}
            if evidence.get("resolve_identity"):
                self.identity = evidence["resolve_identity"]
                self.identity_source = {"case_id": row["case_id"], "run_id": row.get("run_id")}
            if evidence.get("vessel_history"):
                self.history.append(evidence["vessel_history"])
            for tool in ("web_search_vessel", "web_search_owner"):
                result = evidence.get(tool) or {}
                if result.get("query"):
                    self.queries[result["query"]] = result

    def vessel(self, vessel_id):
        # The snapshot stores processed identity lookups, not raw registry
        # responses. Matching published lookups are attached to Case directly.
        raise GFWError("No registry lookup for this vessel is saved in the snapshot.")

    def search_vessels(self, mmsi):
        raise GFWError("No MMSI search results are saved in the snapshot.")

    def count_events(self, kind, start, end, vessel_id):
        for history in self.history:
            if history.get("period_start") == start and history.get("period_end") == end:
                value = (history.get("counts") or {}).get(kind)
                if value is not None:
                    return value
        raise GFWError("No full-period count is saved for this vessel.")

    def events(self, kind, start, end, vessel_id, max_pages):
        # Only fields consumed by the original activity tool are reconstructed.
        # Association with an MPA does not imply a vessel was inside during a gap.
        found = []
        for (event_type, event_id), event in self.events_by_id.items():
            if event_type != kind or event["vessel_id"] != vessel_id:
                continue
            start_at = parse_time(event.get("start_time"))
            end_at = parse_time(event.get("end_time")) or start_at
            if not start_at or day(end_at) < start or day(start_at) >= end:
                continue
            details = event.get("details") or {}
            found.append({
                "id": event_id, "start": event["start_time"], "end": event.get("end_time"),
                "regions": {"mpa": details.get("mpa_ids") or []},
                "encounter": {"vessel": {"name": details.get("partner_vessel_name")}},
                "portVisit": {"intermediateAnchorage": {"name": details.get("port_name")}},
            })
        return found, False  # An area-limited export is never global coverage.

    def search(self, query, **kwargs):
        saved = self.queries.get(query)
        if not saved:
            raise SearchError("No result for this query is saved in the snapshot.")
        return {**saved, "sources": sources(saved.get("sources"))}


def area_cache(snapshot, area):
    area_id = str(area["mpa_id"])
    cache = {}
    rules = sources(area.get("rules_sources"))
    if rules:
        cache["mpa_rules", area_id] = {"sources": rules, "answer": area.get("rules_summary"), "provider": "snapshot"}
    news = [row for row in snapshot.get("news") or [] if str(row.get("mpa_id")) == area_id]
    if news:
        cache["mpa_news", area_id] = {"sources": sources(news), "answer": area.get("news_summary"), "provider": "snapshot"}
    return cache


def generate_report(snapshot, case_id):
    matches = [row for row in snapshot["cases"] if row.get("case_id") == case_id]
    if len(matches) != 1:
        raise ValueError("The selected case is missing or ambiguous in the snapshot.")
    record = matches[0]
    brief = record.get("brief_markdown")
    if record.get("status") != "queued" and isinstance(brief, str) and brief.strip():
        return record

    area_id = str(record.get("mpa_id"))
    area = next((row for row in snapshot["mpas"] if str(row.get("mpa_id")) == area_id), None)
    if area is None or case_id != f"{area_id}:{record.get('vessel_id')}":
        raise ValueError("The case does not match a published vessel and protected area.")
    ids = set(record.get("event_ids") or [])
    events = [deepcopy(e) for e in record.get("events") or [] if e.get("event_id") in ids
              and e.get("case_id") == case_id and str(e.get("mpa_id")) == area_id
              and e.get("vessel_id") == record["vessel_id"]]
    cases = pipeline.build_cases(events)
    if len(cases) != 1 or pipeline.fingerprint(cases[0]) != record.get("fingerprint"):
        raise ValueError("The observations do not match the published case fingerprint.")
    case = cases[0]
    if record.get("vessel_identified") and not case.vessel_name:
        case.vessel_name = record.get("vessel_name")
    case.mmsi = case.mmsi or record.get("mmsi")
    case.flag = case.flag or record.get("flag")
    case.vessel_type = case.vessel_type or record.get("vessel_type")
    for event in case.events:
        if area.get("boundary") and event["event_type"] == "gap":
            details = event.get("details") or {}
            for key, lon, lat in (("gap_start_inside", "lon", "lat"), ("gap_end_inside", "end_lon", "end_lat")):
                if not isinstance(details.get(key), bool):
                    details[key] = point_in_geometry(event.get(lon), event.get(lat), area["boundary"])
            event["details"] = details

    archive = PublishedEvidence(snapshot["cases"], record)
    if archive.identity:
        case.evidence["resolve_identity"] = deepcopy(archive.identity)
    ctx = Context(gfw=archive, search=archive, window_start=record["window_start"], window_end=record["window_end"],
                  mode=record.get("mode") or "history", cache=area_cache(snapshot, area))
    investigate(ctx, case)
    assessment = assess(ctx, case)
    assessment["unknowns"].append("Only evidence in the published snapshot was checked. Activity outside its coverage is unknown.")
    brief, writer = write_brief(ctx, case, assessment)
    run_id = "snapshot-" + uuid4().hex[:12]
    updated = pipeline._case_row(ctx, case, assessment, brief, writer, record.get("change"),
                                 {"risk_score": record.get("risk_score")}, record["fingerprint"], run_id)
    for field in ("imo", "callsign", "owner"):
        if updated[field] is None:
            updated[field] = record.get(field)
    steps = [dict(step, case_id=case_id, run_id=run_id, evidence_origin="snapshot") for step in case.steps]
    return {**record, **updated, "events": events, "steps": steps, "report_origin": "snapshot-python",
            "reused_evidence": {"resolve_identity": archive.identity_source} if archive.identity_source else {},
            "source_run_id": record.get("run_id"), "synthetic": bool(snapshot.get("synthetic") or record.get("synthetic"))}


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read())
        result = generate_report(request["snapshot"], request["caseId"])
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    except (ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
