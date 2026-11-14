"""One run of Poseidon: fetch -> triage (with memory) -> investigate -> rows for the tables.

History mode and live mode share all of this; only the time window differs.
"""
from __future__ import annotations

import hashlib
import json
import unicodedata
import uuid

from .agent import Case, OBJECTIVE, assess, investigate, mpa_news, now_iso, ToolError
from .brief import write_brief
from .gfw import GFWError, REGION_EVENT_TYPES, flatten_event
from .scoring import longest_gap_hours, score_case


def fold(text):
    """Lower-case and strip accents so 'galapagos' matches 'Galápagos'."""
    return "".join(c for c in unicodedata.normalize("NFKD", str(text or "")) if not unicodedata.combining(c)).lower()


def select_mpas(all_mpas, search="", ids=""):
    """Explicit ids win; otherwise every protected area whose name contains the search text."""
    wanted = [x.strip() for x in str(ids or "").split(",") if x.strip()]
    rows = [{"mpa_id": str(m.get("id")), "mpa_name": m.get("label") or m.get("name") or str(m.get("id"))} for m in all_mpas]
    if wanted:
        by_id = {r["mpa_id"]: r for r in rows}
        missing = [w for w in wanted if w not in by_id]
        if missing:
            raise ValueError(f"Unknown protected-area id(s): {', '.join(missing)}")
        return [by_id[w] for w in wanted]
    needle = fold(search).strip()
    if not needle:
        raise ValueError("Give mpa_ids or mpa_search")
    return [r for r in rows if needle in fold(r["mpa_name"])]


def collect_events(ctx, mpas):
    """All region events for the window. An event inside overlapping areas is kept once,
    under the first selected area, with the others listed in also_in_mpas."""
    rows, index, notes, failures = [], {}, [], 0
    for mpa in mpas:
        for kind in REGION_EVENT_TYPES:
            try:
                found, complete = ctx.gfw.events(kind, ctx.window_start, ctx.window_end, mpa_id=mpa["mpa_id"])
            except GFWError as e:
                failures += 1
                notes.append(f"Could not fetch {kind} events for {mpa['mpa_name']}: {e}")
                continue
            if not complete:
                notes.append(f"{kind} events for {mpa['mpa_name']} were cut off at the page limit; shorten the window.")
            for raw in found:
                row = flatten_event(raw, kind, mpa["mpa_id"], mpa["mpa_name"])
                key = (row["event_type"], row["event_id"])
                if key in index:
                    index[key]["also_in_mpas"].append(mpa["mpa_id"])
                else:
                    row["also_in_mpas"] = []
                    index[key] = row
                    rows.append(row)
    if mpas and failures == len(mpas) * len(REGION_EVENT_TYPES):
        raise GFWError("Every Global Fishing Watch request failed: " + notes[0])
    return rows, notes


def build_cases(events):
    """One case per vessel per protected area."""
    cases = {}
    for e in events:
        if not e.get("vessel_id"):
            continue
        key = (e["mpa_id"], e["vessel_id"])
        if key not in cases:
            cases[key] = Case(e["mpa_id"], e["mpa_name"], e["vessel_id"], e.get("vessel_name"), e.get("flag"),
                              e.get("mmsi"), e.get("vessel_type"), [])
        c = cases[key]
        c.events.append(e)
        c.vessel_name = c.vessel_name or e.get("vessel_name")
        c.flag = c.flag or e.get("flag")
        c.mmsi = c.mmsi or e.get("mmsi")
    for c in cases.values():
        c.events.sort(key=lambda e: str(e.get("start_time")))
    return list(cases.values())


def fingerprint(case):
    """Reopen a case when a provider corrects evidence under an existing event ID."""
    fields = ("event_type", "event_id", "vessel_id", "vessel_name", "flag", "mmsi", "vessel_type",
              "start_time", "end_time", "duration_hours", "lat", "lon", "end_lat", "end_lon", "details")
    observations = [{key: event.get(key) for key in fields} for event in case.events]
    observations.sort(key=lambda row: (row["event_type"], row["event_id"]))
    encoded = json.dumps(observations, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()[:24]


def priority(case, change):
    types = [e["event_type"] for e in case.events]
    longest = longest_gap_hours(case.events)
    p = 0.0
    if longest is not None:
        p += 30 + min(longest, 120) / 4
    p += 10 * min(types.count("gap"), 3)
    if "fishing" in types:
        p += 20
    if "gap" in types and "fishing" in types:
        p += 15
    if not case.vessel_name:
        p += 10
    if "encounter" in types or "loitering" in types:
        p += 5
    if change in ("new", "updated"):
        p += 10
    return round(p, 1)


def triage(cases, memory=None, max_cases=5, force=False, focus=()):
    """Decide which cases to investigate now. Returns a list of decisions, highest priority first.

    memory: {case_id: {"fingerprint", "status", "risk_score"}} from earlier runs.
    A case already investigated to completion with unchanged evidence is skipped.
    """
    memory = memory or {}
    needles = [fold(f).strip() for f in focus if str(f).strip()]
    decisions = []
    for case in cases:
        fp, mem = fingerprint(case), memory.get(case.case_id)
        focused = any(n in fold(f"{case.vessel_id} {case.vessel_name} {case.mmsi}") for n in needles)
        if mem is None:
            change, reason = "new", "New vessel in this protected area."
        elif mem.get("fingerprint") != fp:
            change, reason = "updated", "The event records changed since the last investigation."
        elif mem.get("status") == "queued":
            change, reason = "new", "Queued in an earlier run and not investigated yet."
        elif mem.get("status") != "complete":
            change, reason = "retry", "The previous investigation was incomplete."
        elif force or focused:
            change, reason = "forced", "Re-investigation requested."
        else:
            decisions.append({"case": case, "decision": "skip_unchanged", "change": "unchanged", "priority": 0.0,
                              "fingerprint": fp, "focused": False,
                              "reason": "Already investigated and no new evidence."})
            continue
        decisions.append({"case": case, "decision": "queued", "change": change, "fingerprint": fp, "focused": focused,
                          "priority": priority(case, change), "reason": reason})
    open_ = sorted([d for d in decisions if d["decision"] == "queued"],
                   key=lambda d: (not d["focused"], -d["priority"]))
    for d in open_[:max(0, int(max_cases))]:
        d["decision"] = "investigate"
    for d in open_[max(0, int(max_cases)):]:
        d["reason"] += " Queued behind higher-priority cases."
    return sorted(decisions, key=lambda d: (d["decision"] != "investigate", not d["focused"], -d["priority"]))


def _case_row(ctx, case, a, brief, written_by, change, mem, fp, run_id):
    ident = case.identity()
    anchor = case.anchor_event()
    return {
        "case_id": case.case_id, "mpa_id": case.mpa_id, "mpa_name": case.mpa_name,
        "vessel_id": case.vessel_id, "vessel_name": case.display_name(),
        "vessel_identified": bool(case.best_name()),
        "flag": case.flag or (ident.get("flags") or [None])[0], "mmsi": case.mmsi,
        "imo": ident.get("imo"), "callsign": ident.get("callsign"),
        "vessel_type": case.vessel_type or (ident.get("ship_types") or ident.get("gear_types") or [None])[0],
        "owner": (ident.get("owners") or [None])[0],
        "risk_score": a["risk_score"], "risk_level": a["risk_level"], "confidence": a["confidence"],
        "status": a["status"], "tracking_status": a["tracking_status"], "headline": a["headline"],
        "reasons": a["reasons"], "unknowns": a["unknowns"], "sources": a["sources"], "evidence": case.evidence,
        "event_ids": [e["event_id"] for e in case.events],
        "event_types": ",".join(sorted({e["event_type"] for e in case.events})),
        "n_events": len(case.events),
        "first_event_at": case.events[0].get("start_time"),
        "last_event_at": max((str(t) for t in (e.get("end_time") or e.get("start_time") for e in case.events) if t),
                             default=None),
        "longest_gap_hours": longest_gap_hours(case.events),
        "lat": anchor.get("lat"), "lon": anchor.get("lon"),
        "brief_markdown": brief, "brief_written_by": written_by,
        "change": change, "previous_risk_score": (mem or {}).get("risk_score"), "fingerprint": fp,
        "n_steps": len(case.steps),
        "llm_decisions": sum(s["decided_by"] == "llm" for s in case.steps),
        "policy_decisions": sum(s["decided_by"] == "policy" for s in case.steps),
        "mode": ctx.mode, "window_start": ctx.window_start, "window_end": ctx.window_end,
        "run_id": run_id, "investigated_at": now_iso(),
    }


def run(ctx, mpas, memory=None, max_cases=5, force=False, focus=(), run_id=None, events=None,
        llm_endpoint=None, log=print):
    """Execute one run. Returns {"run", "events", "cases", "steps", "news", "mpa_context"} as lists of row dicts."""
    run_id = run_id or uuid.uuid4().hex[:12]
    started, memory = now_iso(), memory or {}
    notes = []
    if events is None:
        events, notes = collect_events(ctx, mpas)
    log(f"[fetch] {len(events)} events in {len(mpas)} protected area(s), window {ctx.window_start} to {ctx.window_end}")

    cases = build_cases(events)
    case_of = {(e["mpa_id"], e["vessel_id"]): f"{e['mpa_id']}:{e['vessel_id']}" for e in events if e.get("vessel_id")}
    fetched_at = now_iso()
    event_rows = [{**e, "case_id": case_of.get((e["mpa_id"], e.get("vessel_id"))), "mode": ctx.mode,
                   "run_id": run_id, "fetched_at": fetched_at} for e in events]

    news_rows, context_rows = [], []
    if ctx.search is not None:   # fresh, cited regional context for the news feed
        for mpa in mpas:
            try:
                res = mpa_news(ctx, mpa["mpa_id"], mpa["mpa_name"])
            except ToolError as e:
                notes.append(f"News search failed for {mpa['mpa_name']}: {e}")
                continue
            for s in res["sources"]:
                news_rows.append({"news_id": hashlib.sha1(f"{mpa['mpa_id']}|{s['url']}".encode()).hexdigest()[:16],
                                  "mpa_id": mpa["mpa_id"], "mpa_name": mpa["mpa_name"], "title": s["title"],
                                  "url": s["url"], "snippet": s["snippet"], "query": res["query"],
                                  "from_date": res.get("from_date"), "provider": res["provider"],
                                  "fetched_at": now_iso(), "run_id": run_id})
        log(f"[news] {len(news_rows)} cited news item(s)")

    decisions = triage(cases, memory, max_cases, force, focus)
    counts = {k: sum(d["decision"] == k for d in decisions) for k in ("investigate", "queued", "skip_unchanged")}
    log(f"[triage] {len(cases)} case(s): investigate {counts['investigate']}, queued {counts['queued']}, "
        f"unchanged (remembered) {counts['skip_unchanged']}")

    case_rows, step_rows = [], []
    for d in decisions:
        case, mem = d["case"], memory.get(d["case"].case_id)
        if d["decision"] == "skip_unchanged":
            continue
        if d["decision"] == "queued":
            if mem is not None:
                continue   # keep the existing record until the agent gets to it
            a = {**score_case(case, ctx.gap_hours), "status": "queued", "sources": [],
                 "unknowns": ["Not investigated yet: queued behind higher-priority cases."]}
            a["confidence"] = "low"
            a["headline"] = f"{case.display_name()}: {len(case.events)} event(s) in {case.mpa_name}, awaiting investigation."
            case_rows.append(_case_row(ctx, case, a, None, None, d["change"], mem, d["fingerprint"], run_id))
            continue
        log(f"[case] {case.display_name()} in {case.mpa_name} (priority {d['priority']}, {d['change']})")
        investigate(ctx, case)
        for s in case.steps:
            log(f"    {s['step_no']}. [{s['decided_by']}] {s['tool']}: {s['result']}")
            step_rows.append({"run_id": run_id, "case_id": case.case_id, **s})
        a = assess(ctx, case)
        brief, written_by = write_brief(ctx, case, a)
        case_rows.append(_case_row(ctx, case, a, brief, written_by, d["change"], mem, d["fingerprint"], run_id))
        log(f"    -> risk {a['risk_score']}/100 ({a['risk_level']}), confidence {a['confidence']}, {a['status']}")

    for mpa in mpas:
        news, rules = ctx.cache.get(("mpa_news", mpa["mpa_id"])), ctx.cache.get(("mpa_rules", mpa["mpa_id"]))
        if news or rules:
            context_rows.append({"mpa_id": mpa["mpa_id"], "mpa_name": mpa["mpa_name"],
                                 "news_summary": (news or {}).get("answer"), "news_sources": (news or {}).get("sources") or [],
                                 "rules_summary": (rules or {}).get("answer"), "rules_sources": (rules or {}).get("sources") or [],
                                 "updated_at": now_iso(), "run_id": run_id})

    if ctx.llm is None:
        notes.append("No language model configured: tool choices used the rule-based policy and briefs used the template.")
    elif ctx.llm_disabled:
        notes.append(f"Language model disabled after repeated errors ({ctx.llm_last_error}); the policy took over.")
    if ctx.search is None:
        notes.append("No web search key configured: public reports were not checked.")
    investigated = [r for r in case_rows if r["status"] != "queued"]
    run_row = {
        "run_id": run_id, "mode": ctx.mode, "window_start": ctx.window_start, "window_end": ctx.window_end,
        "mpa_ids": [m["mpa_id"] for m in mpas], "mpa_names": [m["mpa_name"] for m in mpas],
        "started_at": started, "finished_at": now_iso(),
        "n_events": len(events), "n_cases": len(cases), "n_investigated": len(investigated),
        "n_skipped_unchanged": counts["skip_unchanged"], "n_queued": counts["queued"],
        "n_incomplete": sum(r["status"] == "incomplete" for r in investigated),
        "llm_decisions": sum(r["llm_decisions"] for r in investigated),
        "policy_decisions": sum(r["policy_decisions"] for r in investigated),
        "llm_endpoint": llm_endpoint if ctx.llm is not None else None,
        "search_provider": getattr(ctx.search, "provider", None),
        "gfw_calls": getattr(ctx.gfw, "calls", None), "search_calls": getattr(ctx.search, "calls", None),
        "triage": [{"case_id": d["case"].case_id, "vessel": d["case"].display_name(), "decision": d["decision"],
                    "priority": d["priority"], "change": d["change"], "reason": d["reason"]} for d in decisions],
        "notes": notes, "objective": OBJECTIVE,
    }
    return {"run": [run_row], "events": event_rows, "cases": case_rows, "steps": step_rows,
            "news": news_rows, "mpa_context": context_rows}


def memory_from_rows(case_rows):
    """Build the memory dict from rows of the `cases` table."""
    return {r["case_id"]: {"fingerprint": r.get("fingerprint"), "status": r.get("status"),
                           "risk_score": r.get("risk_score")} for r in case_rows}


def to_json(value):
    return json.dumps(value, default=str, ensure_ascii=False)
