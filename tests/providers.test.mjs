import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadCandidates, readBrief, recordBrief, searchOfficial } from '../providers.mjs';

const fixtureEnv = {
  LINKUP_LIVE: '1', LINKUP_API_KEY: 'test-token',
  DATABRICKS_LIVE: '1', DATABRICKS_TOKEN: 'test-token', DATABRICKS_WAREHOUSE_ID: 'test-warehouse',
  DATABRICKS_HOST: 'https://example.cloud.databricks.com',
  DATABRICKS_CANDIDATES_TABLE: 'main.demo.soundings_candidates',
  DATABRICKS_BRIEFS_TABLE: 'main.demo.soundings_briefs',
};
const query = { searchQuery: 'Find the dated fishing rule', searchDomains: ['gov.uk'] };
const candidate = { id: 'dogger-2023', date: '2023-01-01', areaId: 'dogger-bank', kind: 'Annual estimate' };

// Capture every request, including unexpected ones. No test contacts a sponsor.
function mockProviders(t, respond) {
  const previous = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixtureEnv);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = { url, ...options, body: JSON.parse(options.body) };
    requests.push(request);
    return respond(request);
  });
  return requests;
}

function success(rows = []) {
  return Response.json({
    status: { state: 'SUCCEEDED' },
    result: { data_array: rows },
    manifest: { total_row_count: rows.length },
  });
}

test('providers remain offline when disabled and reject invalid configuration before fetching', async t => {
  const calls = mockProviders(t, () => { throw new Error('Unexpected call'); });
  process.env.LINKUP_LIVE = '0';
  process.env.DATABRICKS_LIVE = '0';
  assert.equal((await searchOfficial(query)).mode, 'unavailable');
  assert.equal((await recordBrief(candidate)).mode, 'unavailable');
  assert.equal(await readBrief(candidate.id), null);
  assert.equal(await loadCandidates(), null);
  process.env.DATABRICKS_LIVE = '1';
  process.env.DATABRICKS_HOST = 'https://databricks.com.invalid.example';
  assert.equal(await readBrief(candidate.id), null);
  process.env.DATABRICKS_HOST = fixtureEnv.DATABRICKS_HOST;
  process.env.DATABRICKS_BRIEFS_TABLE = 'main.demo.table where x=1';
  assert.equal(await readBrief(candidate.id), null);
  assert.equal(calls.length, 0);
});

test('Linkup keeps distinct official HTTPS source links and passes domain restrictions', async t => {
  const calls = mockProviders(t, () => Response.json({ results: [
    { url: 'https://gov.uk.lookalike.example/doc', name: 'Lookalike' },
    { url: 'https://www.gov.uk/rule', name: 'Dated rule', type: 'text' },
    { url: 'https://www.gov.uk/rule', name: 'Duplicate' },
    { url: 'http://www.gov.uk/other', name: 'Plain HTTP' },
    { url: 'https://fish.gov.uk/image', type: 'image' },
  ] }));
  const result = await searchOfficial(query);
  assert.equal(result.mode, 'live');
  assert.deepEqual(result.sources, [{ title: 'Dated rule', url: 'https://www.gov.uk/rule' }]);
  assert.equal(calls[0].url, 'https://api.linkup.so/v1/search');
  assert.deepEqual(calls[0].body.includeDomains, ['gov.uk']);
  assert.equal(calls[0].body.q, query.searchQuery);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('Linkup reports missing searches and upstream failures without returning untrusted text', async t => {
  const calls = mockProviders(t, () => new Response('private provider information', { status: 429 }));
  assert.deepEqual((await searchOfficial({ searchQuery: '', searchDomains: [] })).sources, []);
  assert.equal(calls.length, 0);
  const result = await searchOfficial(query);
  assert.equal(result.mode, 'unavailable');
  assert.match(result.detail, /429/);
  assert.doesNotMatch(result.detail, /private provider/);
});

test('Delta writes and reads the same brief using bound parameters and a bounded SQL statement', async t => {
  const brief = { id: "brief-'1", summary: "A source's gear record is incomplete." };
  const calls = mockProviders(t, req => req.body.statement.startsWith('SELECT') ? success([[JSON.stringify(brief)]]) : success());
  assert.equal((await recordBrief(brief)).mode, 'stored');
  assert.deepEqual(await readBrief(brief.id), brief);
  for (const req of calls) {
    assert.equal(req.url, fixtureEnv.DATABRICKS_HOST + '/api/2.0/sql/statements');
    assert.equal(req.body.wait_timeout, '10s');
    assert.equal(req.body.on_wait_timeout, 'CANCEL');
    assert.match(req.body.statement, /IDENTIFIER\(:table_name\)/);
    assert.equal(req.body.parameters.find(p => p.name === 'brief_id').value, brief.id);
    assert.equal(req.body.statement.includes(brief.id), false);
    assert.equal(req.body.statement.includes(brief.summary), false);
  }
  assert.deepEqual(JSON.parse(calls[0].body.parameters.find(p => p.name === 'payload').value), brief);
  assert.match(calls[1].body.statement, /WHERE brief_id = :brief_id/);
});

test('Delta reads require a single, complete, matching JSON object', async t => {
  let rows;
  const calls = mockProviders(t, () => success(rows));
  assert.equal(await readBrief(' '), null);
  assert.equal(await readBrief(null), null);
  assert.equal(calls.length, 0);
  const id = candidate.id;
  const row = [JSON.stringify({ id })];
  for (rows of [[], [row, row], [['malformed']], [['[]']], [['{"id":"different"}']]]) {
    assert.equal(await readBrief(id), null);
  }
  const payload = JSON.stringify({ summary: 'Older brief without an ID' });
  rows = [[payload]];
  assert.deepEqual(await readBrief(createHash('sha256').update(payload).digest('hex')), JSON.parse(payload));
});

test('Delta candidate reads preserve source fields and reject partial or duplicate data', async t => {
  let result = () => success([[JSON.stringify(candidate)]]);
  const calls = mockProviders(t, () => result());
  assert.deepEqual(await loadCandidates(), [candidate]);
  assert.equal(calls[0].body.parameters[0].value, fixtureEnv.DATABRICKS_CANDIDATES_TABLE);
  result = () => success([[JSON.stringify(candidate)], [JSON.stringify(candidate)]]);
  assert.equal(await loadCandidates(), null);
  result = () => Response.json({ status: { state: 'SUCCEEDED' }, manifest: { truncated: true }, result: { data_array: [] } });
  assert.equal(await loadCandidates(), null);
  result = () => Response.json({ status: { state: 'CANCELED' } });
  assert.equal(await loadCandidates(), null);
  assert.equal(await readBrief(candidate.id), null);
  assert.equal((await recordBrief(candidate)).mode, 'unavailable');
});
