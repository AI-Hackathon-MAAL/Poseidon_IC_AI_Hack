"""Deterministic risk scoring. The language model never sets a number.

Every point comes from GFW events or vessel records
and carries a plain-language reason, so a judge or investigator can audit the score.
"""
from __future__ import annotations

from .gfw import parse_time

def _num(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def longest_gap_hours(events):
    gaps = [_num(e.get("duration_hours"), -1) for e in events if e.get("event_type") == "gap"]
    gaps = [g for g in gaps if g >= 0]
    return max(gaps) if gaps else None


def tracking_status(events, gap_hours=12):
    """Review signal for the monitor view. Absence of gaps is never proof of compliance."""
    gaps = [e for e in events if e.get("event_type") == "gap"]
    if any(e.get("duration_hours") is not None and _num(e["duration_hours"]) >= gap_hours for e in gaps):
        return "flagged_for_review"
    if any(e.get("duration_hours") is None for e in gaps):
        return "insufficient_data"
    return "no_qualifying_gap_found"


def score_case(case, gap_hours=12):
    """Returns {risk_score, risk_level, confidence, tracking_status, reasons:[{text, points, basis}]}."""
    ev, events = case.evidence, case.events
    reasons = []

    def add(points, text, basis):
        reasons.append({"text": text, "points": points, "basis": basis})

    gaps = [e for e in events if e["event_type"] == "gap"]
    fishing = [e for e in events if e["event_type"] == "fishing"]
    where = case.mpa_name or "the protected area"

    longest = longest_gap_hours(events)
    if gaps:
        add(30, f"Global Fishing Watch recorded {len(gaps)} AIS reporting gap(s) associated with {where}.", "events")
        if longest is not None and longest >= 72:
            add(15, f"Longest dark period lasted {longest:.0f} hours (3+ days).", "events")
        elif longest is not None and longest >= 24:
            add(10, f"Longest dark period lasted {longest:.0f} hours.", "events")
    if fishing:
        add(20, f"{len(fishing)} apparent fishing event(s) inside {where}.", "events")
        if any((e.get("details") or {}).get("in_no_take_mpa") for e in fishing):
            add(10, "Global Fishing Watch places apparent fishing inside a no-take zone.", "events")
        if any((e.get("details") or {}).get("potential_risk") for e in fishing):
            add(5, "Global Fishing Watch marks a fishing event as potential risk (no matching public authorization).", "events")

    # gap followed by fishing: from the MPA's own events, or from the wider activity check
    followed = False
    for g in gaps:
        g_end = parse_time(g.get("end_time"))
        for f in fishing:
            f_start = parse_time(f.get("start_time"))
            if g_end and f_start and 0 <= (f_start - g_end).total_seconds() <= 48 * 3600:
                followed = True
    activity = ev.get("activity_around_event") or {}
    first_after = activity.get("first_after") or {}
    if not followed and activity.get("anchor_type") == "gap" and first_after.get("type") == "fishing" \
            and _num(first_after.get("hours_after"), 999) <= 48:
        followed = True
    if followed:
        add(15, "Apparent fishing began within 48 hours of the vessel reappearing after a dark period.", "events")

    moved = _num(activity.get("gap_distance_km"))
    if moved >= 50:
        add(5, f"The recorded positions at either end of the gap are about {moved:.0f} km apart.", "events")

    types = {e["event_type"] for e in events} | {a.get("type") for a in activity.get("after") or []}
    if "encounter" in types:
        add(10, "Global Fishing Watch recorded an apparent vessel encounter.", "events")
    elif "loitering" in types:
        add(10, "Global Fishing Watch recorded apparent loitering.", "events")

    identity = ev.get("resolve_identity")
    if identity is not None:
        if not identity.get("found") or not (identity.get("names") or case.vessel_name):
            add(10, "The vessel could not be identified in Global Fishing Watch registries or AIS records.", "gfw_vessel")
        if len(identity.get("flags") or []) > 1:
            add(5, f"Has used more than one flag: {', '.join(identity['flags'])}.", "gfw_vessel")
        if len(identity.get("names") or []) > 1:
            add(5, f"Has used more than one name: {', '.join(identity['names'][:4])}.", "gfw_vessel")

    history = (ev.get("vessel_history") or {}).get("counts") or {}
    if _num(history.get("gap")) >= 3:
        add(5, f"Repeat pattern: {int(history['gap'])} tracking gaps in the previous 12 months.", "gfw_history")

    score = min(100, sum(r["points"] for r in reasons))
    level = "high" if score >= 70 else "medium" if score >= 40 else "low"

    core = ["resolve_identity", "activity_around_event", "vessel_history", "web_search_vessel"]
    done = sum(1 for k in core if k in ev and not ev[k].get("partial_errors"))
    confidence = "high" if done == 4 else "medium" if done >= 2 else "low"
    if confidence == "high" and identity is not None and not identity.get("found"):
        confidence = "medium"
    return {"risk_score": score, "risk_level": level, "confidence": confidence,
            "tracking_status": tracking_status(events, gap_hours), "reasons": reasons}
