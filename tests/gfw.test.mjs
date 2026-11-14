import test from 'node:test';
import assert from 'node:assert/strict';
import { vesselHistory } from '../gfw.mjs';

const record = { mmsi: '345080023', date: '2019-03-17' };
const env = { GFW_LIVE: '1', GFW_TOKEN: 'test-token' };
const identity = {
  entries: [{ selfReportedInfo: [{ id: 'unique-vessel', ssvid: record.mmsi,
    transmissionDateFrom: '2017-01-01', transmissionDateTo: '2020-01-01' }] }]
};
const json = value => new Response(JSON.stringify(value), { status: 200 });

test('disabled history never calls the network', async () => {
  const result = await vesselHistory(record, { env: {}, fetch: () => { throw new Error('Network called'); } });
  assert.equal(result.mode, 'unavailable');
  assert.deepEqual(result.observations, []);
});

test('ambiguous temporal identities attach no history', async () => {
  const duplicate = structuredClone(identity);
  duplicate.entries.push({ selfReportedInfo: [{ ...identity.entries[0].selfReportedInfo[0], id: 'other-vessel' }] });
  let calls = 0;
  const result = await vesselHistory(record, { env, fetch: async () => { calls++; return json(duplicate); } });
  assert.equal(result.mode, 'unavailable');
  assert.equal(calls, 1);
});

test('reused MMSI outside event period attaches no history', async () => {
  const future = structuredClone(identity);
  future.entries[0].selfReportedInfo[0].transmissionDateFrom = '2021-01-01';
  const result = await vesselHistory(record, { env, fetch: async () => json(future) });
  assert.equal(result.mode, 'unavailable');
});

test('bounded preceding history excludes unrelated and future events', async () => {
  const calls = [];
  const result = await vesselHistory(record, { env, fetch: async (url, options) => {
    calls.push(url);
    assert.equal(url.origin, 'https://gateway.api.globalfishingwatch.org');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    if (url.pathname.endsWith('/search')) return json(identity);
    assert.equal(url.searchParams.get('vessels[0]'), 'unique-vessel');
    assert.equal(url.searchParams.get('end-date'), '2019-03-17');
    const event = { id: 'port1', vessel: { id: 'unique-vessel' }, type: 'port_visit', start: '2019-03-01T00:00:00Z', end: '2019-03-02T00:00:00Z' };
    if (url.searchParams.get('datasets[0]').includes('encounters')) return json({ entries: [] });
    return json({ entries: [event, { ...event, id: 'wrong', vessel: { id: 'other' } }, { ...event, id: 'future', end: '2019-03-18T00:00:00Z' }, { ...event, id: 'invalid', end: null }] });
  } });
  assert.equal(calls.length, 3);
  assert.equal(result.mode, 'live');
  assert.equal(result.observations.length, 2);
  assert.deepEqual(result.observations[1].sourceIds, ['gfw-live-history']);
  assert.equal(result.sources.length, 2);
});

test('lookup failure is neutral and does not expose provider errors', async () => {
  const result = await vesselHistory(record, { env, fetch: async () => { throw new Error('secret-token'); } });
  assert.equal(result.mode, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});

test('oversized response is rejected before reading', async () => {
  const result = await vesselHistory(record, { env, fetch: async () => new Response('oversized', { headers: { 'content-length': '900000' } }) });
  assert.equal(result.mode, 'unavailable');
});
