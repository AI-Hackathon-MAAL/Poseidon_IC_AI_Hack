"""Regenerate data/poseidon_snapshot.sample.json from the synthetic sample data.

    python scripts/make_sample_snapshot.py

Runs the real agent code against poseidon/sample.py (invented vessels and sources), so the
file has exactly the shape the notebook writes to /Volumes/.../exports/poseidon_snapshot.json.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from poseidon import contract, geo, intel, pipeline  # noqa: E402
from poseidon.agent import Context, now_iso  # noqa: E402
from poseidon.sample import SAMPLE_BOUNDARIES, SAMPLE_MPAS, SampleGFW, SampleLLM, SampleSearch  # noqa: E402

mpas = pipeline.select_mpas(SAMPLE_MPAS, search="sample")
ctx = Context(gfw=SampleGFW(), search=SampleSearch(), llm=SampleLLM(), window_start="2026-10-01",
              window_end="2026-10-31", mode="history")
out = pipeline.run(ctx, mpas, max_cases=3, llm_endpoint="sample-scripted-model", log=lambda *_: None)
shapes = []
for m in mpas:
    g = geo.simplify_geometry(SAMPLE_BOUNDARIES[m["mpa_id"]])
    bbox, lat, lon = geo.bbox_and_center(g)
    shapes.append({**m, "geometry": g, "bbox": bbox, "center_lat": lat, "center_lon": lon, "source": "synthetic"})
world = intel.global_news(ctx.search, shapes, "2026-10-31", mode="history", window_start="2026-10-01",
                          run_id=out["run"][0]["run_id"], log=lambda *_: None)
snapshot = contract.build_snapshot(out["run"], out["cases"], out["events"], out["steps"], out["news"],
                                   out["mpa_context"], now_iso(), boundaries=shapes, global_news=world)
snapshot["synthetic"] = True
target = ROOT / "data" / "poseidon_snapshot.sample.json"
target.write_text(json.dumps(snapshot, indent=1, default=str, ensure_ascii=False), encoding="utf-8")
print(f"Wrote {target} ({len(snapshot['cases'])} cases, {target.stat().st_size // 1024} KB)")
