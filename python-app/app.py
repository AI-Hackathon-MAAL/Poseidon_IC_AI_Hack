"""Poseidon — Unified self-contained Python server and autonomous agent runtime.

Serves the clean web globe UI, exposes the snapshot API, runs live investigations
using the `poseidon` Python package (GFW + Linkup + Databricks Foundation Models),
and optionally syncs live exports directly from a Databricks Unity Catalog Volume.

Run locally:
    python app.py
"""
from __future__ import annotations

import json
import os
import sys
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests

APP_DIR = Path(__file__).resolve().parent
REPO_DIR = APP_DIR.parent
WEB_DIR = APP_DIR / "web"
# Shared with the rest of the repository: the `poseidon` package, the published
# snapshot in data/ and the globe imagery in app/assets are not duplicated here.
SHARED_ASSETS_DIR = REPO_DIR / "app" / "assets"
SHARED_DATA_DIR = REPO_DIR / "data"
# Investigations started from this app are saved to python-app/data/ (git-ignored),
# so they never overwrite the snapshot published from Databricks.
DATA_DIR = APP_DIR / "data"
SNAPSHOT_FILE = DATA_DIR / "poseidon_snapshot.json"
SHARED_SNAPSHOT_FILE = SHARED_DATA_DIR / "poseidon_snapshot.json"
SAMPLE_FILE = SHARED_DATA_DIR / "poseidon_snapshot.sample.json"
MPA_INDEX_FILE = SHARED_DATA_DIR / "mpa_index.json"

sys.path.insert(0, str(REPO_DIR))

try:
    from dotenv import load_dotenv
    load_dotenv(APP_DIR / ".env")
except Exception:
    pass

from poseidon import contract, geo, pipeline  # noqa: E402
from poseidon.agent import Case, Context, assess, investigate, now_iso  # noqa: E402
from poseidon.brief import write_brief  # noqa: E402
from poseidon.gfw import GFWClient, parse_time  # noqa: E402
from poseidon.scoring import longest_gap_hours  # noqa: E402
from poseidon.search import SearchClient  # noqa: E402

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _load_snapshot_from_disk() -> tuple[dict, str]:
    for path, src in ((SNAPSHOT_FILE, "export"), (SHARED_SNAPSHOT_FILE, "export"), (SAMPLE_FILE, "sample")):
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding="utf-8-sig"))
                if data.get("product") == "Poseidon" and isinstance(data.get("cases"), list):
                    return data, src
            except Exception:
                continue
    return {
        "product": "Poseidon",
        "generated_at": now_iso(),
        "attribution": contract.ATTRIBUTION,
        "disclaimer": "Every case is a lead for review, not proof of illegal fishing.",
        "latest_run": None,
        "runs": [],
        "mpas": [],
        "cases": [],
        "news": [],
        "global_news": [],
    }, "empty"


def _to_raw_gfw_event(ev: dict) -> dict:
    """Convert a flattened Poseidon event dict back into raw GFW API shape for flatten_event()."""
    d = ev.get("details") or {}
    kind = ev.get("event_type")
    raw = {
        "id": ev.get("event_id"),
        "start": ev.get("start_time"),
        "end": ev.get("end_time"),
        "vessel": {
            "id": ev.get("vessel_id"),
            "name": ev.get("vessel_name"),
            "ssvid": ev.get("mmsi"),
            "flag": ev.get("flag"),
            "type": ev.get("vessel_type"),
        },
        "position": {"lat": ev.get("lat"), "lon": ev.get("lon")},
        "regions": {
            "mpa": [ev.get("mpa_id")] if ev.get("mpa_id") is not None else [],
            "mpaNoTake": bool(d.get("in_no_take_mpa")),
            "mpaNoTakePartial": bool(d.get("in_partial_no_take_mpa")),
        },
        "distances": {"startDistanceFromShoreKm": d.get("distance_from_shore_km")},
    }
    if kind == "gap":
        raw["gap"] = {
            "offPosition": {"lat": ev.get("lat"), "lon": ev.get("lon")},
            "onPosition": {"lat": ev.get("end_lat"), "lon": ev.get("end_lon")},
            "distanceKm": d.get("gap_distance_km"),
            "impliedSpeedKnots": d.get("gap_implied_speed_knots"),
        }
    elif kind == "fishing":
        raw["fishing"] = {
            "potentialRisk": d.get("potential_risk"),
            "vesselPublicAuthorizationStatus": d.get("authorization_status"),
        }
    elif kind == "encounter" and (d.get("partner_vessel_id") or d.get("partner_vessel_name")):
        raw["encounter"] = {
            "vessel": {
                "id": d.get("partner_vessel_id"),
                "name": d.get("partner_vessel_name"),
                "flag": d.get("partner_vessel_flag"),
                "type": d.get("partner_vessel_type"),
            }
        }
    elif kind == "port_visit" and d.get("port_name"):
        raw["portVisit"] = {"intermediateAnchorage": {"name": d.get("port_name"), "flag": d.get("port_flag")}}
    return raw


class SnapshotGFWAdapter:
    """Fallback GFW adapter backed by existing snapshot records when GFW_TOKEN is unset."""

    def __init__(self, snapshot: dict):
        self.snapshot = snapshot
        self.calls = 0

    def _cases_for_vessel(self, vessel_id: str) -> list[dict]:
        return [c for c in self.snapshot.get("cases") or [] if c.get("vessel_id") == vessel_id]

    def vessel(self, vessel_id: str) -> dict:
        self.calls += 1
        matches = self._cases_for_vessel(vessel_id)
        if not matches:
            return {}
        for c in matches:
            ident = (c.get("evidence") or {}).get("resolve_identity") or {}
            if ident.get("found"):
                return {
                    "selfReportedInfo": [
                        {"id": vessel_id, "shipname": n, "flag": (ident.get("flags") or [c.get("flag")])[0],
                         "ssvid": c.get("mmsi"), "imo": ident.get("imo"), "callsign": ident.get("callsign")}
                        for n in (ident.get("names") or ([c.get("vessel_name")] if c.get("vessel_identified") else []))
                    ],
                    "registryInfo": [
                        {"shipname": n, "flag": f, "imo": ident.get("imo"), "callsign": ident.get("callsign"),
                         "geartypes": ident.get("gear_types") or []}
                        for n in (ident.get("names") or [])[:1]
                        for f in (ident.get("flags") or ([c.get("flag")] if c.get("flag") else []))
                    ],
                    "registryOwners": [{"name": o} for o in (ident.get("owners") or [])],
                    "combinedSourcesInfo": [{"shiptypes": ident.get("ship_types") or [], "geartypes": ident.get("gear_types") or []}],
                }
        c0 = matches[0]
        if c0.get("vessel_identified") is False and not c0.get("imo") and not c0.get("owner"):
            return {"selfReportedInfo": [{"id": vessel_id, "ssvid": c0.get("mmsi"), "flag": c0.get("flag")}]}
        name = c0.get("vessel_name") if c0.get("vessel_identified") is not False else None
        return {
            "selfReportedInfo": [{"id": vessel_id, "shipname": name, "flag": c0.get("flag"),
                                  "ssvid": c0.get("mmsi"), "imo": c0.get("imo"), "callsign": c0.get("callsign")}],
            "registryInfo": [{"shipname": name, "flag": c0.get("flag"), "imo": c0.get("imo"),
                              "callsign": c0.get("callsign")}] if name else [],
            "registryOwners": [{"name": c0["owner"]}] if c0.get("owner") else [],
            "combinedSourcesInfo": [{"shiptypes": [c0["vessel_type"]] if c0.get("vessel_type") else []}],
        }

    def search_vessels(self, query: str, limit: int = 5) -> list[dict]:
        self.calls += 1
        q = str(query or "").strip()
        out = []
        for c in self.snapshot.get("cases") or []:
            if q and q in (str(c.get("mmsi") or ""), str(c.get("vessel_name") or "")):
                out.append(self.vessel(c["vessel_id"]))
                if len(out) >= limit:
                    break
        return out

    def events(self, kind: str, start: str, end: str, mpa_id=None, vessel_id=None, **_kwargs):
        self.calls += 1
        t_start, t_end = parse_time(start), parse_time(end)
        found = []
        seen_ids = set()
        for c in self.snapshot.get("cases") or []:
            if vessel_id and c.get("vessel_id") != vessel_id:
                continue
            if mpa_id is not None and str(c.get("mpa_id")) != str(mpa_id):
                continue
            for ev in c.get("events") or []:
                if ev.get("event_type") != kind:
                    continue
                eid = ev.get("event_id")
                if eid in seen_ids:
                    continue
                es = parse_time(ev.get("start_time"))
                ee = parse_time(ev.get("end_time")) or es
                if t_start and ee and ee < t_start:
                    continue
                if t_end and es and es > t_end:
                    continue
                seen_ids.add(eid)
                found.append(_to_raw_gfw_event(ev))
        return found, True

    def count_events(self, kind: str, start: str, end: str, vessel_id: str) -> int:
        for c in self._cases_for_vessel(vessel_id):
            counts = ((c.get("evidence") or {}).get("vessel_history") or {}).get("counts") or {}
            if kind in counts:
                self.calls += 1
                return int(counts[kind])
        rows, _ = self.events(kind, start, end, vessel_id=vessel_id)
        return len(rows)


class SnapshotSearchAdapter:
    """Fallback search adapter backed by cached Linkup sources in the snapshot when LINKUP_API_KEY is unset."""

    provider = "linkup-cache"

    def __init__(self, snapshot: dict):
        self.snapshot = snapshot
        self.calls = 0

    def search(self, query: str, from_date=None, to_date=None, max_results: int = 6, depth: str = "standard"):
        self.calls += 1
        ql = str(query or "").lower()
        sources = []
        answer = None

        if "fishing rules" in ql:
            for m in self.snapshot.get("mpas") or []:
                name = str(m.get("mpa_name") or "").lower()
                if name and (name in ql or name.split(" - ")[0] in ql):
                    answer = m.get("rules_summary")
                    for s in m.get("rules_sources") or []:
                        if s.get("url"):
                            sources.append({"title": s.get("title") or s["url"], "url": s["url"],
                                            "snippet": s.get("snippet") or (answer or "")[:240]})
                    break
        elif "latest news" in ql:
            for n in self.snapshot.get("news") or []:
                mname = str(n.get("mpa_name") or "").lower()
                if mname and (mname in ql or mname.split(" - ")[0] in ql):
                    sources.append({"title": n.get("title") or n["url"], "url": n["url"],
                                    "snippet": n.get("snippet") or ""})
            if not sources:
                for g in (self.snapshot.get("global_news") or [])[:max_results]:
                    sources.append({"title": g.get("title") or g["url"], "url": g["url"],
                                    "snippet": g.get("snippet") or ""})
            answer = f"Retrieved {len(sources)} archived regional Linkup sources."
        else:
            # Vessel or owner query: scan existing case evidence/sources for matching identifiers
            tokens = [tok.strip('"(),').lower() for tok in query.split() if len(tok.strip('"(),')) >= 4]
            for c in self.snapshot.get("cases") or []:
                vname = str(c.get("vessel_name") or "").lower()
                imo = str(c.get("imo") or "").lower()
                owner = str(c.get("owner") or "").lower()
                if (vname and vname in ql) or (imo and imo in ql) or (owner and owner in ql):
                    for s in c.get("sources") or []:
                        if s.get("url"):
                            sources.append({"title": s.get("title") or s["url"], "url": s["url"],
                                            "snippet": s.get("snippet") or ""})
            if not sources and tokens:
                for item in (self.snapshot.get("news") or []) + (self.snapshot.get("global_news") or []):
                    hay = f"{item.get('title', '')} {item.get('snippet', '')}".lower()
                    if any(tok in hay for tok in tokens if tok not in ("illegal", "fishing", "vessel", "sanctions", "reports")):
                        sources.append({"title": item.get("title") or item["url"], "url": item["url"],
                                        "snippet": item.get("snippet") or ""})
            answer = (
                f"Matched {len(sources)} source(s) from cached Linkup records."
                if sources else "No adverse public reports found in cached Linkup search records."
            )

        deduped, seen = [], set()
        for s in sources:
            u = s.get("url")
            if u and u not in seen:
                seen.add(u)
                deduped.append(s)
        return {
            "answer": answer,
            "sources": deduped[:max_results],
            "query": query,
            "provider": self.provider,
            "from_date": from_date,
            "to_date": to_date,
        }


def _make_databricks_llm():
    host = _env("DATABRICKS_HOST").rstrip("/")
    token = _env("DATABRICKS_TOKEN")
    endpoint = _env("DATABRICKS_MODEL_ENDPOINT", "databricks-llama-4-maverick")
    if not host or not token:
        return None, None
    if not host.startswith("https://"):
        host = "https://" + host

    def _call(system: str, user: str, max_tokens: int = 1500) -> str:
        url = f"{host}/serving-endpoints/{endpoint}/invocations"
        r = requests.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "max_tokens": max_tokens,
                "temperature": 0.1,
            },
            timeout=45,
        )
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        if isinstance(content, list):
            return "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type", "text") == "text")
        return content or ""

    return _call, endpoint


class PoseidonStore:
    """Thread-safe holder for the active Poseidon snapshot and live investigation runner."""

    def __init__(self):
        self.lock = threading.Lock()
        self.snapshot, self.source = _load_snapshot_from_disk()

    def status(self) -> dict:
        with self.lock:
            cases = self.snapshot.get("cases") or []
            mpas = self.snapshot.get("mpas") or []
            gfw_live = bool(_env("GFW_TOKEN"))
            linkup_live = bool(_env("LINKUP_API_KEY"))
            db_live = bool(_env("DATABRICKS_HOST") and _env("DATABRICKS_TOKEN"))
            return {
                "ok": True,
                "python_version": sys.version.split()[0],
                "mode": "live_cloud" if (gfw_live or linkup_live or db_live) else "hybrid_local",
                "gfw_live": gfw_live,
                "linkup_live": linkup_live,
                "databricks_live": db_live,
                "databricks_endpoint": _env("DATABRICKS_MODEL_ENDPOINT", "databricks-llama-4-maverick") if db_live else None,
                "source": self.source,
                "generated_at": self.snapshot.get("generated_at"),
                "n_mpas": len(mpas),
                "n_cases": len(cases),
                "n_complete": sum(1 for c in cases if c.get("status") == "complete"),
                "n_queued": sum(1 for c in cases if c.get("status") == "queued"),
                "n_llm_briefs": sum(1 for c in cases if c.get("brief_written_by") == "llm"),
            }

    def get_snapshot_bytes(self) -> tuple[bytes, str]:
        with self.lock:
            payload = json.dumps(self.snapshot, ensure_ascii=False, default=str).encode("utf-8")
            return payload, self.source

    def investigate_case(self, case_id: str) -> dict:
        with self.lock:
            idx = next((i for i, c in enumerate(self.snapshot.get("cases") or []) if c.get("case_id") == case_id), None)
            if idx is None:
                raise KeyError(f"Case {case_id!r} not found.")
            row = dict(self.snapshot["cases"][idx])
            snap_copy = self.snapshot

        # Build Case & Context outside the lock if external API calls run
        case = Case(
            mpa_id=str(row["mpa_id"]),
            mpa_name=row.get("mpa_name") or str(row["mpa_id"]),
            vessel_id=row["vessel_id"],
            vessel_name=row.get("vessel_name") if row.get("vessel_identified") is not False else None,
            flag=row.get("flag"),
            mmsi=row.get("mmsi"),
            vessel_type=row.get("vessel_type"),
            events=[dict(e) for e in (row.get("events") or [])],
        )

        gfw_token = _env("GFW_TOKEN")
        gfw = GFWClient(gfw_token) if gfw_token else SnapshotGFWAdapter(snap_copy)

        linkup_key = _env("LINKUP_API_KEY")
        if linkup_key:
            search = SearchClient(linkup_key, provider="linkup")
        else:
            search = SnapshotSearchAdapter(snap_copy)

        llm_fn, llm_endpoint = _make_databricks_llm()

        ctx = Context(
            gfw=gfw,
            window_start=row.get("window_start") or "2026-06-01",
            window_end=row.get("window_end") or "2026-11-14",
            mode=row.get("mode") or "history",
            search=search,
            llm=llm_fn,
            max_steps=8,
        )

        # Locate gaps against MPA boundary if outline exists and location is not yet annotated
        mpa_obj = next((m for m in (snap_copy.get("mpas") or []) if str(m.get("mpa_id")) == case.mpa_id), None)
        boundary = mpa_obj.get("boundary") if mpa_obj else None
        if isinstance(boundary, dict):
            for e in case.events:
                if e.get("event_type") == "gap":
                    details = dict(e.get("details") or {})
                    if "gap_start_inside" not in details:
                        details["gap_start_inside"] = geo.point_in_geometry(e.get("lon"), e.get("lat"), boundary)
                        details["gap_end_inside"] = geo.point_in_geometry(e.get("end_lon"), e.get("end_lat"), boundary)
                        e["details"] = details

        investigate(ctx, case)
        assessment = assess(ctx, case)
        brief_md, written_by = write_brief(ctx, case, assessment)

        run_id = row.get("run_id") or uuid.uuid4().hex[:12]
        mem = {"risk_score": row.get("risk_score")} if row.get("status") != "queued" else None
        updated_row = pipeline._case_row(
            ctx, case, assessment, brief_md, written_by,
            change="forced" if row.get("status") != "queued" else "new",
            mem=mem,
            fp=row.get("fingerprint") or pipeline.fingerprint(case),
            run_id=run_id,
        )
        updated_row["events"] = case.events
        updated_row["steps"] = [{"run_id": run_id, "case_id": case.case_id, **s} for s in case.steps]
        if row.get("vessel_photo"):
            updated_row["vessel_photo"] = row["vessel_photo"]
        if updated_row.get("longest_gap_hours") is None:
            updated_row["longest_gap_hours"] = longest_gap_hours(case.events)

        with self.lock:
            cases = list(self.snapshot.get("cases") or [])
            pos = next((i for i, c in enumerate(cases) if c.get("case_id") == case_id), None)
            if pos is not None:
                cases[pos] = updated_row
            else:
                cases.append(updated_row)
            cases.sort(key=lambda c: (-(int(c.get("risk_score") or 0)), str(c.get("case_id"))))
            self.snapshot["cases"] = cases

            # Recompute MPA status numbers while keeping boundaries and context intact
            all_events = [e for c in cases for e in (c.get("events") or [])]
            status_map = {s["mpa_id"]: s for s in contract.mpa_status_rows(cases, all_events)}
            new_mpas = []
            for m in self.snapshot.get("mpas") or []:
                mid = str(m["mpa_id"])
                s = status_map.get(mid)
                merged_mpa = {**m, **s} if s else dict(m)
                new_mpas.append(merged_mpa)
            new_mpas.sort(key=lambda m: (-int(m.get("top_risk_score") or 0), str(m.get("mpa_name") or "")))
            self.snapshot["mpas"] = new_mpas

            now = now_iso()
            self.snapshot["generated_at"] = now
            if isinstance(self.snapshot.get("latest_run"), dict):
                lr = dict(self.snapshot["latest_run"])
                lr["n_cases"] = len(cases)
                lr["n_investigated"] = sum(1 for c in cases if c.get("status") != "queued")
                lr["n_queued"] = sum(1 for c in cases if c.get("status") == "queued")
                lr["n_incomplete"] = sum(1 for c in cases if c.get("status") == "incomplete")
                if llm_endpoint:
                    lr["llm_endpoint"] = llm_endpoint
                self.snapshot["latest_run"] = lr

            self._persist_locked()
            return {
                "ok": True,
                "case": updated_row,
                "mpas": new_mpas,
                "latest_run": self.snapshot.get("latest_run"),
                "generated_at": now,
            }

    def sync_from_databricks(self) -> dict:
        host = _env("DATABRICKS_HOST").rstrip("/")
        token = _env("DATABRICKS_TOKEN")
        volume = _env("POSEIDON_VOLUME", "/Volumes/workspace/poseidon/exports").rstrip("/")
        if not host or not token:
            raise RuntimeError("DATABRICKS_HOST and DATABRICKS_TOKEN must be configured to sync.")
        if not host.startswith("https://"):
            host = "https://" + host
        url = f"{host}/api/2.0/fs/files{volume}/poseidon_snapshot.json"
        r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"Databricks returned HTTP {r.status_code}: {r.text[:200]}")
        data = r.json()
        if data.get("product") != "Poseidon" or not isinstance(data.get("cases"), list):
            raise RuntimeError("Downloaded Databricks export failed snapshot validation.")
        with self.lock:
            self.snapshot = data
            self.source = "export"
            self._persist_locked()
        return self.status()

    def _persist_locked(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = SNAPSHOT_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.snapshot, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(SNAPSHOT_FILE)


STORE = PoseidonStore()


class PoseidonHandler(BaseHTTPRequestHandler):
    server_version = "PoseidonPython/1.0"

    def log_message(self, format: str, *args) -> None:
        # Keep terminal logs clean and concise
        sys.stderr.write(f"[poseidon] {self.address_string()} - {format % args}\n")

    def _send_bytes(self, status: int, content_type: str, body: bytes, extra_headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, data: dict, extra_headers: dict | None = None) -> None:
        body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        headers = {"Cache-Control": "no-store", **(extra_headers or {})}
        self._send_bytes(status, "application/json; charset=utf-8", body, headers)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 65536:
            raise ValueError("Invalid request body size.")
        raw = self.rfile.read(length)
        obj = json.loads(raw.decode("utf-8"))
        if not isinstance(obj, dict):
            raise ValueError("JSON body must be an object.")
        return obj

    def do_GET(self) -> None:
        path = unquote(urlparse(self.path).path)
        if path in ("/api/status",):
            self._send_json(HTTPStatus.OK, STORE.status())
            return

        if path in ("/api/snapshot", "/data/poseidon_snapshot.json"):
            payload, src = STORE.get_snapshot_bytes()
            self._send_bytes(
                HTTPStatus.OK,
                "application/json; charset=utf-8",
                payload,
                {"Cache-Control": "no-store", "X-Poseidon-Source": src},
            )
            return

        if path == "/data/poseidon_snapshot.sample.json":
            if SAMPLE_FILE.is_file():
                self._send_bytes(HTTPStatus.OK, "application/json; charset=utf-8", SAMPLE_FILE.read_bytes(), {"Cache-Control": "no-cache"})
            else:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Sample snapshot missing."})
            return

        if path == "/data/mpa_index.json":
            if MPA_INDEX_FILE.is_file():
                self._send_bytes(HTTPStatus.OK, "application/json; charset=utf-8", MPA_INDEX_FILE.read_bytes(), {"Cache-Control": "no-cache"})
            else:
                self._send_bytes(HTTPStatus.OK, "application/json; charset=utf-8", b"[]", {"Cache-Control": "no-cache"})
            return

        # Static web files (unified under web/)
        if path in ("/", "/index.html", "/app", "/app/", "/app/index.html"):
            target = WEB_DIR / "index.html"
        else:
            rel = path.lstrip("/")
            if rel.startswith("app/"):
                rel = rel[4:]
            root = WEB_DIR
            if rel.startswith("assets/"):
                root, rel = SHARED_ASSETS_DIR, rel[len("assets/"):]
            target = (root / rel).resolve()
            if root.resolve() not in target.parents and target != root.resolve():
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden path."})
                return

        if not target.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": f"Not found: {path}"})
            return

        ctype = MIME_TYPES.get(target.suffix.lower(), "application/octet-stream")
        self._send_bytes(HTTPStatus.OK, ctype, target.read_bytes(), {"Cache-Control": "no-cache"})

    def do_POST(self) -> None:
        path = unquote(urlparse(self.path).path)
        if path == "/api/investigate":
            try:
                body = self._read_json_body()
                case_id = body.get("case_id") or body.get("caseId")
                if not isinstance(case_id, str) or not case_id.strip():
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing case_id."})
                    return
                result = STORE.investigate_case(case_id.strip())
                self._send_json(HTTPStatus.OK, result)
            except KeyError as e:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": str(e)})
            except Exception as e:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Investigation failed: {e}"})
            return

        if path == "/api/sync-databricks":
            try:
                status = STORE.sync_from_databricks()
                self._send_json(HTTPStatus.OK, {"ok": True, "status": status})
            except Exception as e:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(e)})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": f"Unknown endpoint: {path}"})


def main() -> None:
    port = int(_env("DATABRICKS_APP_PORT") or _env("PORT") or "8000")
    host = "0.0.0.0" if _env("DATABRICKS_APP_PORT") else "127.0.0.1"
    server = ThreadingHTTPServer((host, port), PoseidonHandler)
    st = STORE.status()
    print(f"Poseidon Python App listening on http://{host}:{port}/")
    print(f"Loaded snapshot ({st['source']}): {st['n_mpas']} MPAs, {st['n_cases']} cases "
          f"({st['n_complete']} completed, {st['n_llm_briefs']} LLM briefs)")
    print(f"Mode: {st['mode']} | GFW live: {st['gfw_live']} | Linkup live: {st['linkup_live']} | Databricks live: {st['databricks_live']}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Poseidon.")
        server.server_close()


if __name__ == "__main__":
    main()
