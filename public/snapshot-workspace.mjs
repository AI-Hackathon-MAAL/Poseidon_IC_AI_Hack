const eventNames = {
  gap: 'AIS reporting gap', fishing: 'Apparent fishing', encounter: 'Apparent vessel encounter',
  loitering: 'Apparent loitering', port_visit: 'Port visit'
};

function caseEvents(row) {
  const ids = Array.isArray(row.event_ids) ? new Set(row.event_ids) : null;
  return (row.events || []).filter(event => {
    if (event.case_id && event.case_id !== row.case_id) return false;
    if (event.mpa_id != null && String(event.mpa_id) !== String(row.mpa_id)) return false;
    // A later collection run can refresh an event used in an older case brief.
    if (ids) return ids.has(event.event_id);
    return !row.run_id || !event.run_id || event.run_id === row.run_id;
  });
}

function mapPoints(row, events) {
  const points = [];
  function add(lat, lon, role, label) {
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      points.push({lat, lon, role, label});
    }
  }
  const multipleGaps = events.filter(event => event.event_type === 'gap').length > 1;
  let gapNumber = 0;
  for (const event of events) {
    if (event.event_type === 'gap') {
      gapNumber++;
      const prefix = multipleGaps ? `Gap ${gapNumber} · ` : '';
      add(event.lat, event.lon, 'gap-start', prefix + 'Reported gap position');
      add(event.end_lat, event.end_lon, 'gap-end', prefix + 'Signal resumed');
    } else {
      add(event.lat, event.lon, 'event', eventNames[event.event_type] || 'Event position');
    }
  }
  if (!points.length) add(row.lat, row.lon, 'event', 'Reported case position');
  return points;
}

function period(row, events, run) {
  const times = events.flatMap(event => [event.start_time, event.end_time])
    .filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const first = row.first_event_at || times[0];
  const last = row.last_event_at || times.at(-1);
  if (first || last) return {date: first || last, endDate: last || first, periodIsWindow: false};
  const start = row.window_start || run?.window_start;
  const end = row.window_end || run?.window_end;
  return {date: start || end || '', endDate: end || start || '', periodIsWindow: Boolean(start || end)};
}

export function overlapsObservationDates(record, from, through) {
  function overlaps(start, end) {
    const first = String(start || end || '').slice(0, 10);
    const last = String(end || start || '').slice(0, 10);
    return (!from || last >= from) && (!through || first <= through);
  }
  const datedEvents = record.events?.filter(event => event.start_time || event.end_time);
  if (datedEvents?.length) return datedEvents.some(event => overlaps(event.start_time, event.end_time));
  return overlaps(record.date, record.endDate);
}

export function snapshotCatalog(data, source) {
  const sample = source === 'sample' || data.synthetic === true || data.data_source === 'sample';
  let origin = 'Databricks export';
  if (source === 'sample') origin = 'Synthetic sample';
  else if (sample) origin += ' · synthetic data';
  else if (source !== 'bundled-export' && data.data_source !== 'gfw' && data.synthetic !== false) {
    origin += ' · mixed or unknown source';
  }
  const runs = new Map((data.runs || []).map(run => [run.run_id, run]));
  if (data.latest_run) runs.set(data.latest_run.run_id, data.latest_run);

  const areas = new Map();
  for (const mpa of data.mpas) {
    const id = String(mpa.mpa_id);
    const counts = [
      [mpa.n_cases, 'tracked case'], [mpa.n_events, 'event']
    ].filter(([count]) => Number.isFinite(count)).map(([count, label]) => `${count} ${label}${count === 1 ? '' : 's'}`);
    areas.set(id, {id, name: mpa.mpa_name || id, summary: counts.join(' · ')});
  }
  const cases = data.cases.map(row => {
    const areaId = String(row.mpa_id);
    if (!areas.has(areaId)) areas.set(areaId, {id: areaId, name: row.mpa_name || areaId, summary: ''});
    const events = caseEvents(row);
    const run = runs.get(row.run_id);
    const vesselType = String(row.vessel_type || '').toLowerCase();
    const gear = vesselType === 'gear';
    const unnamed = gear && /^Unidentified vessel(?:\s*\(|$)/i.test(row.vessel_name || '');
    const vessel = row.vessel_name && !unnamed ? row.vessel_name :
      row.mmsi ? `MMSI ${row.mmsi}` : gear ? 'Unidentified gear' : 'Unidentified vessel';
    const types = new Set([...String(row.event_types || '').split(','), ...events.map(event => event.event_type)]);
    const primary = Object.keys(eventNames).find(type => types.has(type));
    const hours = row.longest_gap_hours;
    const hasGapHours = Number.isFinite(hours) && hours >= 0;
    const title = hasGapHours ? `${Number(hours.toFixed(2))}-hour AIS reporting gap` : eventNames[primary] || row.headline || vessel;
    const mode = row.mode || run?.mode;
    const modeLabel = ({history: 'Historical investigation', live: 'Live monitoring'})[mode];
    const kind = [gear ? 'Fishing gear' : null, modeLabel].filter(Boolean).join(' · ') || 'Vessel investigation';
    const level = row.risk_level;
    const priority = level && level !== 'unknown' ? level.charAt(0).toUpperCase() + level.slice(1) + ' priority' : null;
    const simulated = sample || row.data_source === 'sample' || run?.data_source === 'sample' ||
      run?.llm_endpoint === 'sample-scripted-model' || areaId.startsWith('sample-');
    return {
      id: row.case_id, areaId, title, vessel, vesselType, priority, mode, kind,
      ...period(row, events, run), datasetHours: hasGapHours ? hours : null,
      events, mapPoints: mapPoints(row, events), synthetic: simulated, snapshotCase: row
    };
  });
  return {origin, areas: [...areas.values()], cases, snapshot: data, snapshotSource: source};
}
