"""Protected-area outlines for the map.

Global Fishing Watch region ids for `public-mpa-all` are World Database on Protected Areas ids
(11753 = Galápagos Marine Reserve), so an outline can come from either source. Shapes are
simplified hard: they are for drawing on a globe, not for measuring.

Boundary data: UNEP-WCMC and IUCN, Protected Planet: The World Database on Protected Areas (WDPA).
"""
from __future__ import annotations

import requests

WDPA_LAYERS = [
    "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/FeatureServer/1/query",
    "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/FeatureServer/0/query",
]
WDPA_ID_FIELDS = ["WDPAID", "SITE_ID"]   # the id column was renamed in newer WDPA releases


def _polygons(obj):
    """Any GeoJSON-ish object -> list of polygons (each a list of rings)."""
    if not isinstance(obj, dict):
        return []
    kind = obj.get("type")
    if kind == "FeatureCollection":
        return [p for f in obj.get("features") or [] for p in _polygons(f)]
    if kind == "Feature" or ("geometry" in obj and kind not in ("Polygon", "MultiPolygon")):
        return _polygons(obj.get("geometry"))
    if kind == "Polygon":
        return [obj.get("coordinates") or []]
    if kind == "MultiPolygon":
        return list(obj.get("coordinates") or [])
    if kind == "GeometryCollection":
        return [p for g in obj.get("geometries") or [] for p in _polygons(g)]
    return []


def _simplify_ring(ring, tol):
    """Douglas-Peucker (iterative) on a closed ring of [lon, lat] points."""
    pts = [(float(p[0]), float(p[1])) for p in ring if isinstance(p, (list, tuple)) and len(p) >= 2]
    if len(pts) <= 4:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        (x1, y1), (x2, y2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = -1.0, None
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm if norm else ((px - x1) ** 2 + (py - y1) ** 2) ** 0.5
            if d > best:
                best, idx = d, i
        if best > tol and idx is not None:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def _ring_area(ring):
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:]))) / 2


def simplify_geometry(obj, max_points=400, max_parts=40):
    """Returns a small GeoJSON MultiPolygon (outer rings only), or None if there is no polygon."""
    outers = [poly[0] for poly in _polygons(obj) if poly and poly[0]]
    if not outers:
        return None
    xs = [float(p[0]) for r in outers for p in r]
    ys = [float(p[1]) for r in outers for p in r]
    tol = max(max(xs) - min(xs), max(ys) - min(ys), 0.01) / 2000
    rings = []
    for _ in range(14):
        rings = [r for r in (_simplify_ring(o, tol) for o in outers) if len(r) >= 4]
        rings.sort(key=_ring_area, reverse=True)
        rings = rings[:max_parts]
        if sum(len(r) for r in rings) <= max_points:
            break
        tol *= 2
    if not rings:
        return None
    return {"type": "MultiPolygon",
            "coordinates": [[[[round(x, 4), round(y, 4)] for x, y in r]] for r in rings]}


def bbox_and_center(geometry):
    """bbox [west, south, east, north] and centre. For an area that crosses the antimeridian the
    east edge is given beyond 180 (e.g. [177, 19, 199, 32]) so map libraries can fit it."""
    pts = [p for poly in geometry["coordinates"] for ring in poly for p in ring]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    if max(xs) - min(xs) > 180:   # crosses the antimeridian: measure in 0..360
        xs = [x + 360 if x < 0 else x for x in xs]
    bbox = [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)]
    lon = (bbox[0] + bbox[2]) / 2
    return bbox, round((bbox[1] + bbox[3]) / 2, 4), round(lon - 360 if lon > 180 else lon, 4)


def point_in_geometry(lon, lat, geometry):
    """True if the point is inside any polygon of a (simplified) MultiPolygon. None if unknown."""
    if geometry is None or lon is None or lat is None:
        return None
    try:
        lon, lat = float(lon), float(lat)
    except (TypeError, ValueError):
        return None
    for poly in geometry.get("coordinates") or []:
        ring, inside = poly[0], False
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
                inside = not inside
        if inside:
            return True
    return False


def fetch_boundary(mpa_id, gfw=None, session=None, timeout=60):
    """Try each source in turn. Returns {"geometry", "bbox", "center_lat", "center_lon", "source"} or
    {"geometry": None, "source": None, "error": "..."} when no outline could be found."""
    errors = []
    if gfw is not None:
        try:
            geom = simplify_geometry(gfw._request("GET", f"/datasets/public-mpa-all/context-layers/{mpa_id}"))
            if geom:
                bbox, lat, lon = bbox_and_center(geom)
                return {"geometry": geom, "bbox": bbox, "center_lat": lat, "center_lon": lon,
                        "source": "Global Fishing Watch"}
            errors.append("GFW returned no polygon")
        except Exception as e:
            errors.append(f"GFW: {str(e)[:100]}")
    if str(mpa_id).isdigit():
        session = session or requests.Session()
        for url in WDPA_LAYERS:
            for field in WDPA_ID_FIELDS:
                try:
                    r = session.get(url, timeout=timeout, params={
                        "where": f"{field}={int(mpa_id)}", "outFields": field, "f": "geojson",
                        "outSR": 4326, "maxAllowableOffset": 0.01, "geometryPrecision": 4})
                    if r.status_code >= 400:
                        errors.append(f"WDPA HTTP {r.status_code}")
                        continue
                    geom = simplify_geometry(r.json())
                    if geom:
                        bbox, lat, lon = bbox_and_center(geom)
                        return {"geometry": geom, "bbox": bbox, "center_lat": lat, "center_lon": lon,
                                "source": "WDPA (UNEP-WCMC and IUCN, Protected Planet)"}
                except Exception as e:
                    errors.append(f"WDPA: {str(e)[:100]}")
    return {"geometry": None, "source": None, "error": "; ".join(errors[-3:]) or "no source available"}
