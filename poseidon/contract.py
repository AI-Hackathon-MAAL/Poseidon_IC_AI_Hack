"""The data contract between the Poseidon backend and the front end.

TABLES is the single source of truth for the Delta tables (docs/backend.md explains each field).
Types: string, int, double, boolean, timestamp, json (a JSON document stored as a string).
build_snapshot() turns table rows into the one JSON file the front end can load directly.
"""
from __future__ import annotations

import json

ATTRIBUTION = ("Vessel activity data (c) Global Fishing Watch (apparent activity; non-commercial use). Protected-area outlines: "
               "UNEP-WCMC and IUCN, Protected Planet (WDPA). Web context via Linkup.")

TABLES = {
    "events": {"key": ["event_id", "event_type"], "columns": [
        ("event_id", "string"), ("event_type", "string"), ("mpa_id", "string"), ("mpa_name", "string"),
        ("case_id", "string"), ("vessel_id", "string"), ("vessel_name", "string"), ("mmsi", "string"),
        ("flag", "string"), ("vessel_type", "string"), ("start_time", "timestamp"), ("end_time", "timestamp"),
        ("duration_hours", "double"), ("lat", "double"), ("lon", "double"), ("end_lat", "double"),
        ("end_lon", "double"), ("details", "json"), ("also_in_mpas", "json"), ("mode", "string"),
        ("run_id", "string"), ("fetched_at", "timestamp")]},
    "cases": {"key": ["case_id"], "columns": [
        ("case_id", "string"), ("mpa_id", "string"), ("mpa_name", "string"), ("vessel_id", "string"),
        ("vessel_name", "string"), ("vessel_identified", "boolean"), ("flag", "string"), ("mmsi", "string"),
        ("imo", "string"), ("callsign", "string"), ("vessel_type", "string"), ("owner", "string"),
        ("risk_score", "int"), ("risk_level", "string"), ("confidence", "string"), ("status", "string"),
        ("tracking_status", "string"), ("headline", "string"), ("reasons", "json"), ("unknowns", "json"),
        ("sources", "json"), ("evidence", "json"), ("event_ids", "json"), ("event_types", "string"),
        ("n_events", "int"), ("first_event_at", "timestamp"), ("last_event_at", "timestamp"),
        ("longest_gap_hours", "double"), ("lat", "double"), ("lon", "double"), ("brief_markdown", "string"),
        ("brief_written_by", "string"), ("change", "string"), ("previous_risk_score", "int"),
        ("fingerprint", "string"), ("n_steps", "int"), ("llm_decisions", "int"), ("policy_decisions", "int"),
        ("mode", "string"), ("window_start", "string"), ("window_end", "string"), ("run_id", "string"),
        ("investigated_at", "timestamp")]},
    "agent_steps": {"key": ["run_id", "case_id", "step_no"], "columns": [
        ("run_id", "string"), ("case_id", "string"), ("step_no", "int"), ("at", "timestamp"), ("tool", "string"),
        ("decided_by", "string"), ("reason", "string"), ("ok", "boolean"), ("result", "string"),
        ("duration_ms", "int")]},
    "runs": {"key": ["run_id"], "columns": [
        ("run_id", "string"), ("mode", "string"), ("window_start", "string"), ("window_end", "string"),
        ("mpa_ids", "json"), ("mpa_names", "json"), ("started_at", "timestamp"), ("finished_at", "timestamp"),
        ("n_events", "int"), ("n_cases", "int"), ("n_investigated", "int"), ("n_skipped_unchanged", "int"),
        ("n_queued", "int"), ("n_incomplete", "int"), ("llm_decisions", "int"), ("policy_decisions", "int"),
        ("llm_endpoint", "string"), ("search_provider", "string"), ("gfw_calls", "int"), ("search_calls", "int"),
        ("triage", "json"), ("notes", "json"), ("objective", "string")]},
    "news": {"key": ["news_id"], "columns": [
        ("news_id", "string"), ("mpa_id", "string"), ("mpa_name", "string"), ("title", "string"), ("url", "string"),
        ("snippet", "string"), ("query", "string"), ("from_date", "string"), ("provider", "string"),
        ("fetched_at", "timestamp"), ("run_id", "string")]},
    "mpa_context": {"key": ["mpa_id"], "columns": [
        ("mpa_id", "string"), ("mpa_name", "string"), ("news_summary", "string"), ("news_sources", "json"),
        ("rules_summary", "string"), ("rules_sources", "json"), ("updated_at", "timestamp"), ("run_id", "string")]},
    "mpa_boundaries": {"key": ["mpa_id"], "columns": [
        ("mpa_id", "string"), ("mpa_name", "string"), ("geometry", "json"), ("bbox", "json"),
        ("center_lat", "double"), ("center_lon", "double"), ("source", "string"), ("error", "string"),
        ("fetched_at", "timestamp")]},
    "global_news": {"key": ["news_id"], "columns": [
        ("news_id", "string"), ("title", "string"), ("url", "string"), ("snippet", "string"), ("query", "string"),
        ("place_type", "string"), ("place_name", "string"), ("mpa_id", "string"), ("lat", "double"),
        ("lon", "double"), ("from_date", "string"), ("provider", "string"), ("fetched_at", "timestamp"),
        ("run_id", "string")]},
    "mpa_status": {"key": ["mpa_id"], "columns": [
        ("mpa_id", "string"), ("mpa_name", "string"), ("n_cases", "int"), ("n_high", "int"), ("n_medium", "int"),
        ("n_low", "int"), ("n_incomplete", "int"), ("n_queued", "int"), ("n_flagged_for_review", "int"),
        ("n_unidentified", "int"), ("top_risk_score", "int"), ("n_events", "int"), ("n_gap", "int"),
        ("n_fishing", "int"), ("n_encounter", "int"), ("n_loitering", "int"), ("latest_event_at", "string"),
        ("last_investigated_at", "string")]},
}


def json_columns(table):
    return [c for c, t in TABLES[table]["columns"] if t == "json"]


def cell_to_string(value, kind):
    """Value -> the string written to Spark before casting to its column type."""
    if value is None:
        return None
    if kind == "json":
        return value if isinstance(value, str) else json.dumps(value, default=str, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def to_table_rows(table, rows):
    """Row dicts -> tuples of strings in column order, de-duplicated on the table key (last wins)."""
    spec = TABLES[table]
    by_key = {}
    for r in rows:
        by_key[tuple(str(r.get(k)) for k in spec["key"])] = tuple(cell_to_string(r.get(c), t) for c, t in spec["columns"])
    return list(by_key.values())


def parse_row(table, row):
    """Table row (JSON columns as strings) -> plain dict with JSON columns parsed."""
    out = dict(row)
    for c in json_columns(table):
        if isinstance(out.get(c), str):
            try:
                out[c] = json.loads(out[c])
            except ValueError:
                pass
    return out


def _s(value):
    return None if value is None else str(value)


def mpa_status_rows(cases, events):
    """Per-area dashboard numbers, derived from the cases and events tables."""
    out = {}

    def slot(mpa_id, name):
        return out.setdefault(str(mpa_id), {
            "mpa_id": str(mpa_id), "mpa_name": name, "n_cases": 0, "n_high": 0, "n_medium": 0, "n_low": 0,
            "n_incomplete": 0, "n_queued": 0, "n_flagged_for_review": 0, "n_unidentified": 0, "top_risk_score": 0,
            "n_events": 0, "n_gap": 0, "n_fishing": 0, "n_encounter": 0, "n_loitering": 0,
            "latest_event_at": None, "last_investigated_at": None})

    for c in cases:
        s = slot(c["mpa_id"], c.get("mpa_name"))
        s["n_cases"] += 1
        if c.get("risk_level") in ("high", "medium", "low"):
            s[f"n_{c['risk_level']}"] += 1
        s["n_incomplete"] += c.get("status") == "incomplete"
        s["n_queued"] += c.get("status") == "queued"
        s["n_flagged_for_review"] += c.get("tracking_status") == "flagged_for_review"
        s["n_unidentified"] += str(c.get("vessel_identified")).lower() == "false"
        s["top_risk_score"] = max(s["top_risk_score"], int(c.get("risk_score") or 0))
        if c.get("status") != "queued":
            s["last_investigated_at"] = max(filter(None, [s["last_investigated_at"], _s(c.get("investigated_at"))]), default=None)
    for e in events:
        s = slot(e["mpa_id"], e.get("mpa_name"))
        s["n_events"] += 1
        if f"n_{e['event_type']}" in s:
            s[f"n_{e['event_type']}"] += 1
        s["latest_event_at"] = max(filter(None, [s["latest_event_at"], _s(e.get("end_time") or e.get("start_time"))]), default=None)
    return list(out.values())


def build_snapshot(runs, cases, events, steps, news, mpa_context, generated_at, boundaries=(), global_news=(),
                   data_source=None):
    """Everything the front end needs in one JSON document (see docs/backend.md).

    data_source is "gfw" for real Global Fishing Watch data or "sample" for synthetic data.
    The front ends use it to label the publication."""
    runs = sorted((parse_row("runs", r) for r in runs), key=lambda r: _s(r.get("finished_at")) or "", reverse=True)
    cases = [parse_row("cases", c) for c in cases]
    events = [parse_row("events", e) for e in events]
    for e in events:   # bulky fields the front end does not use
        if isinstance(e.get("details"), dict):
            e["details"] = {k: v for k, v in e["details"].items() if k not in ("mpa_ids", "eez")}
        for k in ("fetched_at", "also_in_mpas"):
            e.pop(k, None)
    context = {str(m["mpa_id"]): parse_row("mpa_context", m) for m in mpa_context}
    events_by_case, steps_by_case = {}, {}
    for e in sorted(events, key=lambda e: _s(e.get("start_time")) or ""):
        events_by_case.setdefault(e.get("case_id"), []).append(e)
    for s in sorted(steps, key=lambda s: (_s(s.get("at")) or "", int(s.get("step_no") or 0))):
        steps_by_case.setdefault((s.get("case_id"), s.get("run_id")), []).append(dict(s))
    out_cases = []
    for c in sorted(cases, key=lambda c: (-(int(c.get("risk_score") or 0)), _s(c.get("case_id")))):
        c = dict(c)
        c["events"] = events_by_case.get(c["case_id"], [])
        c["steps"] = steps_by_case.get((c["case_id"], c.get("run_id")), [])
        out_cases.append(c)
    shapes = {str(b["mpa_id"]): parse_row("mpa_boundaries", b) for b in boundaries}
    status = {s["mpa_id"]: s for s in mpa_status_rows(cases, events)}
    for mpa_id, b in shapes.items():   # areas with an outline but no events yet still appear on the globe
        if mpa_id not in status:
            status[mpa_id] = {
                **{k: 0 for k in ("n_cases", "n_high", "n_medium", "n_low", "n_incomplete", "n_queued",
                                  "n_flagged_for_review", "n_unidentified", "top_risk_score", "n_events",
                                  "n_gap", "n_fishing", "n_encounter", "n_loitering")},
                "mpa_id": mpa_id, "mpa_name": b.get("mpa_name"), "latest_event_at": None, "last_investigated_at": None}
    mpas = []
    for s in status.values():
        ctx, b = context.get(s["mpa_id"], {}), shapes.get(s["mpa_id"], {})
        lat, lon, bbox = b.get("center_lat"), b.get("center_lon"), b.get("bbox")
        if isinstance(b.get("geometry"), dict):   # recompute so older rows get the antimeridian-safe values
            from .geo import bbox_and_center
            bbox, lat, lon = bbox_and_center(b["geometry"])
        if lat is None:   # no outline: centre on the area's cases
            pts = [(float(c["lat"]), float(c["lon"])) for c in cases
                   if str(c.get("mpa_id")) == s["mpa_id"] and c.get("lat") is not None and c.get("lon") is not None]
            if pts:
                lat, lon = round(sum(p[0] for p in pts) / len(pts), 4), round(sum(p[1] for p in pts) / len(pts), 4)
        mpas.append({**s, "news_summary": ctx.get("news_summary"), "rules_summary": ctx.get("rules_summary"),
                     "rules_sources": ctx.get("rules_sources") or [],
                     "boundary": b.get("geometry"), "bbox": bbox, "boundary_source": b.get("source"),
                     "center_lat": lat, "center_lon": lon})
    provenance = {} if data_source is None else {"data_source": data_source, "synthetic": data_source == "sample"}
    return {
        "product": "Poseidon", "generated_at": generated_at, "attribution": ATTRIBUTION, **provenance,
        "disclaimer": "Every case is a lead for review, not proof of illegal fishing.",
        "latest_run": runs[0] if runs else None,
        "runs": [{k: r.get(k) for k in ("run_id", "mode", "window_start", "window_end", "finished_at",
                                        "n_events", "n_cases", "n_investigated")} for r in runs[:20]],
        "mpas": sorted(mpas, key=lambda m: -m["top_risk_score"]),
        "cases": out_cases,
        "news": sorted((dict(n) for n in news), key=lambda n: _s(n.get("fetched_at")) or "", reverse=True),
        "global_news": sorted((dict(n) for n in global_news), key=lambda n: _s(n.get("fetched_at")) or "", reverse=True),
    }
