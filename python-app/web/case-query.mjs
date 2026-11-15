import {overlapsObservationDates} from './snapshot-workspace.mjs';

function searchable(value) {
  return String(value ?? '').normalize('NFKD').toLowerCase()
    .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function caseText(record, areaName) {
  const row = record.snapshotCase || {};
  return searchable([
    record.id, record.vessel, record.vesselType, row.mmsi && 'MMSI ' + row.mmsi,
    row.imo && 'IMO ' + row.imo, row.callsign, row.vessel_id, row.flag, row.owner, areaName, row.mpa_name,
    record.title, row.event_types, record.kind, record.priority, row.status,
    ...(record.events || []).map(event => event.event_type)
  ].filter(Boolean).join(' '));
}

/** Keep the notebook ranking and match only the cases visible to these filters. */
export function queryCases(catalog, {areaId = '', search = '', status = '', from = '', through = '', mode = ''} = {}) {
  if (from && through && from > through) return [];
  const terms = searchable(search).split(' ').filter(Boolean);
  const names = new Map(catalog.areas.map(area => [String(area.id), area.name]));
  return catalog.cases.filter(record => {
    if (areaId && String(record.areaId) !== String(areaId)) return false;
    if (status && record.snapshotCase?.status !== status) return false;
    if (mode && record.mode !== mode) return false;
    if ((from || through) && !overlapsObservationDates(record, from, through)) return false;
    if (!terms.length) return true;
    const text = caseText(record, names.get(String(record.areaId)));
    return terms.every(term => text.includes(term));
  });
}

export function queueStats(records) {
  const events = new Set();
  const areas = new Set();
  const stats = {cases: records.length, events: 0, complete: 0, queued: 0, incomplete: 0, areas: 0};
  for (const record of records) {
    areas.add(record.areaId);
    const status = record.snapshotCase?.status;
    if (status === 'complete' || status === 'queued' || status === 'incomplete') stats[status]++;
    for (const event of record.events || []) {
      if (event.event_id != null) events.add(JSON.stringify([record.areaId, event.event_id]));
      else stats.events++;
    }
  }
  stats.events += events.size;
  stats.areas = areas.size;
  return stats;
}

export function contextPoints(records) {
  return records.flatMap(record => {
    const status = record.snapshotCase?.status || 'unknown';
    const riskLevel = status === 'queued' ? 'unknown' : (record.snapshotCase?.risk_level || 'unknown');
    const riskScore = record.snapshotCase?.risk_score;
    return (record.mapPoints || []).map(point => ({
      ...point, caseId: record.id, areaId: record.areaId, status, riskLevel, riskScore
    }));
  });
}

function identity(record) {
  const row = record.snapshotCase || {};
  const id = String(row.vessel_id ?? '').trim();
  const mmsi = String(row.mmsi ?? '').trim();
  return {
    id: /^(?:none|null|unknown|n\/a|0)?$/i.test(id) ? '' : id,
    mmsi: /^\d{9}$/.test(mmsi) && mmsi !== '000000000' ? mmsi : '',
    gear: String(record.vesselType || row.vessel_type || '').toLowerCase() === 'gear'
  };
}

function observationOrder(a, b) {
  const dateA = Date.parse(a.markerTime), dateB = Date.parse(b.markerTime);
  const timeA = Number.isFinite(dateA) ? dateA : -Infinity;
  const timeB = Number.isFinite(dateB) ? dateB : -Infinity;
  if (timeA !== timeB) return timeA > timeB ? -1 : 1;
  const fields = ['eventId', 'eventType', 'role', 'caseId', 'lat', 'lon', 'label'];
  for (const field of fields) {
    const left = String(a[field] ?? ''), right = String(b[field] ?? '');
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Keep GFW identities separate even when an MMSI is reused by several tracked objects. */
export function groupVessels(cases, positions = contextPoints(cases), identityCases = cases) {
  const lookup = new Map();
  const idsByMmsi = new Map();
  for (const record of identityCases) {
    const ref = identity(record);
    lookup.set(record.id, ref);
    if (ref.id && ref.mmsi) {
      if (!idsByMmsi.has(ref.mmsi)) idsByMmsi.set(ref.mmsi, new Set());
      idsByMmsi.get(ref.mmsi).add(ref.id);
    }
  }

  const groups = new Map(), groupByCase = new Map();
  for (const record of cases) {
    const {id, mmsi, gear} = lookup.get(record.id) || identity(record);
    const matches = idsByMmsi.get(mmsi);
    const resolvedId = id || (matches?.size === 1 ? [...matches][0] : '');
    let vesselKey = 'case:' + record.id;
    if (resolvedId) vesselKey = 'vessel:' + resolvedId;
    else if (mmsi && !matches?.size) vesselKey = 'mmsi:' + mmsi;
    if (!groups.has(vesselKey)) {
      groups.set(vesselKey, {vesselKey, vesselName:'', vesselType:'', isGear:false, cases:[], points:[], anchor:null});
    }
    const group = groups.get(vesselKey);
    group.cases.push(record);
    group.isGear ||= gear;
    groupByCase.set(record.id, group);
  }
  for (const point of positions) {
    const group = groupByCase.get(point.caseId);
    if (!group || !Number.isFinite(point.lon) || Math.abs(point.lon) > 180 ||
        !Number.isFinite(point.lat) || Math.abs(point.lat) > 90) continue;
    const markerTime = point.markerTime || (point.role === 'gap-end' ? point.endTime : point.startTime);
    group.points.push({...point, markerTime, vesselKey:group.vesselKey});
  }
  for (const group of groups.values()) {
    group.points.sort(observationOrder);
    const seen = new Set();
    group.points = group.points.filter(point => {
      if (point.eventId == null || point.eventId === '') return true;
      const identity = JSON.stringify([point.eventType,point.eventId,point.role]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    group.anchor = group.points.find(point => Number.isFinite(Date.parse(point.markerTime))) || null;
    const latestCase = group.cases.find(record => record.id === group.anchor?.caseId) || group.cases[0];
    const records = [latestCase, ...group.cases.filter(record => record !== latestCase)];
    const named = records.find(record => record.vessel && !/^(?:unidentified\b|mmsi\s)/i.test(record.vessel));
    group.vesselName = named?.vessel || latestCase.vessel || (group.isGear ? 'Unidentified gear' : 'Unidentified vessel');
    group.vesselType = group.isGear ? 'gear' : records.find(record => record.vesselType)?.vesselType || '';
    for (const point of group.points) {
      point.vesselName = group.vesselName;
      point.vesselType = group.vesselType;
    }
  }
  return [...groups.values()];
}
