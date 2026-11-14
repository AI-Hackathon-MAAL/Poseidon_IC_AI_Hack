"""Re-score an existing snapshot with the current scoring rules, without calling any API.

    python scripts/rescore_snapshot.py [input.json] [output.json]

Uses the events and evidence already stored in each case. Locates every gap against the area
outline, drops beacons, recomputes scores, reasons, headlines, unknowns and area summaries.
Briefs of investigated cases are replaced by the template brief (the model-written text quoted the
old score); the next Databricks run writes fresh model briefs.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from poseidon import contract, geo  # noqa: E402
from poseidon.agent import Case, Context, collect_sources, headline  # noqa: E402
from poseidon.brief import brief_facts, template_brief  # noqa: E402
from poseidon.pipeline import DEFAULT_EXCLUDED_TYPES, looks_like_gear  # noqa: E402
from poseidon.scoring import score_case, web_risk_hits  # noqa: E402

src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "poseidon_snapshot.json"
dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src
snap = json.loads(src.read_text(encoding="utf-8"))
outlines = {str(m["mpa_id"]): m.get("boundary") for m in snap["mpas"]}
changes, kept = [], []

for c in snap["cases"]:
    if str(c.get("vessel_type") or "").lower() in DEFAULT_EXCLUDED_TYPES or looks_like_gear(c.get("vessel_name")):
        continue
    for e in c["events"]:
        e["details"] = {k: v for k, v in (e.get("details") or {}).items() if k not in ("mpa_ids", "eez")}
        g = outlines.get(str(e["mpa_id"]))
        if e["event_type"] == "gap" and g:
            e["details"]["gap_start_inside"] = geo.point_in_geometry(e.get("lon"), e.get("lat"), g)
            e["details"]["gap_end_inside"] = geo.point_in_geometry(e.get("end_lon"), e.get("end_lat"), g)
    case = Case(c["mpa_id"], c["mpa_name"], c["vessel_id"],
                None if not c.get("vessel_identified") else c["vessel_name"], c.get("flag"), c.get("mmsi"),
                c.get("vessel_type"), c["events"])
    case.evidence = c.get("evidence") or {}
    ident = case.evidence.get("resolve_identity") or {}
    for key, ids in (("web_search_vessel", [case.best_name(), ident.get("imo"), c.get("mmsi")]),
                     ("web_search_owner", [(ident.get("owners") or [None])[0]])):
        if key in case.evidence:   # re-check web hits with the stricter rule
            case.evidence[key]["risk_hits"] = web_risk_hits(case.evidence[key].get("sources"), ids,
                                                            imo=ident.get("imo") if key == "web_search_vessel" else None)
    score = score_case(case)
    caveats = score.pop("caveats")
    old = c["risk_score"]
    stale = [u for u in c.get("unknowns") or [] if u not in caveats]
    c.update({**score, "headline": headline(case, score), "unknowns": caveats + stale, "evidence": case.evidence,
              "sources": collect_sources(case) if c["status"] != "queued" else []})
    if c["status"] == "queued":
        c["confidence"] = "low"
        c["headline"] = f"{c['vessel_name']}: {len(c['events'])} event(s) in {c['mpa_name']}, awaiting investigation."
    else:
        ctx = Context(gfw=None, window_start=c.get("window_start"), window_end=c.get("window_end"), mode=c.get("mode") or "history")
        a = {**score, "status": c["status"], "unknowns": c["unknowns"], "sources": c["sources"], "headline": c["headline"]}
        c["brief_markdown"], c["brief_written_by"] = template_brief(brief_facts(case, a, ctx)), "template"
    if old != c["risk_score"]:
        changes.append((old, c["risk_score"], c["vessel_name"], c["mpa_name"][:22], c["status"]))
    kept.append(c)

removed = len(snap["cases"]) - len(kept)
snap["cases"] = sorted(kept, key=lambda c: (-(int(c["risk_score"])), str(c["case_id"])))
events = [e for c in kept for e in c["events"]]
old_mpas = {str(m["mpa_id"]): m for m in snap["mpas"]}
status = {s["mpa_id"]: s for s in contract.mpa_status_rows(kept, events)}
mpas = []
for mpa_id, old in old_mpas.items():
    s = status.get(mpa_id) or {**{k: 0 for k in old if k.startswith("n_")}, "mpa_id": mpa_id, "mpa_name": old["mpa_name"],
                               "top_risk_score": 0, "latest_event_at": None, "last_investigated_at": None}
    extra = {k: old.get(k) for k in ("news_summary", "rules_summary", "rules_sources", "boundary", "boundary_source")}
    bbox, lat, lon = geo.bbox_and_center(old["boundary"]) if old.get("boundary") else (old.get("bbox"), old.get("center_lat"), old.get("center_lon"))
    mpas.append({**s, **extra, "bbox": bbox, "center_lat": lat, "center_lon": lon})
snap["mpas"] = sorted(mpas, key=lambda m: -m["top_risk_score"])
snap["rescored"] = "Scores recomputed with the current rules by scripts/rescore_snapshot.py; briefs are template briefs."
dst.write_text(json.dumps(snap, indent=1, ensure_ascii=False, default=str), encoding="utf-8")

for old, new, name, area, st in sorted(changes, key=lambda x: x[1] - x[0]):
    print(f"  {old:3} -> {new:3}  {name[:26]:26} {area:22} {st}")
print(f"Wrote {dst} ({dst.stat().st_size // 1024} KB): {len(kept)} cases, {removed} removed, {len(changes)} scores changed")
