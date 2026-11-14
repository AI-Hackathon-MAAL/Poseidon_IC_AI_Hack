"""Clean a snapshot produced by an older run so the front end gets the current shape.

    python scripts/clean_snapshot.py <input.json> [output.json]

- removes cases whose vessel type is not a fishing vessel (gear buoys, passenger boats, ...)
- recomputes the per-area summaries and adds map centres (from the cases) and empty outline fields
- adds an empty `global_news` list if missing
New runs of notebooks/poseidon already do all of this; this script only upgrades old files.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from poseidon import contract  # noqa: E402
from poseidon.pipeline import DEFAULT_EXCLUDED_TYPES  # noqa: E402

src = Path(sys.argv[1])
dst = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "data" / "poseidon_snapshot.json"
snap = json.loads(src.read_text(encoding="utf-8"))

excluded = set(DEFAULT_EXCLUDED_TYPES)
before = len(snap["cases"])
cases = [c for c in snap["cases"] if str(c.get("vessel_type") or "").lower() not in excluded]
events = [e for c in cases for e in c.get("events") or []]
old_mpas = {str(m["mpa_id"]): m for m in snap.get("mpas") or []}

mpas = []
for status in contract.mpa_status_rows(cases, events):
    old = old_mpas.get(status["mpa_id"], {})
    pts = [(float(c["lat"]), float(c["lon"])) for c in cases
           if str(c.get("mpa_id")) == status["mpa_id"] and c.get("lat") is not None and c.get("lon") is not None]
    lat = round(sum(p[0] for p in pts) / len(pts), 4) if pts else None
    lon = round(sum(p[1] for p in pts) / len(pts), 4) if pts else None
    mpas.append({**status, "news_summary": old.get("news_summary"), "rules_summary": old.get("rules_summary"),
                 "rules_sources": old.get("rules_sources") or [], "boundary": old.get("boundary"), "bbox": old.get("bbox"),
                 "boundary_source": old.get("boundary_source"),
                 "center_lat": old.get("center_lat") or lat, "center_lon": old.get("center_lon") or lon})

snap["cases"] = sorted(cases, key=lambda c: (-(int(c.get("risk_score") or 0)), str(c.get("case_id"))))
snap["mpas"] = sorted(mpas, key=lambda m: -m["top_risk_score"])
snap.setdefault("global_news", [])
snap["attribution"] = contract.ATTRIBUTION
dst.write_text(json.dumps(snap, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
print(f"Wrote {dst}: {len(cases)} cases (removed {before - len(cases)} non-fishing), {len(mpas)} areas, "
      f"{dst.stat().st_size // 1024} KB")
