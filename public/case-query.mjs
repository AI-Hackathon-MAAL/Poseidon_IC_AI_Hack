import {overlapsObservationDates} from './snapshot-workspace.mjs';

function searchable(value) {
  return String(value ?? '').normalize('NFKD').toLowerCase()
    .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function caseText(record, areaName) {
  const row = record.snapshotCase || {};
  return searchable([
    record.id, record.vessel, record.vesselType, row.mmsi && 'MMSI ' + row.mmsi,
    row.imo && 'IMO ' + row.imo, row.callsign, row.vessel_id, areaName, row.mpa_name,
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
  return records.flatMap(record => (record.mapPoints || []).map(point => ({
    ...point, caseId: record.id, areaId: record.areaId, riskLevel: record.snapshotCase?.risk_level || 'unknown'
  })));
}
