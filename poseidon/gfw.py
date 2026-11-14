"""Global Fishing Watch API v3 client used by every Poseidon mode.

Data (c) Global Fishing Watch. Non-commercial use, attribution required.
Detections are "apparent": treat every result as a lead, never as proof.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import requests

BASE = "https://gateway.api.globalfishingwatch.org/v3"
MPA_DATASET = "public-mpa-all"
IDENTITY_DATASET = "public-global-vessel-identity:latest"
EVENT_DATASETS = {
    "gap": "public-global-gaps-events:latest",            # AIS switched off (GFW publishes likely-intentional gaps of 12h+)
    "fishing": "public-global-fishing-events:latest",
    "encounter": "public-global-encounters-events:latest",
    "loitering": "public-global-loitering-events:latest",
    "port_visit": "public-global-port-visits-events:latest",
}
REGION_EVENT_TYPES = ("gap", "fishing", "encounter", "loitering")


class GFWError(RuntimeError):
    pass


def parse_time(value):
    """ISO string (or datetime) -> aware UTC datetime, or None."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip().replace("Z", "+00:00")
    if " " in text and "T" not in text:
        text = text.replace(" ", "T", 1)
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def day(value, offset_days=0):
    """Any time value -> 'YYYY-MM-DD' (optionally shifted)."""
    dt = parse_time(value)
    if dt is None:
        raise ValueError(f"Not a date: {value!r}")
    return (dt + timedelta(days=offset_days)).strftime("%Y-%m-%d")


def resolve_window(mode, start_date=None, end_date=None, lookback_days=30, now=None):
    """The only difference between Poseidon's two modes is the time window.

    history: the fixed start_date..end_date the user chose.
    live:    the last `lookback_days` days up to now (recomputed every run).
    """
    now = now or datetime.now(timezone.utc)
    if mode == "live":
        days = int(lookback_days)
        if not 1 <= days <= 365:
            raise ValueError("lookback_days must be between 1 and 365")
        return day(now, -days), day(now, 1)
    if mode == "history":
        start, end = day(start_date), day(end_date)
        if start >= end:
            raise ValueError("start_date must be before end_date")
        return start, end
    raise ValueError("mode must be 'history' or 'live'")


class GFWClient:
    def __init__(self, token, session=None, timeout=60, max_retries=3, sleep=time.sleep):
        if not token:
            raise ValueError("Missing Global Fishing Watch token (Databricks secret hackathon/gfw_token)")
        self.session = session or requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {token}"})
        self.timeout, self.max_retries, self._sleep = timeout, max_retries, sleep
        self.calls = 0

    def _request(self, method, path, **kwargs):
        last = "no attempt made"
        for attempt in range(self.max_retries + 1):
            self.calls += 1
            try:
                r = self.session.request(method, f"{BASE}{path}", timeout=self.timeout, **kwargs)
            except requests.RequestException as e:
                last = f"network error: {e}"
            else:
                if r.status_code == 429 or r.status_code >= 500:
                    last = f"HTTP {r.status_code}"
                elif r.status_code >= 400:
                    raise GFWError(f"GFW {method} {path} -> HTTP {r.status_code}: {r.text[:200]}")
                else:
                    return r.json()
            if attempt < self.max_retries:
                self._sleep(2 * (attempt + 1))
        raise GFWError(f"GFW {method} {path} failed after {self.max_retries + 1} attempts ({last})")

    # ---- protected areas
    def mpas(self):
        d = self._request("GET", f"/datasets/{MPA_DATASET}/context-layers")
        return d if isinstance(d, list) else d.get("entries", d.get("data", []))

    # ---- events
    def _events_body(self, kind, start, end, mpa_id=None, vessel_id=None):
        body = {"datasets": [EVENT_DATASETS[kind]], "startDate": start, "endDate": end}
        if mpa_id is not None:
            body["region"] = {"dataset": MPA_DATASET, "id": int(mpa_id) if str(mpa_id).isdigit() else mpa_id}
        if vessel_id:
            body["vessels"] = [vessel_id]
        return body

    def events(self, kind, start, end, mpa_id=None, vessel_id=None, page_size=200, max_pages=50):
        """Returns (events, complete). complete=False means pagination stopped early."""
        body = self._events_body(kind, start, end, mpa_id, vessel_id)
        rows, offset = [], 0
        for _ in range(max_pages):
            d = self._request("POST", "/events", params={"offset": offset, "limit": page_size}, json=body)
            entries = d.get("entries") or []
            rows.extend(entries)
            nxt = d.get("nextOffset")
            if nxt is None or not entries:
                return rows, True
            if nxt == offset:
                return rows, False
            offset = nxt
        return rows, False

    def count_events(self, kind, start, end, vessel_id):
        d = self._request("POST", "/events", params={"offset": 0, "limit": 1},
                          json=self._events_body(kind, start, end, vessel_id=vessel_id))
        total = d.get("total")
        return int(total) if total is not None else len(d.get("entries") or [])

    # ---- vessels
    def vessel(self, vessel_id):
        return self._request("GET", f"/vessels/{vessel_id}", params={"dataset": IDENTITY_DATASET})

    def search_vessels(self, query, limit=5):
        d = self._request("GET", "/vessels/search",
                          params={"query": query, "datasets[0]": IDENTITY_DATASET,
                                  "includes[0]": "OWNERSHIP", "limit": limit})
        return d.get("entries") or []


# --------------------------------------------------------------------------- shaping

def _hours(start, end):
    a, b = parse_time(start), parse_time(end)
    return round((b - a).total_seconds() / 3600, 2) if a and b else None


def flatten_event(event, kind, mpa_id=None, mpa_name=None):
    """One GFW event -> one flat row (see docs/backend.md, table `events`)."""
    vessel = event.get("vessel") or {}
    gap = event.get("gap") or {}
    off, on = gap.get("offPosition") or {}, gap.get("onPosition") or {}
    pos = event.get("position") or {}
    regions = event.get("regions") or {}
    fishing = event.get("fishing") or {}
    partner = (event.get("encounter") or {}).get("vessel") or {}
    visit = event.get("port_visit") or event.get("portVisit") or {}
    anchorage = visit.get("intermediateAnchorage") or visit.get("startAnchorage") or {}
    details = {
        "gap_distance_km": gap.get("distanceKm"),
        "gap_implied_speed_knots": gap.get("impliedSpeedKnots"),
        "in_no_take_mpa": bool(regions.get("mpaNoTake")),
        "in_partial_no_take_mpa": bool(regions.get("mpaNoTakePartial")),
        "mpa_ids": [str(x) for x in (regions.get("mpa") or [])][:20],
        "eez": [str(x) for x in (regions.get("eez") or [])][:5],
        "potential_risk": fishing.get("potentialRisk"),
        "authorization_status": fishing.get("vesselPublicAuthorizationStatus"),
        "partner_vessel_id": partner.get("id"),
        "partner_vessel_name": partner.get("name"),
        "partner_vessel_flag": partner.get("flag"),
        "partner_vessel_type": partner.get("type"),
        "port_name": anchorage.get("name") or anchorage.get("topDestination"),
        "port_flag": anchorage.get("flag"),
        "distance_from_shore_km": (event.get("distances") or {}).get("startDistanceFromShoreKm"),
    }
    return {
        "event_id": str(event.get("id")),
        "event_type": kind,
        "mpa_id": None if mpa_id is None else str(mpa_id),
        "mpa_name": mpa_name,
        "vessel_id": vessel.get("id"),
        "vessel_name": vessel.get("name") or None,
        "mmsi": vessel.get("ssvid"),
        "flag": vessel.get("flag"),
        "vessel_type": vessel.get("type"),
        "start_time": event.get("start"),
        "end_time": event.get("end"),
        "duration_hours": _hours(event.get("start"), event.get("end")),
        "lat": off.get("lat", pos.get("lat")),
        "lon": off.get("lon", pos.get("lon")),
        "end_lat": on.get("lat"),
        "end_lon": on.get("lon"),
        "details": {k: v for k, v in details.items() if v not in (None, [], False)},
    }


def _uniq(values):
    out = []
    for v in values:
        if v and v not in out:
            out.append(v)
    return out


def summarize_identity(record):
    """GFW vessel identity record -> the few fields an investigator needs."""
    record = record or {}
    self_rep = record.get("selfReportedInfo") or []
    # Single-vessel responses carry an object; vessel searches can return a list.
    if isinstance(self_rep, dict):
        self_rep = [self_rep]
    registry = record.get("registryInfo") or []
    owners = record.get("registryOwners") or []
    combined = record.get("combinedSourcesInfo") or []
    auths = record.get("registryPublicAuthorizations") or record.get("registryAuthorizations") or []

    def names_of(items, key):
        return [i.get(key) for i in items if isinstance(i, dict)]

    gear, ship = [], []
    for c in combined:
        gear += [g.get("name") if isinstance(g, dict) else g for g in (c.get("geartypes") or [])]
        ship += [s.get("name") if isinstance(s, dict) else s for s in (c.get("shiptypes") or [])]
    for r in registry:
        gear += [g for g in (r.get("geartypes") or []) if isinstance(g, str)]
    return {
        "names": _uniq(names_of(registry, "shipname") + names_of(self_rep, "shipname")),
        "flags": _uniq(names_of(registry, "flag") + names_of(self_rep, "flag")),
        "mmsis": _uniq(names_of(registry, "ssvid") + names_of(self_rep, "ssvid")),
        "imo": next(iter(_uniq(names_of(registry, "imo") + names_of(self_rep, "imo"))), None),
        "callsign": next(iter(_uniq(names_of(registry, "callsign") + names_of(self_rep, "callsign"))), None),
        "owners": _uniq([o.get("name") for o in owners if isinstance(o, dict)]),
        "owner_flags": _uniq([o.get("flag") for o in owners if isinstance(o, dict)]),
        "gear_types": _uniq(gear),
        "ship_types": _uniq(ship),
        "authorizations": _uniq([a.get("sourceCode") if isinstance(a.get("sourceCode"), str)
                                 else ", ".join(a.get("sourceCode") or []) for a in auths if isinstance(a, dict)]),
        "registry_records": len(registry),
        "ais_identities": len(self_rep),
    }
