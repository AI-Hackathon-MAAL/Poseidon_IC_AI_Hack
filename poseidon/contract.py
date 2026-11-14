"""The data contract between the Poseidon backend and the front end.

TABLES is the single source of truth for the Delta tables (docs/backend.md explains each field).
Types: string, int, double, boolean, timestamp, json (a JSON document stored as a string).
build_snapshot() turns table rows into the one JSON file the front end can load directly.
"""
from __future__ import annotations

import json
import re

ATTRIBUTION = "Vessel activity data (c) Global Fishing Watch (apparent activity; non-commercial use)."

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
        ("run_id", "string"), ("mode", "string"), ("data_source", "string"), ("window_start", "string"), ("window_end", "string"),
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
    "mpa_status": {"key": ["mpa_id"], "columns": [
        ("mpa_id", "string"), ("mpa_name", "string"), ("n_cases", "int"), ("n_high", "int"), ("n_medium", "int"),
        ("n_low", "int"), ("n_incomplete", "int"), ("n_queued", "int"), ("n_flagged_for_review", "int"),
        ("n_unidentified", "int"), ("top_risk_score", "int"), ("n_events", "int"), ("n_gap", "int"),
        ("n_fishing", "int"), ("n_encounter", "int"), ("n_loitering", "int"), ("latest_event_at", "string"),
        ("last_investigated_at", "string")]},
}


def storage_namespace(catalog, base_schema, data_source):
    """Reserve the _sample suffix so the real and synthetic writers cannot share a destination."""
    if not all(re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", name) for name in (catalog, base_schema)):
        raise ValueError("Use catalog and schema identifiers containing letters, numbers and underscores.")
    if base_schema.lower().endswith("_sample"):
        raise ValueError("Use the base schema name. The sample run adds the _sample suffix automatically.")
    if data_source not in ("gfw", "sample"):
        raise ValueError("Choose a data source of gfw or sample.")
    return catalog, base_schema + "_sample" if data_source == "sample" else base_schema


def runs_for_source(runs, data_source):
    """Legacy rows have no recorded source. Exclude them when publishing a source-specific export."""
    return [r for r in runs if r.get("data_source") == data_source]


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
    columns = json_columns(table)
    # An enriched Delta cases table can include a rights-cleared photograph.
    # Keep it reader-only so routine notebook writes preserve the enrichment.
    if table == "cases" and "vessel_photo" in out:
        columns.append("vessel_photo")
    for c in columns:
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


def build_snapshot(runs, cases, events, steps, news, mpa_context, generated_at):
    """Everything the front end needs in one JSON document (see docs/backend.md)."""
    runs = sorted((parse_row("runs", r) for r in runs), key=lambda r: _s(r.get("finished_at")) or "", reverse=True)
    run_sources = {r.get("data_source") for r in runs}
    data_source = "unknown"
    if run_sources == {"sample"}:
        data_source = "sample"
    elif run_sources == {"gfw"}:
        data_source = "gfw"
    attribution = {
        "sample": "Synthetic demonstration. Vessels, events and web sources are invented.",
        "gfw": ATTRIBUTION,
        "unknown": "The source of one or more runs was not recorded or differs across runs.",
    }[data_source]
    cases = [parse_row("cases", c) for c in cases]
    events = [parse_row("events", e) for e in events]
    context = {str(m["mpa_id"]): parse_row("mpa_context", m) for m in mpa_context}
    events_by_case, steps_by_case = {}, {}
    for e in sorted(events, key=lambda e: _s(e.get("start_time")) or ""):
        events_by_case.setdefault(e.get("case_id"), []).append(e)
    for s in sorted(steps, key=lambda s: (_s(s.get("at")) or "", int(s.get("step_no") or 0))):
        steps_by_case.setdefault((s.get("case_id"), s.get("run_id")), []).append(dict(s))
    out_cases = []
    for c in sorted(cases, key=lambda c: (-(int(c.get("risk_score") or 0)), _s(c.get("case_id")))):
        c = dict(c)
        case_events = events_by_case.get(c["case_id"], [])
        if isinstance(c.get("event_ids"), list):
            selected_ids = set(c["event_ids"])
            case_events = [e for e in case_events if e.get("event_id") in selected_ids]
        c["events"] = case_events
        c["steps"] = steps_by_case.get((c["case_id"], c.get("run_id")), [])
        out_cases.append(c)
    mpas = []
    for s in mpa_status_rows(cases, events):
        ctx = context.get(s["mpa_id"], {})
        mpas.append({**s, "news_summary": ctx.get("news_summary"), "rules_summary": ctx.get("rules_summary"),
                     "rules_sources": ctx.get("rules_sources") or []})
    return {
        "product": "Poseidon", "generated_at": generated_at, "attribution": attribution,
        "data_source": data_source, "synthetic": None if data_source == "unknown" else data_source == "sample",
        "disclaimer": "Every case is a lead for review, not proof of illegal fishing.",
        "latest_run": runs[0] if runs else None,
        "runs": [{k: r.get(k) for k in ("run_id", "mode", "data_source", "window_start", "window_end", "finished_at",
                                        "n_events", "n_cases", "n_investigated")} for r in runs[:20]],
        "mpas": sorted(mpas, key=lambda m: -m["top_risk_score"]),
        "cases": out_cases,
        "news": sorted((dict(n) for n in news), key=lambda n: _s(n.get("fetched_at")) or "", reverse=True),
    }
