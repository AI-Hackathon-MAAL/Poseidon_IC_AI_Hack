"""Global intel layer: recent illegal-fishing news from the live web, placed on the map.

Placement is done by code, never by a model: an item is pinned to a watched protected area if the
text names it, else to an approximate country centre if the text names a country, else it is
left unplaced (it still appears in the feed).
"""
from __future__ import annotations

import hashlib
import re

from .agent import now_iso
from .gfw import day
from .pipeline import fold
from .search import SearchError

QUERIES = [
    "Latest news on illegal, unreported and unregulated fishing: vessels detained, seized or fined, anywhere in the world.",
    "Recent news on illegal fishing inside marine protected areas and fishing vessels switching off AIS tracking.",
    "Recent news on distant-water fishing fleets near protected waters, sanctions on fishing companies and forced labour at sea.",
]
GENERIC = {"marine", "reserve", "reserva", "marina", "national", "nacional", "parque", "protected", "protection",
           "islands", "island", "sanctuary", "monument", "world", "heritage", "natural", "mixed", "unesco",
           "biosphere", "sample", "synthetic", "archipielago", "archipelago", "conservation", "management", "special", "nature", "ocean"}
COUNTRIES = {   # approximate centres, for placing a marker only
    "argentina": (-38, -64), "australia": (-25, 134), "bangladesh": (24, 90), "brazil": (-10, -52),
    "cambodia": (12.5, 105), "canada": (56, -106), "chile": (-33, -71), "china": (35, 104),
    "colombia": (4, -73), "costa rica": (10, -84), "ecuador": (-1.5, -78.5), "falkland": (-51.7, -59),
    "fiji": (-18, 178), "france": (46.5, 2.5), "gabon": (-0.8, 11.6), "ghana": (8, -1.2),
    "guinea": (10.5, -10.7), "iceland": (65, -18), "india": (21, 78), "indonesia": (-2, 118),
    "ireland": (53, -8), "italy": (42.5, 12.5), "japan": (36, 138), "kenya": (0.2, 37.9),
    "kiribati": (1.4, 173), "liberia": (6.4, -9.4), "madagascar": (-19, 47), "malaysia": (4, 109),
    "mauritania": (20, -10.5), "mauritius": (-20.3, 57.5), "mexico": (23, -102), "micronesia": (7, 158),
    "morocco": (32, -6), "mozambique": (-18, 35), "namibia": (-22, 17), "new zealand": (-41, 174),
    "nigeria": (9, 8), "norway": (62, 10), "oman": (21, 57), "pakistan": (30, 69), "palau": (7.5, 134.5),
    "panama": (8.5, -80), "papua new guinea": (-6, 145), "peru": (-10, -76), "philippines": (13, 122),
    "portugal": (39.5, -8), "russia": (60, 100), "senegal": (14.5, -14.5), "seychelles": (-4.7, 55.5),
    "sierra leone": (8.5, -11.8), "solomon islands": (-9.5, 160), "somalia": (6, 46), "south africa": (-30, 25),
    "south korea": (36.5, 128), "spain": (40, -4), "sri lanka": (7.8, 80.7), "taiwan": (23.7, 121),
    "tanzania": (-6.5, 35), "thailand": (15, 101), "tonga": (-21.2, -175.2), "united kingdom": (54, -2),
    "united states": (39, -98), "uruguay": (-33, -56), "vanuatu": (-16, 167), "vietnam": (16, 107.5),
    "galapagos": (-0.6, -90.6),
}


def _tokens(name):
    return [t for t in fold(name).replace("-", " ").replace("(", " ").replace(")", " ").split()
            if len(t) >= 5 and t not in GENERIC]


def place(text, areas):
    """areas: [{mpa_id, mpa_name, center_lat, center_lon}]. Returns placement fields for one news item."""
    t = fold(text)
    for a in areas:
        if a.get("center_lat") is None:
            continue
        if any(re.search(rf"\b{re.escape(tok)}\b", t) for tok in _tokens(a["mpa_name"])):
            return {"place_type": "mpa", "place_name": a["mpa_name"], "mpa_id": a["mpa_id"],
                    "lat": a["center_lat"], "lon": a["center_lon"]}
    for country, (lat, lon) in COUNTRIES.items():
        if re.search(rf"\b{re.escape(country)}\b", t):
            return {"place_type": "country", "place_name": country.title(), "mpa_id": None, "lat": lat, "lon": lon}
    return {"place_type": "none", "place_name": None, "mpa_id": None, "lat": None, "lon": None}


def global_news(search, areas, window_end, mode="live", window_start=None, run_id=None, log=print):
    """Runs the worldwide searches and returns rows for the `global_news` table."""
    if search is None:
        return []
    from_date = day(window_end, -45) if mode == "live" else window_start
    rows, seen = [], set()
    for query in QUERIES:
        try:
            res = search.search(query, from_date=from_date, max_results=8)
        except SearchError as e:
            log(f"[intel] search failed: {e}")
            continue
        for s in res["sources"]:
            if s["url"] in seen:
                continue
            seen.add(s["url"])
            rows.append({"news_id": hashlib.sha1(s["url"].encode()).hexdigest()[:16], "title": s["title"],
                         "url": s["url"], "snippet": s["snippet"], "query": query, "from_date": from_date,
                         "provider": res["provider"], "fetched_at": now_iso(), "run_id": run_id,
                         **place(f"{s['title']} {s['snippet']}", areas)})
    log(f"[intel] {len(rows)} global news item(s), {sum(r['place_type'] != 'none' for r in rows)} placed on the map")
    return rows
