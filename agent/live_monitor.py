"""Latest-available GFW monitoring; never interprets absent events as compliance."""
from datetime import datetime, timedelta, timezone
import requests

BASE = 'https://gateway.api.globalfishingwatch.org/v3'
DATASETS = {kind: f'public-global-{name}-events:latest' for kind, name in
            [('gap', 'gaps'), ('fishing', 'fishing'), ('encounter', 'encounters'), ('loitering', 'loitering')]}

class GFWClient:
    def __init__(self, token):
        if not token:
            raise ValueError('Configure hackathon/gfw_token in Databricks secrets')
        self.session = requests.Session()
        self.session.headers.update({'Authorization': f'Bearer {token}'})

    def mpas(self):
        r = self.session.get(f'{BASE}/datasets/public-mpa-all/context-layers', timeout=60)
        r.raise_for_status()
        d = r.json()
        return d if isinstance(d, list) else d.get('entries', d.get('data', []))

    def events(self, kind, mpa_id, start, end, max_pages=500):
        body = {'datasets': [DATASETS[kind]], 'startDate': start, 'endDate': end,
                'region': {'dataset': 'public-mpa-all', 'id': int(mpa_id) if str(mpa_id).isdigit() else mpa_id}}
        rows, offset, seen = [], 0, set()
        for _ in range(max_pages):
            if offset in seen:
                raise RuntimeError('GFW pagination repeated an offset; refusing partial results')
            seen.add(offset)
            r = self.session.post(f'{BASE}/events', params={'offset': offset, 'limit': 200}, json=body, timeout=60)
            r.raise_for_status()
            d = r.json()
            entries = d.get('entries', [])
            rows.extend(entries)
            nxt = d.get('nextOffset')
            if nxt is None:
                if int(d.get('total', len(rows))) > len(rows):
                    raise RuntimeError('Incomplete GFW response without nextOffset')
                return rows
            if not entries:
                raise RuntimeError('Empty GFW page with nextOffset')
            offset = nxt
        raise RuntimeError('GFW pagination limit reached; shorten lookback')


def window(days=30, now=None):
    if not 1 <= days <= 365:
        raise ValueError('lookback_days must be between 1 and 365')
    now = now or datetime.now(timezone.utc)
    return (now - timedelta(days=days)).isoformat(), now.isoformat()


def flatten(event, kind, mpa_id, mpa_name):
    vessel = event.get('vessel') or {}
    pos = (event.get('gap') or {}).get('offPosition') or event.get('position') or {}
    start, end = event.get('start'), event.get('end')
    duration = None
    if start and end:
        duration = (datetime.fromisoformat(end.replace('Z', '+00:00')) -
                    datetime.fromisoformat(start.replace('Z', '+00:00'))).total_seconds() / 3600
    if not event.get('id'):
        raise ValueError('GFW event is missing its id')
    return dict(event_id=str(event['id']), event_type=kind, mpa_id=str(mpa_id), mpa_name=mpa_name,
                vessel_id=vessel.get('id'), vessel_name=vessel.get('name'), flag=vessel.get('flag'),
                mmsi=vessel.get('ssvid'), start_time=start, end_time=end, duration_hours=duration,
                lat=pos.get('lat'), lon=pos.get('lon'), source='gfw')


def assess(events, gap_hours=12):
    if gap_hours <= 0:
        raise ValueError('gap_hours must be positive')
    gaps = [e for e in events if e['event_type'] == 'gap']
    if any(e.get('duration_hours') is not None and e['duration_hours'] >= gap_hours for e in gaps):
        return 'flagged_for_review'
    if any(e.get('duration_hours') is None for e in gaps):
        return 'insufficient_data'
    return 'no_qualifying_gap_found'
