"""Brief writer. The model writes prose from gathered facts only; a template is the fallback."""
from __future__ import annotations

import json

from .agent import ask_llm
from .scoring import gap_location

CAVEAT = ("Global Fishing Watch detections are *apparent* activity inferred from AIS. A tracking gap can have innocent "
          "causes (equipment failure, poor satellite coverage). This is a lead for review, not proof of illegal fishing.")

BRIEF_SYSTEM = (
    "You write one-page investigative leads for a coastguard or ocean-protection NGO. "
    "Use ONLY the facts in the JSON you are given. Never add facts, names, numbers or dates that are not there. "
    "Detections are 'apparent': this is a lead, never an accusation. "
    "Cite web sources inline as [n], matching the `n` of each entry in `sources`. Do not cite a source for a claim it does not support. "
    "Copy every number (score, hours, dates, counts) exactly as given. "
    "A tracking gap means the position is UNKNOWN while dark: never say the vessel was inside the area during a gap. "
    "Use `gap_ends_relative_to_area`: 'inside' = signal was lost or regained inside the area; 'outside' = both ends "
    "were outside and the vessel may only have crossed it. Do not call fishing unauthorised unless `reasons` says so. "
    "Write Markdown with exactly these sections:\n"
    "# <vessel name> — <risk_level> risk lead\n"
    "**Summary:** two sentences.\n"
    "## What happened\n(bullet timeline in UTC)\n"
    "## Why it matters\n(the scoring reasons in plain words)\n"
    "## Vessel background\n(identity, flag, owner, 12-month activity; say 'unknown' where the facts are missing)\n"
    "## What public sources say\n(only what sources state, with [n] citations; if none are relevant write 'No relevant public reports found.')\n"
    "## What we don't know\n(the `unknowns` list)\n"
    "## Suggested next steps\n(2-3 concrete checks an investigator could do)")


def brief_facts(case, assessment, ctx):
    ev = case.evidence
    web = {k: {"answer": (ev[k].get("answer") or "")[:1200]} for k in
           ("web_search_vessel", "web_search_owner", "mpa_rules", "regional_news") if k in ev}
    return {
        "vessel_name": case.display_name(), "vessel_id": case.vessel_id, "mmsi": case.mmsi, "flag": case.flag,
        "protected_area": case.mpa_name, "mode": ctx.mode, "window": [ctx.window_start, ctx.window_end],
        "risk_score": assessment["risk_score"], "risk_level": assessment["risk_level"],
        "confidence": assessment["confidence"], "investigation_status": assessment["status"],
        "reasons": [r["text"] for r in assessment["reasons"]],
        "unknowns": assessment["unknowns"],
        "events": [{**{k: e.get(k) for k in ("event_type", "start_time", "end_time", "duration_hours", "lat", "lon")},
                    **({"gap_ends_relative_to_area": gap_location(e)} if e["event_type"] == "gap" else {}),
                    **({"fishing_authorization": (e.get("details") or {}).get("authorization_status")}
                       if e["event_type"] == "fishing" else {})}
                   for e in case.events[:15]],
        "identity": {k: v for k, v in case.identity().items() if v not in (None, [], "")},
        "activity_around_event": ev.get("activity_around_event"),
        "history_12_months": (ev.get("vessel_history") or {}).get("counts"),
        "encounter_partner": ev.get("encounter_partner"),
        "web_findings": web,
        "sources": [{"n": s["n"], "kind": s["kind"], "title": s["title"], "url": s["url"],
                     "snippet": s["snippet"][:300]} for s in assessment["sources"]],
        "caveat": CAVEAT,
    }


def template_brief(facts):
    """Deterministic brief used when no model is available. Same sections, plainer prose."""
    lines = [f"# {facts['vessel_name']} — {facts['risk_level']} risk lead",
             f"**Summary:** Risk score {facts['risk_score']}/100 ({facts['confidence']} confidence) in "
             f"{facts['protected_area']}. Investigation {facts['investigation_status']}.", "", "## What happened"]
    for e in facts["events"]:
        dur = f" ({float(e['duration_hours']):.0f} h)" if e.get("duration_hours") not in (None, "") else ""
        lines.append(f"- {e['start_time']} — {e['event_type']}{dur}")
    lines += ["", "## Why it matters"] + ([f"- {r}" for r in facts["reasons"]] or ["- No risk factors scored."])
    ident = facts["identity"]
    lines += ["", "## Vessel background",
              f"- Names: {', '.join(ident.get('names') or []) or 'unknown'}",
              f"- Flags: {', '.join(ident.get('flags') or []) or facts.get('flag') or 'unknown'}",
              f"- IMO: {ident.get('imo') or 'unknown'}; MMSI: {facts.get('mmsi') or 'unknown'}",
              f"- Owner: {', '.join(ident.get('owners') or []) or 'unknown'}"]
    if facts.get("history_12_months"):
        lines.append("- Previous 12 months: " + ", ".join(f"{n} {k.replace('_', ' ')}" for k, n in facts["history_12_months"].items()))
    lines += ["", "## What public sources say"]
    if facts["sources"]:
        lines += [f"- [{s['n']}] [{s['title']}]({s['url']})" for s in facts["sources"]]
    else:
        lines.append("No relevant public reports found.")
    lines += ["", "## What we don't know"] + ([f"- {u}" for u in facts["unknowns"]] or ["- Nothing flagged."])
    lines += ["", "## Suggested next steps",
              "- Request the vessel's full track and logbook for the dark period.",
              "- Check licences and authorisations with the flag state and the protected area's authority.",
              "", f"_{facts['caveat']}_"]
    return "\n".join(lines)


def clean_markdown(text):
    """Drop code fences and any chatter before the first heading."""
    if not text:
        return None
    lines = [l for l in text.strip().splitlines() if not l.strip().startswith("```")]
    start = next((i for i, l in enumerate(lines) if l.lstrip().startswith("#")), None)
    return "\n".join(lines[start:]).strip() if start is not None else None


def write_brief(ctx, case, assessment):
    """Returns (markdown, written_by) where written_by is 'llm' or 'template'."""
    facts = brief_facts(case, assessment, ctx)
    text = clean_markdown(ask_llm(ctx, BRIEF_SYSTEM, json.dumps(facts, default=str)))
    if text and "## " in text and len(text) > 200:
        if facts["sources"] and "http" not in text:   # make sure the links survive
            text += "\n\n## Sources\n" + "\n".join(f"{s['n']}. [{s['title']}]({s['url']})" for s in facts["sources"])
        return text.strip() + f"\n\n_{CAVEAT}_", "llm"
    return template_brief(facts), "template"
