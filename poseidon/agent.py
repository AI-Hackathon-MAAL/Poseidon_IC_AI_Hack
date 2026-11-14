"""Poseidon's investigator: an agent that decides its own next check.

Objective (bounded): monitor the selected marine protected areas, investigate vessels with
tracking gaps or apparent fishing inside them, and produce evidence-backed leads with
explicit uncertainty.

For each case the agent loops: look at what it knows -> choose ONE tool -> run it -> look
again. The language model chooses among the permitted tools and may stop when it judges
the evidence sufficient. Code (never the model) runs the tools, computes durations and
scores, and decides whether the investigation counts as complete.

If the model is unavailable or answers badly, a rule-based policy makes the same decision,
so a run never stalls. Every step records who decided ("llm" or "policy") and why.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .gfw import EVENT_DATASETS, GFWError, day, flatten_event, parse_time, summarize_identity
from .scoring import longest_gap_hours, score_case, web_risk_hits
from .search import SearchError

OBJECTIVE = ("Monitor the selected marine protected areas, investigate vessels with tracking gaps or apparent "
             "fishing inside them, and produce evidence-backed leads with explicit uncertainty.")

TOOL_HELP = {
    "resolve_identity": "Look up the vessel in Global Fishing Watch registry and AIS identity records "
                        "(names, flags, IMO, owner). Tries an MMSI search if the direct lookup is empty.",
    "activity_around_event": "Fetch what the vessel did in the 72 hours before and after its most significant event "
                             "(longest tracking gap, else first fishing event): fishing, encounters, loitering, port visits.",
    "vessel_history": "Count the vessel's tracking gaps, fishing events, encounters, loitering and port visits "
                      "over the previous 12 months to see whether this is a repeat pattern.",
    "encounter_partner": "Identify the other vessel it met at sea (only when an encounter was recorded).",
    "web_search_vessel": "Search the live web for reports about this vessel: illegal fishing, sanctions, detentions. "
                         "Needs a name, IMO or MMSI.",
    "web_search_owner": "Search the live web for reports about the vessel's registered owner (only once an owner is known).",
    "mpa_rules": "Search the live web for the fishing rules of this protected area.",
    "regional_news": "Recent news about illegal fishing in or near this protected area.",
    "finish": "Stop investigating and write the brief. Choose this when the evidence is sufficient or nothing useful remains.",
}
POLICY_REASONS = {
    "resolve_identity": "Establish who the vessel is before judging its behaviour.",
    "activity_around_event": "Check what the vessel did just before and after the event.",
    "vessel_history": "Check whether this behaviour is a repeat pattern.",
    "encounter_partner": "An encounter was recorded, so identify the other vessel.",
    "web_search_vessel": "Check public reports about the vessel.",
    "web_search_owner": "An owner is known, so check public reports about the owner.",
    "mpa_rules": "Confirm what the protected area's fishing rules are.",
    "regional_news": "Add recent regional context.",
}
MAX_ATTEMPTS = 2


class ToolError(RuntimeError):
    """A check could not be completed. The agent records it and adapts."""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Case:
    mpa_id: str
    mpa_name: str
    vessel_id: str
    vessel_name: str | None
    flag: str | None
    mmsi: str | None
    vessel_type: str | None
    events: list
    evidence: dict = field(default_factory=dict)
    steps: list = field(default_factory=list)
    attempts: dict = field(default_factory=dict)
    failures: list = field(default_factory=list)

    @property
    def case_id(self):
        return f"{self.mpa_id}:{self.vessel_id}"

    def identity(self):
        return self.evidence.get("resolve_identity") or {}

    def best_name(self):
        names = self.identity().get("names") or []
        return self.vessel_name or (names[0] if names else None)

    def display_name(self):
        return self.best_name() or (f"Unidentified vessel (MMSI {self.mmsi})" if self.mmsi else "Unidentified vessel")

    def anchor_event(self):
        """The event most worth explaining: longest gap, else first fishing event, else first event."""
        gaps = [e for e in self.events if e["event_type"] == "gap"]
        if gaps:
            return max(gaps, key=lambda e: float(e.get("duration_hours") or 0))
        fishing = [e for e in self.events if e["event_type"] == "fishing"]
        return (fishing or self.events)[0]

    def partner_vessel_id(self):
        for e in self.events:
            pid = (e.get("details") or {}).get("partner_vessel_id")
            if pid:
                return pid
        return None


@dataclass
class Context:
    gfw: object
    window_start: str
    window_end: str
    mode: str = "history"
    search: object = None          # SearchClient or None
    llm: object = None             # callable(system, user) -> str, or None
    gap_hours: float = 12
    max_steps: int = 8
    cache: dict = field(default_factory=dict)
    llm_errors: int = 0
    llm_disabled: bool = False
    llm_last_error: str | None = None


# --------------------------------------------------------------------------- tools

def _web(ctx, query, **kwargs):
    if ctx.search is None:
        raise ToolError("Web search is not configured (no Linkup key).")
    try:
        return ctx.search.search(query, **kwargs)
    except SearchError as e:
        raise ToolError(str(e)) from e


def tool_resolve_identity(ctx, case):
    record, errors, via = None, [], None
    try:
        record, via = ctx.gfw.vessel(case.vessel_id), "vessel_id"
    except GFWError as e:
        errors.append(str(e))
    summary = summarize_identity(record) if record else {}
    possible = []
    if not summary.get("names") and case.mmsi:   # adapt: direct lookup was empty, try the MMSI
        try:
            entries = ctx.gfw.search_vessels(case.mmsi)
            confirmed = next((e for e in entries if any((s or {}).get("id") == case.vessel_id
                                                        for s in e.get("selfReportedInfo") or [])), None)
            if confirmed:
                found = summarize_identity(confirmed)
                if found.get("names") or found.get("imo"):
                    summary, via = found, "mmsi_search"
            else:
                for e in entries[:3]:
                    possible += summarize_identity(e).get("names")[:1]
        except GFWError as e:
            errors.append(str(e))
    if record is None and not summary:
        raise ToolError("; ".join(errors) or "No identity record returned.")
    found = bool(summary.get("names") or summary.get("imo") or summary.get("registry_records"))
    evidence = {"found": found, "via": via if found else None, "possible_matches_by_mmsi": possible, **summary}
    if found:
        bits = [f"name {summary['names'][0]}" if summary.get("names") else None,
                f"flag {', '.join(summary['flags'])}" if summary.get("flags") else None,
                f"IMO {summary['imo']}" if summary.get("imo") else None,
                f"owner {summary['owners'][0]}" if summary.get("owners") else None]
        text = "Identity resolved: " + ", ".join(b for b in bits if b) + "."
    else:
        text = "No name, IMO or registry record found for this vessel." + (
            f" MMSI search returned unconfirmed candidates: {', '.join(possible)}." if possible else "")
    return evidence, text


def tool_activity_around_event(ctx, case):
    anchor = case.anchor_event()
    a_start = parse_time(anchor.get("start_time"))
    a_end = parse_time(anchor.get("end_time")) or a_start
    if a_start is None:
        raise ToolError("The event has no start time.")
    start, end = day(a_start, -3), day(a_end, 4)
    rows, errors = [], []
    for kind in EVENT_DATASETS:
        try:
            found, _ = ctx.gfw.events(kind, start, end, vessel_id=case.vessel_id, max_pages=3)
            rows += [flatten_event(r, kind) for r in found]
        except GFWError as e:
            errors.append(f"{kind}: {e}")
    if len(errors) == len(EVENT_DATASETS):
        raise ToolError("Could not fetch vessel activity: " + errors[0])
    before, during, after = [], [], []
    for e in rows:
        if e["event_id"] == anchor["event_id"] and e["event_type"] == anchor["event_type"]:
            continue
        s = parse_time(e["start_time"])
        en = parse_time(e["end_time"]) or s
        if s is None:
            continue
        d = e.get("details") or {}
        item = {"type": e["event_type"], "start": e["start_time"], "end": e["end_time"],
                "duration_hours": e["duration_hours"], "inside_this_mpa": str(case.mpa_id) in (d.get("mpa_ids") or []),
                "port_name": d.get("port_name"), "partner_vessel_name": d.get("partner_vessel_name")}
        item = {k: v for k, v in item.items() if v not in (None, False)}
        if en <= a_start:
            item["hours_before"] = round((a_start - en).total_seconds() / 3600, 1)
            before.append(item)
        elif s >= a_end:
            item["hours_after"] = round((s - a_end).total_seconds() / 3600, 1)
            after.append(item)
        else:
            during.append(item)
    before.sort(key=lambda i: i["hours_before"])
    after.sort(key=lambda i: i["hours_after"])
    ad = anchor.get("details") or {}
    evidence = {"anchor_event_id": anchor["event_id"], "anchor_type": anchor["event_type"],
                "anchor_start": anchor.get("start_time"), "anchor_end": anchor.get("end_time"),
                "searched_from": start, "searched_to": end,
                "before": before[:8], "during": during[:8], "after": after[:8],
                "first_after": after[0] if after else None,
                "gap_distance_km": ad.get("gap_distance_km"), "gap_implied_speed_knots": ad.get("gap_implied_speed_knots"),
                "partial_errors": errors}
    text = f"{len(before)} event(s) in the 72 h before and {len(after)} after the {anchor['event_type']} event."
    if after:
        text += f" First afterwards: {after[0]['type']} {after[0]['hours_after']} h later."
    return evidence, text


def tool_vessel_history(ctx, case):
    end = ctx.window_end
    start = day(end, -365)
    counts, errors = {}, []
    for kind in EVENT_DATASETS:
        try:
            counts[kind] = ctx.gfw.count_events(kind, start, end, case.vessel_id)
        except GFWError as e:
            errors.append(f"{kind}: {e}")
    if not counts:
        raise ToolError("Could not fetch vessel history: " + errors[0])
    text = "Previous 12 months: " + ", ".join(f"{n} {k.replace('_', ' ')}" for k, n in counts.items()) + "."
    return {"period_start": start, "period_end": end, "counts": counts, "partial_errors": errors}, text


def tool_encounter_partner(ctx, case):
    pid = case.partner_vessel_id()
    if not pid:
        raise ToolError("No encounter partner recorded.")
    try:
        summary = summarize_identity(ctx.gfw.vessel(pid))
    except GFWError as e:
        raise ToolError(str(e)) from e
    name = (summary.get("names") or ["unnamed vessel"])[0]
    kinds = ", ".join(summary.get("ship_types") or summary.get("gear_types") or []) or "type unknown"
    return {"vessel_id": pid, **summary}, f"Encounter partner: {name} ({kinds})."


def _vessel_identifiers(case):
    ident = case.identity()
    return case.best_name(), ident.get("imo"), case.mmsi, (ident.get("flags") or [case.flag] or [None])[0]


def tool_web_search_vessel(ctx, case):
    name, imo, mmsi, flag = _vessel_identifiers(case)
    if not (name or imo or mmsi):
        raise ToolError("No name, IMO or MMSI to search for. Resolve the identity first.")
    who = f'the fishing vessel "{name}"' if name else "the vessel"
    tags = ", ".join(t for t in (f"IMO {imo}" if imo else None, f"MMSI {mmsi}" if mmsi else None,
                                 f"flag {flag}" if flag else None) if t)
    query = (f"Has {who}{' (' + tags + ')' if tags else ''} been reported for illegal, unreported or unregulated "
             f"fishing, sanctions, detention or fines? Cite the reports.")
    res = _web(ctx, query)
    hits = web_risk_hits(res["sources"], [name, imo, mmsi])
    text = f"{len(res['sources'])} web source(s) found; {len(hits)} mention this vessel together with illegal fishing or sanctions."
    return {**res, "risk_hits": hits}, text


def tool_web_search_owner(ctx, case):
    owners = case.identity().get("owners") or []
    if not owners:
        raise ToolError("No registered owner is known.")
    query = (f'Has the fishing company "{owners[0]}" been linked to illegal, unreported or unregulated fishing, '
             f"sanctions or forced labour? Cite the reports.")
    res = _web(ctx, query)
    hits = web_risk_hits(res["sources"], [owners[0]])
    return {**res, "owner": owners[0], "risk_hits": hits}, \
        f"Owner {owners[0]}: {len(res['sources'])} source(s), {len(hits)} with illegal-fishing or sanctions mentions."


def mpa_rules(ctx, mpa_id, mpa_name):
    key = ("mpa_rules", str(mpa_id))
    if key not in ctx.cache:
        ctx.cache[key] = _web(ctx, f"What are the fishing rules in {mpa_name}? Is industrial or commercial fishing "
                                   f"prohibited, and are there no-take zones? Cite official sources.")
    return ctx.cache[key]


def mpa_news(ctx, mpa_id, mpa_name):
    """Recent news for one protected area. Shared by the agent tool and the news feed."""
    key = ("mpa_news", str(mpa_id))
    if key not in ctx.cache:
        from_date = day(ctx.window_end, -90) if ctx.mode == "live" else ctx.window_start
        to_date = None if ctx.mode == "live" else day(ctx.window_end, 30)
        ctx.cache[key] = _web(ctx, f"Latest news on illegal fishing, fishing fleets or vessel detentions in or near {mpa_name}.",
                              from_date=from_date, to_date=to_date)
    return ctx.cache[key]


def tool_mpa_rules(ctx, case):
    res = mpa_rules(ctx, case.mpa_id, case.mpa_name)
    return res, f"Protected-area rules: {len(res['sources'])} source(s) retrieved."


def tool_regional_news(ctx, case):
    res = mpa_news(ctx, case.mpa_id, case.mpa_name)
    return res, f"Regional news since {res.get('from_date') or 'any date'}: {len(res['sources'])} source(s)."


TOOLS = {
    "resolve_identity": tool_resolve_identity,
    "activity_around_event": tool_activity_around_event,
    "vessel_history": tool_vessel_history,
    "encounter_partner": tool_encounter_partner,
    "web_search_vessel": tool_web_search_vessel,
    "web_search_owner": tool_web_search_owner,
    "mpa_rules": tool_mpa_rules,
    "regional_news": tool_regional_news,
}


# --------------------------------------------------------------------------- deciding

def available_tools(ctx, case):
    """Tools the agent may choose right now. Availability depends on what it has learned."""
    out = []
    for name in TOOLS:
        if name in case.evidence or case.attempts.get(name, 0) >= MAX_ATTEMPTS:
            continue
        if name.startswith("web_") or name in ("mpa_rules", "regional_news"):
            if ctx.search is None:
                continue
        if name == "encounter_partner" and not case.partner_vessel_id():
            continue
        if name == "web_search_owner" and not case.identity().get("owners"):
            continue
        out.append(name)
    return out + ["finish"]


def is_transient(error):
    """Outages and rate limits are worth retrying; 'not found' and missing inputs are not."""
    e = str(error).lower()
    return any(t in e for t in ("http 5", "http 429", "429", "network error", "failed after", "timed out", "timeout"))


def policy_choice(case, available):
    """Rule-based planner used when the model is unavailable or gives an unusable answer."""
    order = ["activity_around_event", "resolve_identity", "vessel_history", "web_search_vessel",
             "web_search_owner", "encounter_partner", "mpa_rules", "regional_news"]
    if not case.vessel_name:
        order.remove("resolve_identity")
        order.insert(0, "resolve_identity")
    for name in order:
        if name in available and case.attempts.get(name, 0) == 0:
            reason = POLICY_REASONS[name]
            if name == "resolve_identity" and not case.vessel_name:
                reason = "The event data has no vessel name, so resolve its identity first."
            return name, reason
    for failure in case.failures:   # adapt: a temporary outage deserves one more try before giving up
        if failure["tool"] in available and is_transient(failure["error"]):
            return failure["tool"], "This check failed earlier with a temporary error, so try it once more."
    return "finish", "No further useful checks remain."


def ask_llm(ctx, system, user):
    """Calls the model; after 3 consecutive failures stops trying for the rest of the run."""
    if ctx.llm is None or ctx.llm_disabled:
        return None
    try:
        out = ctx.llm(system, user)
        ctx.llm_errors = 0
        return out
    except Exception as e:  # rate limits, endpoint errors: fall back to the policy
        ctx.llm_errors += 1
        ctx.llm_last_error = str(e)[:300]
        if ctx.llm_errors >= 3:
            ctx.llm_disabled = True
        return None


def parse_json_object(text):
    if not text:
        return None
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        obj = json.loads(text[a:b + 1])
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


PLANNER_SYSTEM = (
    "You are Poseidon, an autonomous investigator of possible illegal fishing in marine protected areas. "
    f"Objective: {OBJECTIVE} "
    "You are given one case, the evidence gathered so far, failed attempts and the tools you may use now. "
    "Decide the single most useful next check. Prefer checks that resolve the biggest unknown. "
    "If a check failed, choose an alternative rather than repeating it blindly. "
    "Choose \"finish\" when the evidence is sufficient for a brief or nothing useful remains. "
    "Reply with ONLY a JSON object: {\"tool\": \"<tool name>\", \"reason\": \"<one short sentence>\"}.")


def planner_state(ctx, case, available, steps_left):
    return {
        "case": {"vessel_name": case.vessel_name, "flag": case.flag, "mmsi": case.mmsi,
                 "protected_area": case.mpa_name,
                 "events": [{"type": e["event_type"], "start": e.get("start_time"), "end": e.get("end_time"),
                             "duration_hours": e.get("duration_hours")} for e in case.events[:12]]},
        "evidence_so_far": {s["tool"]: s["result"] for s in case.steps if s["ok"] and s["tool"] != "finish"},
        "failed_attempts": case.failures,
        "available_tools": {t: TOOL_HELP[t] for t in available},
        "steps_left": steps_left,
    }


def choose_next(ctx, case, available, steps_left):
    """Returns (tool, reason, decided_by)."""
    raw = ask_llm(ctx, PLANNER_SYSTEM, json.dumps(planner_state(ctx, case, available, steps_left), default=str))
    choice = parse_json_object(raw)
    if choice and choice.get("tool") in available:
        return choice["tool"], str(choice.get("reason") or "")[:300], "llm"
    tool, reason = policy_choice(case, available)
    return tool, reason, "policy"


def investigate(ctx, case):
    """Runs the decide -> act -> observe loop for one case. Mutates and returns the case."""
    def record(tool, by, reason, ok, result, started):
        case.steps.append({"step_no": len(case.steps) + 1, "at": now_iso(), "tool": tool, "decided_by": by,
                           "reason": reason, "ok": ok, "result": result,
                           "duration_ms": int((time.time() - started) * 1000)})

    for used in range(ctx.max_steps):
        available = available_tools(ctx, case)
        started = time.time()
        if available == ["finish"]:
            record("finish", "policy", "No further checks are available.", True, "Investigation ended.", started)
            return case
        tool, reason, by = choose_next(ctx, case, available, ctx.max_steps - used)
        if tool == "finish" and not case.evidence:
            alt, alt_reason = policy_choice(case, available)
            if alt != "finish":   # guard: never write a brief on zero evidence while checks remain
                tool, by, reason = alt, "policy", "Finish rejected because no evidence was gathered yet. " + alt_reason
        if tool == "finish":
            record("finish", by, reason, True, "Investigation ended.", started)
            return case
        case.attempts[tool] = case.attempts.get(tool, 0) + 1
        try:
            evidence, text = TOOLS[tool](ctx, case)
            case.evidence[tool] = evidence
            record(tool, by, reason, True, text, started)
        except ToolError as e:
            case.failures.append({"tool": tool, "error": str(e)[:300]})
            record(tool, by, reason, False, str(e)[:300], started)
        except Exception as e:  # an unexpected bug in one check must not kill the whole run
            case.failures.append({"tool": tool, "error": f"unexpected error: {e}"[:300]})
            record(tool, by, reason, False, f"Unexpected error: {e}"[:300], started)
    record("finish", "policy", "Step budget reached.", True, "Investigation stopped at the step limit.", time.time())
    return case


# --------------------------------------------------------------------------- assessing

def collect_sources(case):
    """Numbered, de-duplicated citations across every web check."""
    out, seen = [], set()
    for kind in ("web_search_vessel", "web_search_owner", "mpa_rules", "regional_news"):
        for s in ((case.evidence.get(kind) or {}).get("sources") or [])[:4]:
            if s["url"] not in seen:
                seen.add(s["url"])
                out.append({"n": len(out) + 1, "kind": kind, **s})
    return out


def unknowns_for(ctx, case):
    out, ev = [], case.evidence
    failed = {f["tool"]: f["error"] for f in case.failures}
    ident = ev.get("resolve_identity")
    if ident is None:
        out.append("Vessel identity was not established" + (f" ({failed['resolve_identity']})" if "resolve_identity" in failed else "."))
    elif not ident.get("found"):
        out.append("The vessel could not be identified in Global Fishing Watch records, so its owner and flag history are unknown.")
    if "activity_around_event" not in ev:
        out.append("Activity before and after the event could not be retrieved.")
    if "vessel_history" not in ev:
        out.append("12-month activity history was not retrieved.")
    if ctx.search is None:
        out.append("Web search was not configured, so no public reports were checked.")
    elif "web_search_vessel" not in ev:
        out.append("Public reports about the vessel were not checked" +
                   (f" ({failed['web_search_vessel']})" if "web_search_vessel" in failed else "."))
    for key in ("activity_around_event", "vessel_history"):
        if (ev.get(key) or {}).get("partial_errors"):
            out.append(f"Some Global Fishing Watch requests failed during {key.replace('_', ' ')}; counts may be incomplete.")
    if ctx.mode == "live":
        out.append("Global Fishing Watch publishes events with a delay, so the most recent days may be incomplete.")
    return out


def status_for(ctx, case):
    essential = ["resolve_identity", "activity_around_event"]
    name, imo, mmsi, _ = _vessel_identifiers(case)
    if ctx.search is not None and (name or imo or mmsi):
        essential.append("web_search_vessel")
    return "complete" if all(k in case.evidence for k in essential) else "incomplete"


def headline(case, score):
    name, where = case.display_name(), case.mpa_name or "the protected area"
    longest = longest_gap_hours(case.events)
    followed = any("within 48 hours" in r["text"] for r in score["reasons"])
    fishing = sum(e["event_type"] == "fishing" for e in case.events)
    if longest is not None:
        return f"{name} went dark for {longest:.0f} h in {where}" + ("; apparent fishing followed." if followed else ".")
    if fishing:
        return f"{name}: {fishing} apparent fishing event(s) inside {where}."
    kinds = ", ".join(sorted({e["event_type"] for e in case.events}))
    return f"{name}: {kinds} event(s) in {where}."


def assess(ctx, case):
    """Everything derived from evidence by code: score, status, unknowns, sources, headline."""
    score = score_case(case, ctx.gap_hours)
    return {**score, "status": status_for(ctx, case), "unknowns": unknowns_for(ctx, case),
            "sources": collect_sources(case), "headline": headline(case, score)}
