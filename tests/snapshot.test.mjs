import test from 'node:test';
import assert from 'node:assert/strict';
import {createSnapshotReader} from '../snapshot.mjs';
import {createApp} from '../server.mjs';

test('monitor reads the notebook contract and fails visibly if a configured export is missing', async t => {
  const readSample = createSnapshotReader({});
  const sample = await readSample();
  assert.equal(sample.source, 'sample');
  assert.equal(sample.data.synthetic, true);
  const cases = sample.data.cases;
  assert.ok(cases.some(c => c.longest_gap_hours === 100 && c.steps.length > 0 && c.brief_markdown));
  const missing = createSnapshotReader({POSEIDON_SNAPSHOT_PATH: new URL('./absent.json', import.meta.url)});
  let reader = readSample;
  const app = createApp({readSnapshot: () => reader()});
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => app.close(resolve)));
  const url = 'http://127.0.0.1:' + app.address().port + '/api/snapshot';
  const good = await fetch(url);
  assert.equal(good.headers.get('X-Poseidon-Source'), 'sample');
  assert.equal((await good.json()).product, 'Poseidon');
  reader = missing;
  const unavailable = await fetch(url);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).cases, undefined);
});

test('hosted monitor uses its own identity and reads the newest export on each request', async () => {
  const env = {POSEIDON_VOLUME: '/Volumes/workspace/poseidon/exports', DATABRICKS_HOST: 'team.cloud.databricks.com',
    DATABRICKS_CLIENT_ID: 'client', DATABRICKS_CLIENT_SECRET: 'fixture-secret'};
  let logins = 0;
  let reads = 0;
  const read = createSnapshotReader(env, async (url, request) => {
    if (url.endsWith('/oidc/v1/token')) {
      logins++;
      assert.match(request.headers.Authorization, /^Basic /);
      return Response.json({access_token: 'test-app-token', expires_in: 3600});
    }
    assert.equal(url, 'https://team.cloud.databricks.com/api/2.0/fs/files/Volumes/workspace/poseidon/exports/poseidon_snapshot.json');
    assert.equal(request.headers.Authorization, 'Bearer test-app-token');
    return Response.json({product: 'Poseidon', latest_run: {run_id: String(++reads)}, cases: [], mpas: [], news: [], runs: []});
  });
  assert.equal((await read()).source, 'export');
  assert.equal((await read()).data.latest_run.run_id, '2');
  assert.equal(logins, 1);
});
