"""Deterministic risk scoring. The language model never sets a number.

Every point comes from source data (GFW events, GFW vessel records, cited web sources)
and carries a plain-language reason, so a judge or investigator can audit the score.
"""
from __future__ import annotations

import re
import unicodedata

from .gfw import parse_time

RISK_TERMS = ("iuu", "illegal", "unreported", "unregulated", "sanction", "blacklist", "seized", "detained",
              "arrested", "fined", "poaching", "transshipment", "forced labour", "forced labor")


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


# Vessel-tracking and registry sites list every ship and often carry generic "IUU" text in their
# page furniture. They identify a vessel; they are not reports about it.
VESSEL_DATABASE_DOMAINS = ("maritimeoptima.", "marinetraffic.", "vesselfinder.", "myshiptracking.", "fleetmon.",
                           "magicport.", "balticshipping.", "shipspotting.", "vesseltracker.", "marinevesseltraffic.",
                           "shipfinder.", "globalfishingwatch.org/map", "equasis.", "seasearcher.", "ship-db.",
                           "fishingvessels.", "maritime-database.", "shiplocation.", "vesseltracking.")


def web_risk_hits(sources, identifiers, imo=None):
    """Sources that mention BOTH this vessel/owner and a risk term, excluding vessel databases.
    A hit means a page worth reading, not a finding; the brief must still say what the source states."""
    ids = [str(i).lower() for i in identifiers if i and len(str(i)) >= 4]
    hits = []
    for s in sources or []:
        url = (s.get("url") or "").lower()
        if any(d in url for d in VESSEL_DATABASE_DOMAINS):
            continue
        text = f"{s.get('title', '')} {s.get('snippet', '')}".lower()
        imos = set(re.findall(r"imo[:\s#]*(\d{7})", text))
        if imo and imos and str(imo) not in imos:
            continue   # the page is about a different ship with the same name
        if any(i in text for i in ids) and any(t in text for t in RISK_TERMS):
            hits.append(s.get("url"))
    return hits


def distinct_names(names):
    """Count real name changes, not spelling variants ('CAP. DANNY B' vs 'CAP.DANNY B', 'F/V X' vs 'X')."""
    seen, out = set(), []
    for n in names or []:
        text = "".join(c for c in unicodedata.normalize("NFKD", str(n)) if not unicodedata.combining(c)).upper()
        text = re.sub(r"^(F/V|FV|M/V|MV|F\.V\.|M\.V\.)\s+", "", text.strip())
        key = re.sub(r"[^A-Z0-9]", "", text)
        if key and key not in seen:
            seen.add(key)
            out.append(str(n))
    return out


def gap_location(event):
    """'inside' (lost or regained signal inside the area), 'outside' (both ends outside), or 'unknown'."""
    d = event.get("details") or {}
    a, b = d.get("gap_start_inside"), d.get("gap_end_inside")
    if a is True or b is True:
        return "inside"
    if a is False and b in (False, None):
        return "outside"
    return "unknown"


def score_case(case, gap_hours=12):
    """Returns {risk_score, risk_level, confidence, tracking_status, reasons:[{text, points, basis}], caveats:[...]}."""
    ev, events = case.evidence, case.events
    reasons, caveats = [], []

    def add(points, text, basis):
        reasons.append({"text": text, "points": points, "basis": basis})

    gaps = [e for e in events if e["event_type"] == "gap"]
    fishing = [e for e in events if e["event_type"] == "fishing"]
    where = case.mpa_name or "the protected area"

    # --- tracking gaps: what matters is whether the vessel was demonstrably inside the area
    inside = [g for g in gaps if gap_location(g) == "inside"]
    unknown = [g for g in gaps if gap_location(g) == "unknown"]
    outside = [g for g in gaps if gap_location(g) == "outside"]
    counted = inside or unknown
    if inside:
        add(30, f"Tracking (AIS) was lost or regained inside {where} ({len(inside)} gap(s)).", "events")
    elif unknown:
        add(30, f"Global Fishing Watch associates {len(unknown)} tracking gap(s) with {where}.", "events")
    elif outside:
        add(10, f"{len(outside)} tracking gap(s) may have crossed {where}: the vessel went dark and reappeared "
                f"outside its boundary, so its presence inside is not established.", "events")
        caveats.append(f"The vessel's position during its tracking gap is unknown; both ends of the gap lie outside {where}.")
    longest = longest_gap_hours(counted) if counted else None
    if longest is not None and longest >= 72:
        add(15, f"Longest such dark period lasted {longest:.0f} hours (3+ days).", "events")
    elif longest is not None and longest >= 24:
        add(10, f"Longest such dark period lasted {longest:.0f} hours.", "events")
    if longest is not None and longest >= 336:
        caveats.append(f"A gap of {longest / 24:.0f} days may include time in port or outside satellite coverage.")

    # --- apparent fishing inside the area, graded by GFW's public-authorization check
    if fishing:
        status = {(e.get("details") or {}).get("authorization_status") for e in fishing}
        n = len(fishing)
        if "not_matching_relevant_public_authorization" in status:
            add(20, f"{n} apparent fishing event(s) inside {where}; Global Fishing Watch finds no matching public "
                    f"fishing authorization for at least one.", "events")
        elif status == {"publicly_authorized"}:
            add(5, f"{n} apparent fishing event(s) inside {where}, all with a public fishing authorization "
                   f"(fishing may be permitted there).", "events")
            caveats.append("Whether fishing is permitted here depends on the area's rules; the vessel holds a public authorization.")
        else:
            add(15, f"{n} apparent fishing event(s) inside {where}; authorization status unknown or pending.", "events")
        if any((e.get("details") or {}).get("in_no_take_mpa") for e in fishing):
            add(10, "Global Fishing Watch places apparent fishing inside a no-take zone.", "events")

    # --- gap followed by fishing (from the area's own events, or from the wider activity check)
    followed = False
    for g in counted:
        g_end = parse_time(g.get("end_time"))
        for f in fishing:
            f_start = parse_time(f.get("start_time"))
            if g_end and f_start and 0 <= (f_start - g_end).total_seconds() <= 48 * 3600:
                followed = True
    activity = ev.get("activity_around_event") or {}
    first_after = activity.get("first_after") or {}
    if not followed and counted and activity.get("anchor_type") == "gap" and first_after.get("type") == "fishing" \
            and _num(first_after.get("hours_after"), 999) <= 48:
        followed = True
    if followed:
        add(15, "Apparent fishing began within 48 hours of the vessel reappearing after a dark period.", "events")

    moved = _num(activity.get("gap_distance_km"))
    if moved >= 50 and counted:
        add(5, f"It reappeared about {moved:.0f} km from where tracking was lost.", "events")

    kinds = {e["event_type"] for e in events} | {a.get("type") for a in activity.get("after") or []}
    if "encounter" in kinds:
        add(10, "An encounter with another vessel at sea was recorded, a possible catch transfer.", "events")
    elif "loitering" in kinds:
        add(5, "Loitered at sea (slow drifting, which can accompany a transfer but is also routine).", "events")

    identity = ev.get("resolve_identity")
    if identity is not None:
        if not identity.get("found") or not (identity.get("names") or case.vessel_name):
            add(10, "The vessel could not be identified in Global Fishing Watch registries or AIS records.", "gfw_vessel")
        if len(identity.get("flags") or []) > 1:
            add(5, f"Has used more than one flag: {', '.join(identity['flags'])}.", "gfw_vessel")
        names = distinct_names(identity.get("names"))
        if len(names) > 1:
            add(5, f"Has used more than one name: {', '.join(names[:4])}.", "gfw_vessel")

    history = (ev.get("vessel_history") or {}).get("counts") or {}
    if _num(history.get("gap")) >= 3:
        add(5, f"Repeat pattern: {int(history['gap'])} tracking gaps in the previous 12 months.", "gfw_history")

    for key, label in (("web_search_vessel", "the vessel"), ("web_search_owner", "its owner")):
        hits = (ev.get(key) or {}).get("risk_hits") or []
        if hits:
            add(15, f"{len(hits)} web source(s) link {label} to illegal fishing, sanctions or detentions.", "web")

    score = min(100, sum(r["points"] for r in reasons))
    level = "high" if score >= 70 else "medium" if score >= 40 else "low"

    core = ["resolve_identity", "activity_around_event", "vessel_history", "web_search_vessel"]
    done = sum(1 for k in core if k in ev)
    confidence = "high" if done == 4 else "medium" if done >= 2 else "low"
    if confidence == "high" and (identity is not None and not identity.get("found") or (gaps and not counted)):
        confidence = "medium"
    return {"risk_score": score, "risk_level": level, "confidence": confidence,
            "tracking_status": tracking_status(counted or [], gap_hours) if gaps else tracking_status(events, gap_hours),
            "reasons": reasons, "caveats": caveats}
