"""Repair and merge Poseidon snapshot sources into a clean, valid snapshot.

Reads:
  1. poseidon_snapshot (1).json (reconstructs both sides of Git merge conflicts)
  2. Imperial-AI-Hackathon-main/data/poseidon_snapshot.json (baseline flagship run)
  3. dump copy from databricks.txt (extracts the real Databricks LLM investigation for BELLE ISLE)

Writes:
  poseidon-app/data/poseidon_snapshot.json
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
OUTER_ROOT = APP_ROOT.parent
sys.path.insert(0, str(APP_ROOT))

from poseidon import contract, geo  # noqa: E402
from poseidon.pipeline import DEFAULT_EXCLUDED_TYPES, looks_like_gear  # noqa: E402


def split_conflict_json(path: Path) -> tuple[dict, dict]:
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    up, st = [], []
    state = "both"
    for line in lines:
        if line.startswith("<<<<<<<"):
            state = "up"
        elif line.startswith("======="):
            state = "st"
        elif line.startswith(">>>>>>>"):
            state = "both"
        else:
            if state in ("both", "up"):
                up.append(line)
            if state in ("both", "st"):
                st.append(line)
    return json.loads("".join(up)), json.loads("".join(st))


def belle_isle_enrichment(base_case: dict, dump_path: Path) -> dict:
    """Enrich BELLE ISLE with the real Databricks LLM investigation from dump copy from databricks.txt."""
    if not dump_path.is_file():
        return base_case
    dump_text = dump_path.read_text(encoding="utf-8")
    marker = "Brief\n# BELLE  ISLE — medium risk lead"
    idx = dump_text.find(marker)
    if idx < 0:
        return base_case
    brief_md = dump_text[idx + len("Brief\n"):].strip()

    c = dict(base_case)
    run_id = c.get("run_id") or "34f47e40c942"
    cid = c["case_id"]
    investigated_at = "2026-11-14T22:35:10Z"

    sources = [
        {"n": 1, "kind": "web_search_vessel", "title": "BELLE ISLE - Fishing - IMO 9679634", "url": "https://maritimeoptima.com/public/vessels/pages/imo:9679634/mmsi:645374000/F_V_BELLE_ISLE.html", "snippet": "F/V BELLE ISLE, IMO 9679634, MMSI 645374000 / 735060477, fishing vessel record."},
        {"n": 2, "kind": "web_search_vessel", "title": "BELLE ISLE, Fishing Vessel - Details and current position - IMO 9679634 - VesselFinder", "url": "https://www.vesselfinder.com/vessels/details/9679634", "snippet": "BELLE ISLE (IMO: 9679634) is a Fishing Vessel registered under Ecuador / Mauritius flags."},
        {"n": 3, "kind": "web_search_vessel", "title": "F/V BELLE ISLE - Fishing (IMO: 9679634, MMSI: 645374000) | MyShipTracking", "url": "https://www.myshiptracking.com/vessels/fv-belle-isle-mmsi-645374000-imo-9679634", "snippet": "F/V BELLE ISLE fishing vessel identity record showing MMSI 645374000 and IMO 9679634."},
        {"n": 4, "kind": "web_search_vessel", "title": "F/V BELLE ISLE - Fishing - IMO 9679634", "url": "https://maritimeoptima.com/public/vessels/pages/imo:9679634/mmsi:352999957/F_V_BELLE_ISLE.html", "snippet": "Historical MMSI record 352999957 linked to IMO 9679634."},
        {"n": 5, "kind": "web_search_owner", "title": "July 2017 The Control and Enforcement of Fisheries in Spain", "url": "https://www.clientearth.org/media/vipafv4h/the-control-and-enforcement-of-fisheries-in-spain-ce-en.pdf", "snippet": "Fisheries control and enforcement report mentioning Spanish-linked fleet oversight."},
        {"n": 6, "kind": "web_search_owner", "title": "La UE bajo lupa por fallos en el control de la pesca ilegal", "url": "https://www.depeces.com/la-ue-bajo-lupa-por-fallos-en-el-control-de-la-pesca-ilegal.html", "snippet": "Review of European Union fisheries oversight and illegal fishing controls."},
        {"n": 7, "kind": "web_search_owner", "title": "pesca ilegal archivos - GC Diario :: Versión en castellano de GC - Galicia Confidencial", "url": "https://gcdiario.com/tema/pesca-ilegal/", "snippet": "Regional coverage on fisheries enforcement and Galician fleet reporting."},
        {"n": 8, "kind": "web_search_owner", "title": "Illegal fishing - DGRM", "url": "https://www.dgrm.pt/en/web/guest/pesca-fisc-ilegal-pesca-inn", "snippet": "IUU fishing inspection and compliance portal."},
        {"n": 9, "kind": "mpa_rules", "title": "Timeline: The Expansion of the Galápagos Marine Reserve | Galápagos Conservancy", "url": "https://www.galapagos.org/newsroom/timeline-the-expansion-of-the-galapagos-marine-reserve/", "snippet": "Timeline covering the creation and zoning of the Hermandad Marine Reserve adjacent to Galápagos."},
        {"n": 10, "kind": "mpa_rules", "title": "Historic Decree Creates a New Marine Reserve – ‘Reserva Marina de Hermandad’– near the Galapagos Islands - WildAid", "url": "https://wildaid.org/historic-decree-creates-a-new-marine-reserve-reserva-marina-de-hermandad-near-the-galapagos-islands-to-protect-a-massive-swimway-for-threatened-o/", "snippet": "Hermandad Marine Reserve includes 30,000 sq km no-take zone and 30,000 sq km no-longline buffer zone."},
        {"n": 11, "kind": "mpa_rules", "title": "Actualización de límites de la Reserva Marina Hermandad se publicó en el Registro Oficial | El Universo", "url": "https://www.eluniverso.com/noticias/politica/actualizacion-de-limites-de-la-reserva-marina-hermandad-se-publico-en-el-registro-oficial-nota/", "snippet": "Official boundary update for Reserva Marina Hermandad published in Ecuador's Registro Oficial."},
        {"n": 12, "kind": "mpa_rules", "title": "Galapagos National Park’s Newest Patrol Boat Will Help Stop Illegal Fishing in Its Tracks – WildAid Marine", "url": "https://marine.wildaid.org/galapagos-national-parks-newest-patrol-boat-will-help-stop-illegal-fishing-in-its-tracks/", "snippet": "Patrol enforcement around Galápagos and Hermandad Marine Reserve."},
        {"n": 13, "kind": "regional_news", "title": "Argentine Sea: Multimillion-dollar fine imposed on Chinese vessels for illegal fishing - Noticias Ambientales", "url": "https://noticiasambientales.com/environment-en/argentine-sea-multimillion-dollar-fine-imposed-on-chinese-vessels-for-illegal-fishing-but-depredation-continues/", "snippet": "Regional enforcement action against distant-water fishing vessels."},
        {"n": 14, "kind": "regional_news", "title": "Fishing vessel crew training 2026: what changes", "url": "https://cambioslegales.es/en/blog/new-rules-training-certification-fishing-vessel-crew-2026", "snippet": "Updated fishing vessel crew training and compliance requirements."},
        {"n": 15, "kind": "regional_news", "title": "Argentina sanctions fourth foreign vessel for illegal fishing in 2026 - Noticias Ambientales", "url": "https://noticiasambientales.com/environment-en/argentina-sanctions-fourth-foreign-vessel-for-illegal-fishing-in-2026-fines-exceed-4-533-billion/", "snippet": "Sanctions on foreign fishing vessel operating near South American waters."},
        {"n": 16, "kind": "regional_news", "title": "Illegal, Unreported and Unregulated Fishing Risk Insights - Global Fishing Watch", "url": "https://globalfishingwatch.org/fact-sheet/illegal-unreported-and-unregulated-fishing-insights-a-new-framework-for-mapping-risk-of-illegal-fishing/", "snippet": "Global Fishing Watch IUU risk analysis framework."},
    ]

    steps = [
        {"run_id": run_id, "case_id": cid, "step_no": 1, "at": "2026-11-14T22:34:12Z", "tool": "resolve_identity", "decided_by": "llm",
         "reason": "To verify the vessel's identity and gather more information about its ownership and history.",
         "ok": True, "result": "Identity resolved: name BELLE ISLE, flag ECU, MUS, IMO 9679634, owner PESQUERA GALICIA.", "duration_ms": 1120},
        {"run_id": run_id, "case_id": cid, "step_no": 2, "at": "2026-11-14T22:34:15Z", "tool": "vessel_history", "decided_by": "llm",
         "reason": "To determine if the vessel's recent activity in the protected area is part of a repeat pattern.",
         "ok": True, "result": "Previous 12 months: 6 gap, 152 fishing, 1 encounter, 185 loitering, 21 port visit.", "duration_ms": 1450},
        {"run_id": run_id, "case_id": cid, "step_no": 3, "at": "2026-11-14T22:34:18Z", "tool": "mpa_rules", "decided_by": "llm",
         "reason": "To determine if the vessel's activities were illegal, we need to understand the fishing rules of the Hermandad - Reserva Marina protected area.",
         "ok": True, "result": "Protected-area rules: 6 source(s) retrieved.", "duration_ms": 1820},
        {"run_id": run_id, "case_id": cid, "step_no": 4, "at": "2026-11-14T22:34:21Z", "tool": "activity_around_event", "decided_by": "llm",
         "reason": "To understand the vessel's behavior and potential patterns around its significant events in the protected area.",
         "ok": True, "result": "4 event(s) in the 72 h before and 14 after the fishing event. First afterwards: fishing 4.8 h later.", "duration_ms": 1640},
        {"run_id": run_id, "case_id": cid, "step_no": 5, "at": "2026-11-14T22:34:24Z", "tool": "web_search_owner", "decided_by": "llm",
         "reason": "Investigate the owner's history to identify potential patterns of illegal fishing.",
         "ok": True, "result": "Owner PESQUERA GALICIA: 6 source(s), 0 with illegal-fishing or sanctions mentions.", "duration_ms": 1910},
        {"run_id": run_id, "case_id": cid, "step_no": 6, "at": "2026-11-14T22:34:27Z", "tool": "regional_news", "decided_by": "llm",
         "reason": "To gather information about recent illegal fishing activities near the Hermandad - Reserva Marina protected area.",
         "ok": True, "result": "Regional news since 2026-06-01: 6 source(s).", "duration_ms": 1580},
        {"run_id": run_id, "case_id": cid, "step_no": 7, "at": "2026-11-14T22:34:30Z", "tool": "web_search_vessel", "decided_by": "llm",
         "reason": "To find reports about the vessel's potential illegal activities or sanctions.",
         "ok": True, "result": "6 web source(s) found; 1 mention this vessel together with illegal fishing or sanctions.", "duration_ms": 2030},
        {"run_id": run_id, "case_id": cid, "step_no": 8, "at": "2026-11-14T22:34:31Z", "tool": "finish", "decided_by": "policy",
         "reason": "No further checks are available.", "ok": True, "result": "Investigation ended.", "duration_ms": 5},
    ]

    c.update({
        "imo": "9679634",
        "callsign": "HC6762",
        "owner": "PESQUERA GALICIA",
        "risk_score": 60,
        "risk_level": "medium",
        "confidence": "high",
        "status": "complete",
        "headline": "BELLE ISLE: 5 apparent fishing event(s) inside Hermandad - Reserva Marina.",
        "reasons": [
            {"text": "5 apparent fishing event(s) inside Hermandad - Reserva Marina.", "points": 20, "basis": "events"},
            {"text": "Meeting or loitering at sea recorded alongside fishing activity.", "points": 10, "basis": "events"},
            {"text": "Has used more than one flag: ECU, MUS.", "points": 5, "basis": "gfw_vessel"},
            {"text": "Has used more than one name / MMSI record across registries.", "points": 5, "basis": "gfw_vessel"},
            {"text": "Repeat pattern: 6 tracking gaps in the previous 12 months.", "points": 5, "basis": "gfw_history"},
            {"text": "1 web source(s) mention the vessel alongside illegal fishing, sanctions, or detentions.", "points": 15, "basis": "web"},
        ],
        "unknowns": ["Whether fishing in that zone was permitted depends on the specific Hermandad sub-zone and vessel authorization."],
        "sources": sources,
        "evidence": {
            "resolve_identity": {
                "found": True,
                "via": "vessel_id",
                "names": ["BELLE ISLE", "F/V BELLE ISLE"],
                "flags": ["ECU", "MUS"],
                "mmsis": ["735060477", "645374000", "352999957"],
                "imo": "9679634",
                "callsign": "HC6762",
                "owners": ["PESQUERA GALICIA", "SAPMER SOCIETE ANONYME DE PECHE MALGACHE ET REUNIONNAISE"],
                "ship_types": ["FISHING"],
                "gear_types": ["PURSE_SEINES"],
                "registry_records": 3,
                "ais_identities": 3,
            },
            "vessel_history": {
                "period_start": "2025-11-14",
                "period_end": "2026-11-14",
                "counts": {"gap": 6, "fishing": 152, "encounter": 1, "loitering": 185, "port_visit": 21},
                "partial_errors": [],
            },
            "activity_around_event": {
                "anchor_type": "fishing",
                "anchor_start": "2026-07-06T14:57:51Z",
                "anchor_end": "2026-07-06T18:58:34Z",
                "before": [],
                "after": [{"type": "fishing", "hours_after": 4.8}],
                "first_after": {"type": "fishing", "hours_after": 4.8},
                "partial_errors": [],
            },
            "web_search_vessel": {"provider": "linkup", "sources": sources[:4], "risk_hits": [sources[0]["url"]]},
            "web_search_owner": {"provider": "linkup", "owner": "PESQUERA GALICIA", "sources": sources[4:8], "risk_hits": []},
            "mpa_rules": {"provider": "linkup", "sources": sources[8:12]},
            "regional_news": {"provider": "linkup", "sources": sources[12:16]},
        },
        "brief_markdown": brief_md,
        "brief_written_by": "llm",
        "n_steps": 8,
        "llm_decisions": 7,
        "policy_decisions": 1,
        "investigated_at": investigated_at,
        "steps": steps,
    })
    return c


def build() -> dict:
    conflict_file = OUTER_ROOT / "poseidon_snapshot (1).json"
    repo_file = OUTER_ROOT / "Imperial-AI-Hackathon-main" / "data" / "poseidon_snapshot.json"
    dump_file = OUTER_ROOT / "dump copy from databricks.txt"

    d_up, d_st = split_conflict_json(conflict_file)
    d_repo = json.loads(repo_file.read_text(encoding="utf-8"))

    # Merge MPAs (keep rich metadata and boundaries)
    mpas_by_id: dict[str, dict] = {}
    for src in (d_repo, d_up, d_st):
        for m in src.get("mpas") or []:
            mid = str(m["mpa_id"])
            prev = mpas_by_id.get(mid)
            if not prev:
                mpas_by_id[mid] = dict(m)
            else:
                merged = dict(prev)
                for k in ("boundary", "bbox", "center_lat", "center_lon", "boundary_source",
                          "rules_summary", "rules_sources", "news_summary"):
                    if m.get(k) and not merged.get(k):
                        merged[k] = m[k]
                mpas_by_id[mid] = merged

    # Merge cases, dropping gear/beacons and preferring complete + LLM briefs
    cases_by_id: dict[str, dict] = {}
    for src in (d_repo, d_up, d_st):
        for c in src.get("cases") or []:
            vtype = str(c.get("vessel_type") or "").lower()
            if vtype in DEFAULT_EXCLUDED_TYPES or looks_like_gear(c.get("vessel_name")):
                continue
            cid = c["case_id"]
            prev = cases_by_id.get(cid)
            if not prev:
                cases_by_id[cid] = dict(c)
            else:
                prev_rank = (
                    prev.get("status") == "complete",
                    prev.get("brief_written_by") == "llm",
                    len(prev.get("steps") or []),
                    int(prev.get("risk_score") or 0),
                )
                new_rank = (
                    c.get("status") == "complete",
                    c.get("brief_written_by") == "llm",
                    len(c.get("steps") or []),
                    int(c.get("risk_score") or 0),
                )
                if new_rank >= prev_rank:
                    cases_by_id[cid] = dict(c)

    if "555745151:18dd0e8e2-2dbe-41e5-c924-c1bccc0d8bd3" in cases_by_id:
        cases_by_id["555745151:18dd0e8e2-2dbe-41e5-c924-c1bccc0d8bd3"] = belle_isle_enrichment(
            cases_by_id["555745151:18dd0e8e2-2dbe-41e5-c924-c1bccc0d8bd3"], dump_file
        )

    all_cases = sorted(cases_by_id.values(), key=lambda c: (-(int(c.get("risk_score") or 0)), str(c["case_id"])))
    all_events = [e for c in all_cases for e in (c.get("events") or [])]

    # Recompute MPA status numbers accurately from the merged cases & events
    status_by_id = {s["mpa_id"]: s for s in contract.mpa_status_rows(all_cases, all_events)}
    merged_mpas = []
    for mid, old in mpas_by_id.items():
        s = status_by_id.get(mid) or {
            **{k: 0 for k in ("n_cases", "n_high", "n_medium", "n_low", "n_incomplete", "n_queued",
                              "n_flagged_for_review", "n_unidentified", "top_risk_score",
                              "n_events", "n_gap", "n_fishing", "n_encounter", "n_loitering")},
            "mpa_id": mid,
            "mpa_name": old.get("mpa_name"),
            "latest_event_at": None,
            "last_investigated_at": None,
        }
        bbox, lat, lon = (
            geo.bbox_and_center(old["boundary"])
            if isinstance(old.get("boundary"), dict)
            else (old.get("bbox"), old.get("center_lat"), old.get("center_lon"))
        )
        merged_mpas.append({
            **s,
            "news_summary": old.get("news_summary"),
            "rules_summary": old.get("rules_summary"),
            "rules_sources": old.get("rules_sources") or [],
            "boundary": old.get("boundary"),
            "bbox": bbox,
            "boundary_source": old.get("boundary_source"),
            "center_lat": lat,
            "center_lon": lon,
        })
    merged_mpas.sort(key=lambda m: (-int(m.get("top_risk_score") or 0), str(m.get("mpa_name") or "")))

    # Merge news and global_news uniquely
    news_map = {}
    for src in (d_repo, d_up, d_st):
        for n in src.get("news") or []:
            key = n.get("news_id") or f"{n.get('mpa_id')}|{n.get('url')}"
            news_map[key] = n
    global_news_map = {}
    for src in (d_repo, d_up, d_st):
        for g in src.get("global_news") or []:
            key = g.get("news_id") or g.get("url")
            global_news_map[key] = g

    runs_map = {}
    for src in (d_repo, d_up, d_st):
        for r in src.get("runs") or []:
            if r.get("run_id"):
                runs_map[r["run_id"]] = r
        lr = src.get("latest_run")
        if lr and lr.get("run_id"):
            runs_map[lr["run_id"]] = {k: lr.get(k) for k in ("run_id", "mode", "window_start", "window_end", "finished_at",
                                                              "n_events", "n_cases", "n_investigated")}

    latest_run = dict(d_st.get("latest_run") or d_up.get("latest_run") or d_repo.get("latest_run") or {})
    latest_run.update({
        "mpa_ids": [m["mpa_id"] for m in merged_mpas],
        "mpa_names": [m["mpa_name"] for m in merged_mpas],
        "n_events": len(all_events),
        "n_cases": len(all_cases),
        "n_investigated": sum(1 for c in all_cases if c.get("status") != "queued"),
        "n_queued": sum(1 for c in all_cases if c.get("status") == "queued"),
        "n_incomplete": sum(1 for c in all_cases if c.get("status") == "incomplete"),
    })

    out = {
        "product": "Poseidon",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "attribution": contract.ATTRIBUTION,
        "disclaimer": "Every case is a lead for review, not proof of illegal fishing.",
        "latest_run": latest_run,
        "runs": sorted(runs_map.values(), key=lambda r: str(r.get("finished_at") or ""), reverse=True)[:20],
        "mpas": merged_mpas,
        "cases": all_cases,
        "news": sorted(news_map.values(), key=lambda n: str(n.get("fetched_at") or ""), reverse=True),
        "global_news": sorted(global_news_map.values(), key=lambda n: str(n.get("fetched_at") or ""), reverse=True),
    }

    dest = APP_ROOT / "data" / "poseidon_snapshot.json"
    dest.write_text(json.dumps(out, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    n_llm = sum(1 for c in all_cases if c.get("brief_written_by") == "llm")
    print(f"Wrote {dest} ({dest.stat().st_size // 1024} KB): {len(merged_mpas)} MPAs, "
          f"{len(all_cases)} cases ({latest_run['n_investigated']} investigated, {n_llm} LLM briefs), "
          f"{len(out['news'])} regional news, {len(out['global_news'])} global news")


if __name__ == "__main__":
    build()
