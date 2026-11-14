import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotCatalog} from '../public/snapshot-workspace.mjs';
import {queryCases, queueStats, contextPoints} from '../public/case-query.mjs';

const event = (id, type, start, lat = 0) => ({event_id: id, event_type: type, start_time: start, lat, lon: 0});
const catalog = snapshotCatalog({
  data_source: 'gfw',
  mpas: [{mpa_id:'a', mpa_name:'Galápagos'}, {mpa_id:'b', mpa_name:'Hermandad'}],
  cases: [
    {case_id:'first', mpa_id:'a', status:'queued', mode:'history', mmsi:'001234567',
      vessel_name:'LA  NIÑA', vessel_type:'fishing', risk_level:'medium', events:[
        event('one','encounter','2026-01-01'), event('two','loitering','2026-01-20')]},
    {case_id:'second', mpa_id:'b', status:'complete', mode:'live', risk_level:'low',
      events:[event('one','encounter','2026-01-03', 1)]},
    {case_id:'third', mpa_id:'a', status:'incomplete', mode:'history',
      events:[event('one','encounter','2026-01-01')]}
  ]
}, 'export');

test('search and queue filters combine across area, identifiers, event type and case status', () => {
  const ids = filters => queryCases(catalog, filters).map(row => row.id);
  assert.deepEqual(ids({}), ['first', 'second', 'third']);
  assert.deepEqual(ids({search: 'galapagos nina enCOUNTER 001234567', status:'queued', mode:'history'}), ['first']);
  assert.deepEqual(ids({search:'loitering', areaId:'b'}), []);
  assert.deepEqual(ids({from:'2026-01-02',through:'2026-01-06'}), ['second']);
  assert.deepEqual(ids({from:'2026-01-06',through:'2026-01-02'}), []);
  assert.deepEqual(ids({status:'incomplete'}), ['third']);
});

test('counts deduplicate shared event IDs within an area and map points keep their owning case', () => {
  assert.deepEqual(queueStats(queryCases(catalog)), {cases:3,events:3,complete:1,queued:1,incomplete:1,areas:2});
  const filtered = queryCases(catalog, {areaId:'a'});
  assert.deepEqual(queueStats(filtered), {cases:2,events:2,complete:0,queued:1,incomplete:1,areas:1});
  const points = contextPoints(filtered);
  assert.deepEqual(points.map(p => p.caseId), ['first','first','third']);
  assert.deepEqual(points.map(p => p.riskLevel), ['medium','medium','unknown']);
  assert.ok(points.every(p => p.areaId === 'a' && p.role === 'event' && p.lat === 0));
  assert.equal(filtered[0].mapPoints[0].caseId, undefined);
});

test('co-located fishing and reporting gap observations retain their distinct times, types and IDs', () => {
  const events = [
    {...event('fishing-1','fishing','2026-01-01T00:00:00Z'), end_time:'2026-01-01T01:00:00Z', duration_hours:1},
    {...event('gap-2','gap','2026-01-01T01:00:00Z'), end_time:'2026-01-04T01:00:00Z', duration_hours:72, end_lat:1, end_lon:2}
  ];
  const records = snapshotCatalog({mpas:[], cases:[{case_id:'ship',mpa_id:'one',longest_gap_hours:100,events}]}, 'export');
  const points = contextPoints(records.cases);
  assert.deepEqual(points.map(p => [p.eventId, p.eventType, p.durationHours, p.markerTime]), [
    ['fishing-1', 'fishing', 1, events[0].start_time],
    ['gap-2', 'gap', 72, events[1].start_time],
    ['gap-2', 'gap', 72, events[1].end_time]
  ]);
  assert.equal(points[0].lat, points[1].lat);
  assert.equal(points[0].lon, points[1].lon);
  assert.equal(points[2].startTime, events[1].start_time);
  assert.equal(points[2].endTime, events[1].end_time);
});
