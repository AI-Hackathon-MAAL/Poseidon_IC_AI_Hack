const gateway = 'https://gateway.api.globalfishingwatch.org/v3/';
const identitySource = {
  id: 'gfw-live-identity',
  title: 'GFW live self-reported vessel identity lookup',
  url: 'https://globalfishingwatch.org/our-apis/documentation/docs/v3/vessels/search'
};
const historySource = {
  id: 'gfw-live-history',
  title: 'GFW live historical event lookup',
  url: 'https://globalfishingwatch.org/our-apis/documentation/docs/v3/events/get-all-events'
};
const unavailable = detail => ({ mode: 'unavailable', detail, sources: [], observations: [] });

async function request(path, parameters, token, fetcher) {
  const url = new URL(path, gateway);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(6000)
  });
  if (!response.ok) throw new Error('GFW request failed');
  if (Number(response.headers.get('content-length')) > 524288) throw new Error('Oversized GFW result');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 524288) throw new Error('Oversized GFW result');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function matchedIdentity(result, mmsi, eventDate) {
  if (!Array.isArray(result.entries) || result.entries.length >= 50 || Number(result.total) > result.entries.length || result.nextOffset || result.next || result.nextSince || result.since) return null;
  const matches = new Map();
  for (const entry of result.entries) {
    for (const info of entry.selfReportedInfo || []) {
      const id = info.id || entry.id;
      const first = Date.parse(info.transmissionDateFrom || info.firstTransmissionDate);
      const last = Date.parse(info.transmissionDateTo || info.lastTransmissionDate);
      if (String(info.ssvid) === mmsi && typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id) && first <= eventDate && last >= eventDate) matches.set(id, info);
    }
  }
  if (matches.size !== 1) return null;
  return [...matches.entries()][0];
}

export async function vesselHistory(record, options = {}) {
  const env = options.env || process.env;
  if (env.GFW_LIVE !== '1' || !env.GFW_TOKEN) return unavailable('Live GFW history is not configured.');
  const mmsi = String(record.mmsi || record.ssvid || '').trim();
  const eventDate = Date.parse(record.start || record.date);
  if (!/^\d{9}$/.test(mmsi) || !Number.isFinite(eventDate)) return unavailable('A verified MMSI and event date are required for history lookup.');
  const fetcher = options.fetch || globalThis.fetch;
  let identity;
  try {
    const result = await request('vessels/search', {
      'datasets[0]': 'public-global-vessel-identity:latest', query: mmsi, limit: 50
    }, env.GFW_TOKEN, fetcher);
    identity = matchedIdentity(result, mmsi, eventDate);
  } catch {
    return unavailable('GFW identity lookup could not be verified.');
  }
  if (!identity) return unavailable('GFW returned no unique identity covering this event date. No vessel history was attached.');
  const [vesselId] = identity;
  const observations = [{
    date: record.start || record.date,
    text: `A live GFW identity lookup returned one AIS self-reported identity for MMSI ${mmsi} covering this event date. This is an identifier match that requires independent registry verification.`,
    sourceIds: [identitySource.id]
  }];
  const sources = [identitySource];
  let failed = false;
  const from = new Date(eventDate - 30 * 86400000);
  const endDate = new Date(eventDate).toISOString().slice(0, 10);
  for (const [dataset, type, label] of [
    ['public-global-port-visits-events:latest', 'port_visit', 'apparent port visit'],
    ['public-global-encounters-events:latest', 'encounter', 'apparent encounter']
  ]) {
    try {
      const result = await request('events', {
        'datasets[0]': dataset, 'vessels[0]': vesselId,
        'start-date': from.toISOString().slice(0, 10), 'end-date': endDate,
        limit: 10, offset: 0
      }, env.GFW_TOKEN, fetcher);
      if (!Array.isArray(result.entries)) throw new Error('Invalid events');
      const seen = new Set();
      for (const event of result.entries.slice(0, 10)) {
        const start = Date.parse(event.start);
        const end = Date.parse(event.end);
        const typeMatches = String(event.type).toLowerCase().replace(/-/g, '_') === type;
        const linked = event.vessel?.id === vesselId || event.vessels?.some(vessel => vessel.id === vesselId);
        if (!typeMatches || !linked || !event.id || seen.has(event.id) || !Number.isFinite(start) || !Number.isFinite(end) || start < from.valueOf() || end >= eventDate || start > end) continue;
        seen.add(event.id);
        observations.push({
          date: event.start,
          text: `GFW returned an ${label} beginning at ${event.start} in the preceding 30 days. The event alone carries no finding of misconduct.`,
          sourceIds: [historySource.id]
        });
      }
    } catch { failed = true; }
  }
  if (observations.length > 1) sources.push(historySource);
  return {
    mode: 'live', sources, observations,
    detail: failed ? 'Identity matched; historical event retrieval was incomplete. No missing events were inferred.' : 'Identity matched; up to 10 port visits and 10 encounters were checked in the preceding 30 days. Results are a bounded sample.'
  };
}
