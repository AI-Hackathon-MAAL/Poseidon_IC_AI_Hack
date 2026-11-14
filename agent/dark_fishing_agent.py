"""Dark Fishing agent: investigates candidate events and writes cited briefs.

Pure Python so it can be tested off Databricks. The notebook `02_run_agent` wires in
secrets, the LLM endpoint and the Delta tables.

Flow per lead (one vessel in one MPA):
  1. gather   — the candidate events for that vessel/MPA
  2. history  — vessel identity history + its other recent events (GFW)
  3. web      — live web search for news / sanctions / IUU listings (Linkup or Tavily)
  4. score    — transparent rule-based risk score with plain-language reasons
  5. brief    — LLM writes a one-page brief using ONLY the facts gathered above

Every step is appended to `trace` so the front end can replay what the agent did.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

import requests

GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3"
GFW_EVENT_DATASETS = {
    "gap": "public-global-gaps-events:latest",
    "fishing": "public-global-fishing-events:latest",
    "encounter": "public-global-encounters-events:latest",
    "loitering": "public-global-loitering-events:latest",
}
RISK_TERMS = ("iuu", "illegal", "unreported", "sanction", "blacklist", "seized", "detained",
              "arrested", "fined", "transshipment", "forced labour", "forced labor")


# --------------------------------------------------------------------------- data

@dataclass
class Lead:
    vessel_id: str
    vessel_name: Optional[str]
    flag: Optional[str]
    mmsi: Optional[str]
    mpa_id: str
    mpa_name: Optional[str]
    events: list  # list of candidate dicts (see docs/schema.md)
    trace: list = field(default_factory=list)

    @property
    def is_sample(self) -> bool:
        return str(self.vessel_id).startswith("sample-")

    def log(self, step: str, detail: str, data=None):
        self.trace.append({"step": step, "detail": detail, "data": data,
                           "at": datetime.now(timezone.utc).isoformat()})


def group_leads(candidates: list[dict]) -> list[Lead]:
    """One lead per (vessel, MPA)."""
    groups: dict[tuple, Lead] = {}
    for c in candidates:
        if not c.get("vessel_id"):
            continue
        key = (c["vessel_id"], c.get("mpa_id"))
        if key not in groups:
            groups[key] = Lead(c["vessel_id"], c.get("vessel_name"), c.get("flag"), c.get("mmsi"),
                               c.get("mpa_id"), c.get("mpa_name"), [])
        groups[key].events.append(c)
    for lead in groups.values():
        lead.events.sort(key=lambda e: str(e.get("start_time")))
    return list(groups.values())


# --------------------------------------------------------------------------- tools

class Tools:
    def __init__(self, gfw_token: Optional[str], search_provider: str = "linkup",
                 search_key: Optional[str] = None, timeout: int = 30):
        self.gfw_token = gfw_token
        self.search_provider = search_provider
        self.search_key = search_key
        self.timeout = timeout

    # ---- GFW vessel history
    def vessel_history(self, lead: Lead, start: str, end: str) -> dict:
        if lead.is_sample:
            return {"synthetic": True,
                    "names": [lead.vessel_name, (lead.vessel_name or "") + " II"],
                    "flags": [lead.flag, "QQQ"],
                    "event_counts": {"gap": 4, "fishing": 9, "encounter": 2, "loitering": 1}}
        if not self.gfw_token:
            return {"error": "no GFW token"}
        h = {"Authorization": f"Bearer {self.gfw_token}", "Content-Type": "application/json"}
        out: dict = {"names": [], "flags": [], "event_counts": {}}
        try:
            r = requests.get(f"{GFW_BASE}/vessels/{lead.vessel_id}",
                             params={"dataset": "public-global-vessel-identity:latest"},
                             headers=h, timeout=self.timeout)
            if r.ok:
                v = r.json()
                for block in ("selfReportedInfo", "registryInfo"):
                    for rec in v.get(block) or []:
                        n, f = rec.get("shipname") or rec.get("nShipname"), rec.get("flag")
                        if n and n not in out["names"]:
                            out["names"].append(n)
                        if f and f not in out["flags"]:
                            out["flags"].append(f)
            else:
                out["identity_error"] = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            out["identity_error"] = str(e)
        for etype, ds in GFW_EVENT_DATASETS.items():
            try:
                r = requests.post(f"{GFW_BASE}/events", params={"offset": 0, "limit": 1},
                                  headers=h, timeout=self.timeout,
                                  data=json.dumps({"datasets": [ds], "vessels": [lead.vessel_id],
                                                   "startDate": start, "endDate": end}))
                if r.ok:
                    out["event_counts"][etype] = r.json().get("total", len(r.json().get("entries", [])))
            except requests.RequestException:
                pass
        return out

    # ---- live web search
    def web_search(self, query: str, sample: bool = False) -> dict:
        if sample:
            return {"synthetic": True, "answer": "No real search for synthetic vessels.",
                    "sources": [{"title": "Synthetic example source", "url": "https://example.org/synthetic",
                                 "snippet": "Example: vessel previously detained for unreported fishing."}]}
        if not self.search_key:
            return {"error": "no search key", "sources": []}
        try:
            if self.search_provider == "tavily":
                r = requests.post("https://api.tavily.com/search", timeout=self.timeout,
                                  headers={"Authorization": f"Bearer {self.search_key}"},
                                  json={"query": query, "max_results": 5, "include_answer": True})
                r.raise_for_status()
                d = r.json()
                return {"answer": d.get("answer"),
                        "sources": [{"title": s.get("title"), "url": s.get("url"),
                                     "snippet": (s.get("content") or "")[:400]} for s in d.get("results", [])]}
            r = requests.post("https://api.linkup.so/v1/search", timeout=self.timeout,
                              headers={"Authorization": f"Bearer {self.search_key}"},
                              json={"q": query, "depth": "standard", "outputType": "sourcedAnswer"})
            r.raise_for_status()
            d = r.json()
            return {"answer": d.get("answer"),
                    "sources": [{"title": s.get("name"), "url": s.get("url"),
                                 "snippet": (s.get("snippet") or s.get("content") or "")[:400]}
                                for s in d.get("sources", [])]}
        except requests.RequestException as e:
            return {"error": str(e), "sources": []}


# --------------------------------------------------------------------------- scoring

def score_lead(lead: Lead, history: dict, web: dict) -> tuple[int, str, list[str]]:
    """Transparent rules — every point comes with a reason a judge can read."""
    score, reasons = 0, []
    types = [e.get("event_type") for e in lead.events]
    gaps = [e for e in lead.events if e.get("event_type") == "gap"]
    fishing = [e for e in lead.events if e.get("event_type") == "fishing"]

    if gaps:
        score += 35
        reasons.append(f"Tracking was switched off {len(gaps)} time(s) in or near {lead.mpa_name}.")
        longest = max(float(g.get("duration_hours") or 0) for g in gaps)
        if longest >= 24:
            score += 10
            reasons.append(f"Longest dark period was {longest:.0f} hours.")
    if fishing:
        score += 25
        reasons.append(f"{len(fishing)} apparent fishing event(s) inside the protected area.")
    if gaps and fishing:
        for g in gaps:
            for f in fishing:
                try:
                    gap_end = datetime.fromisoformat(str(g["end_time"]).replace("Z", "+00:00"))
                    f_start = datetime.fromisoformat(str(f["start_time"]).replace("Z", "+00:00"))
                except (KeyError, ValueError):
                    continue
                if 0 <= (f_start - gap_end).total_seconds() <= 48 * 3600:
                    score += 20
                    reasons.append("Apparent fishing began within 48 hours of reappearing after a dark period.")
                    break
            else:
                continue
            break
    if "encounter" in types or "loitering" in types:
        score += 10
        reasons.append("Met or loitered with another vessel at sea, a possible catch transfer.")
    if len(set(filter(None, history.get("flags", [])))) > 1:
        score += 5
        reasons.append(f"Has used more than one flag: {', '.join(filter(None, history['flags']))}.")
    hits = [s for s in web.get("sources", [])
            if any(t in f"{s.get('title','')} {s.get('snippet','')}".lower() for t in RISK_TERMS)]
    if hits:
        score += 15
        reasons.append(f"{len(hits)} web source(s) mention illegal fishing, sanctions or detentions.")

    score = min(score, 100)
    level = "high" if score >= 70 else "medium" if score >= 40 else "low"
    return score, level, reasons


# --------------------------------------------------------------------------- brief

BRIEF_PROMPT = """You write one-page investigative leads for a coastguard or ocean NGO.
Use ONLY the facts in the JSON below. Do not add facts. If something is unknown, say so.
Global Fishing Watch detections are "apparent": call this a lead, never an accusation.
Cite web sources inline as [1], [2] matching the order of `sources`.

Format in Markdown:
# <Vessel name> — <risk level> risk lead
**Summary:** two sentences.
## What happened
Bullet timeline of events (UTC).
## Why it matters
The reasons, in plain words.
## Vessel background
Names, flags, activity counts.
## What the web says
Only what the sources state, with citations. If none, say "No relevant public reports found."
## Suggested next steps
2–3 concrete checks an investigator could do.

FACTS:
{facts}
"""


def fallback_brief(facts: dict) -> str:
    lines = [f"# {facts['vessel_name']} — {facts['risk_level']} risk lead",
             f"**Summary:** Risk score {facts['risk_score']}/100 in {facts['mpa_name']}.", "",
             "## Why it matters"] + [f"- {r}" for r in facts["reasons"]] + ["", "## Sources"]
    lines += [f"{i}. [{s.get('title')}]({s.get('url')})" for i, s in enumerate(facts["sources"], 1)]
    return "\n".join(lines)


# --------------------------------------------------------------------------- run

def investigate(lead: Lead, tools: Tools, llm: Optional[Callable[[str], str]],
                start: str, end: str) -> dict:
    lead.log("gather", f"{len(lead.events)} event(s) for {lead.vessel_name} in {lead.mpa_name}",
             [e.get("event_type") for e in lead.events])

    history = tools.vessel_history(lead, start, end)
    lead.log("history", "Pulled vessel identity and activity history", history)

    query = f'"{lead.vessel_name}" fishing vessel {lead.flag or ""} illegal OR IUU OR sanctions OR detained'
    web = tools.web_search(query, sample=lead.is_sample)
    lead.log("web", f"Web search: {query}", {"answer": web.get("answer"), "n_sources": len(web.get("sources", []))})

    score, level, reasons = score_lead(lead, history, web)
    lead.log("score", f"Risk {score}/100 ({level})", reasons)

    first, last = lead.events[0], lead.events[-1]
    facts = {
        "vessel_name": lead.vessel_name, "vessel_id": lead.vessel_id, "flag": lead.flag, "mmsi": lead.mmsi,
        "mpa_name": lead.mpa_name, "risk_score": score, "risk_level": level, "reasons": reasons,
        "events": [{k: str(e.get(k)) for k in ("event_type", "start_time", "end_time", "duration_hours", "lat", "lon")}
                   for e in lead.events],
        "history": history, "web_answer": web.get("answer"), "sources": web.get("sources", [])[:6],
        "synthetic_data": lead.is_sample,
    }
    brief = None
    if llm:
        try:
            brief = llm(BRIEF_PROMPT.format(facts=json.dumps(facts, default=str, indent=1)))
        except Exception as e:  # keep the pipeline alive on stage
            lead.log("brief", f"LLM failed, using template: {e}")
    brief = brief or fallback_brief(facts)
    lead.log("brief", "Wrote the brief")

    return {
        "brief_id": str(uuid.uuid4()), "event_id": first.get("event_id"),
        "vessel_id": lead.vessel_id, "vessel_name": lead.vessel_name, "flag": lead.flag,
        "mpa_name": lead.mpa_name, "event_type": ",".join(sorted({e.get("event_type") for e in lead.events})),
        "start_time": str(first.get("start_time")), "end_time": str(last.get("end_time")),
        "lat": first.get("lat"), "lon": first.get("lon"),
        "risk_score": score, "risk_level": level,
        "reasons": json.dumps(reasons), "sources": json.dumps(facts["sources"]),
        "brief_markdown": brief, "agent_trace": json.dumps(lead.trace, default=str),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def run(candidates: list[dict], tools: Tools, llm=None, start="2025-01-01", end="2025-12-31",
        max_leads: int = 20) -> list[dict]:
    leads = group_leads(candidates)
    # Investigate the most suspicious-looking first: gaps, then most events
    leads.sort(key=lambda l: (-sum(e.get("event_type") == "gap" for e in l.events), -len(l.events)))
    return [investigate(l, tools, llm, start, end) for l in leads[:max_leads]]
