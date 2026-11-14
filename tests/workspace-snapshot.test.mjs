import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {overlapsObservationDates, snapshotCatalog} from '../public/snapshot-workspace.mjs';

test('the original workspace can select every vessel and both areas in the notebook fixture', async () => {
  const data = JSON.parse(await readFile(new URL('../data/poseidon_snapshot.sample.json', import.meta.url), 'utf8'));
  const catalog = snapshotCatalog(data, 'sample');
  assert.equal(catalog.snapshot, data);
  assert.equal(catalog.snapshotSource, 'sample');
  assert.equal(catalog.origin, 'Synthetic sample');
  assert.deepEqual(catalog.areas.map(area => area.id), data.mpas.map(area => area.mpa_id));
  assert.deepEqual(catalog.cases.map(row => row.id), data.cases.map(row => row.case_id));
  const dark = catalog.cases.find(row => row.datasetHours === 100);
  assert.equal(dark.snapshotCase, data.cases.find(row => row.case_id === dark.id));
  assert.equal(dark.title, '100-hour AIS reporting gap');
  assert.equal(dark.priority, 'High priority');
  assert.deepEqual(dark.mapPoints.map(point => point.role), ['gap-start', 'gap-end']);
  assert.ok(catalog.cases.every(row => row.synthetic && row.date && row.endDate));
  assert.match(snapshotCatalog(data, 'export').origin, /synthetic/i);
});

test('sparse mixed exports use case-specific windows, mode and provenance across runs', () => {
  const data = {
    data_source: 'unknown', mpas: [{mpa_id: 20, mpa_name: 'Reserve'}],
    latest_run: {run_id: 'new', mode: 'live', data_source: 'gfw', window_start: '2026-11-04', window_end: '2026-11-14'},
    runs: [{run_id: 'old', mode: 'history', data_source: 'sample', window_start: '2003-01-01', window_end: '2004-12-31'}],
    cases: [
      {case_id: 'queued', mpa_id: 20, run_id: 'new', mmsi: '001', status: 'queued'},
      {case_id: 'historic', mpa_id: '21', mpa_name: 'Another reserve', run_id: 'old', events: [
        {event_type: 'fishing', start_time: '2004-01-01', lat: 0, lon: 0},
        {event_type: 'gap', start_time: '2003-02-12', end_time: '2003-02-13', lat: null, lon: 18, end_lat: 1, end_lon: 5}
      ]}
    ]
  };
  const catalog = snapshotCatalog(data, 'export');
  const [queued, historic] = catalog.cases;
  assert.equal(queued.areaId, '20');
  assert.equal(queued.vessel, 'MMSI 001');
  assert.equal(queued.kind, 'Live monitoring');
  assert.equal(queued.date, '2026-11-04');
  assert.equal(queued.endDate, '2026-11-14');
  assert.equal(queued.periodIsWindow, true);
  assert.equal(queued.synthetic, false);
  assert.deepEqual(queued.mapPoints, []);
  assert.equal(historic.date, '2003-02-12');
  assert.equal(historic.endDate, '2004-01-01');
  assert.equal(historic.kind, 'Historical investigation');
  assert.equal(historic.periodIsWindow, false);
  assert.equal(historic.synthetic, true);
  assert.deepEqual(historic.mapPoints.map(({role, lat, lon}) => [role, lat, lon]), [['event', 0, 0], ['gap-end', 1, 5]]);
  assert.equal(overlapsObservationDates(historic, '2003-12-01', '2003-12-31'), false);
  assert.equal(overlapsObservationDates(historic, '2003-02-13', '2003-02-13'), true);
  assert.equal(overlapsObservationDates(queued, '2026-11-14', ''), true);
  assert.equal(catalog.areas[1].name, 'Another reserve');
});

test('older briefs retain events refreshed in later runs by ID, excluding unrelated rows', () => {
  const event = {event_type: 'gap', event_id: 'e1', case_id: 'case', run_id: 'refresh', mpa_id: 'a',
    start_time: '2026-09-10', end_time: '2026-09-11', lat: 5, lon: 5, end_lat: 7, end_lon: 7};
  const row = {case_id: 'case', run_id: 'first', mpa_id: 'a', event_ids: ['e1', 'e2'], events: [
    event, {...event, event_id: 'e2'}, {...event, event_id: 'unrelated'}, {...event, case_id: 'other'},
    {...event, mpa_id: 'other'}
  ]};
  const data = {cases: [row], mpas: []};
  const catalog = snapshotCatalog(data, 'bundled-export');
  assert.equal(catalog.origin, 'Databricks export');
  assert.match(snapshotCatalog(data, 'export').origin, /unknown source/);
  const [record] = catalog.cases;
  assert.equal(record.events.length, 2);
  assert.deepEqual(record.mapPoints.map(point => point.label), [
    'Gap 1 · Reported gap position', 'Gap 1 · Signal resumed', 'Gap 2 · Reported gap position', 'Gap 2 · Signal resumed'
  ]);
});

test('only complete observed coordinates produce pins, with a case-level fallback', () => {
  const row = {case_id: 'x', mpa_id: 'a', lat: 3, lon: -4, events: [
    {event_type: 'gap', lat: 91, lon: 2, end_lat: null, end_lon: 10},
    {event_type: 'fishing', lat: '', lon: 5}
  ]};
  const data = {data_source: 'gfw', mpas: [], cases: [row, {...row, case_id: 'y', lon: Infinity}]};
  const catalog = snapshotCatalog(data, 'export');
  assert.equal(catalog.origin, 'Databricks export');
  assert.deepEqual(catalog.cases[0].mapPoints, [{lat: 3, lon: -4, role: 'event', label: 'Reported case position'}]);
  assert.deepEqual(catalog.cases[1].mapPoints, []);
});

test('the published Databricks export maps every observed position to its tracked case', async () => {
  const data = JSON.parse(await readFile(new URL('../data/poseidon_snapshot.json', import.meta.url), 'utf8'));
  const catalog = snapshotCatalog(data, 'bundled-export');
  assert.equal(catalog.origin, 'Databricks export');
  assert.equal(catalog.cases.length, data.cases.length);
  assert.ok(catalog.cases.every(row => row.events.length === row.snapshotCase.n_events &&
    row.events.every(event => event.case_id === row.id) && !row.synthetic));
  for (const row of catalog.cases) {
    const observed = new Set([row.snapshotCase, ...row.events].flatMap(event => [
      [event.lat, event.lon], [event.end_lat, event.end_lon]
    ]).filter(pair => pair.every(Number.isFinite)).map(pair => pair.join(',')));
    assert.ok(row.mapPoints.every(point => observed.has([point.lat, point.lon].join(','))));
    if (row.snapshotCase.vessel_type === 'gear') assert.match(row.kind, /Fishing gear/);
  }
});
