import test from 'node:test';
import assert from 'node:assert/strict';
import {createSnapshotReader} from '../snapshot.mjs';
import {createApp} from '../server.mjs';

test('monitor reads the notebook contract and fails visibly if a configured export is missing', async t => {
  const readBundled = createSnapshotReader({});
  const {source, data} = await readBundled();
  assert.equal(source, 'bundled-export');
  assert.notEqual(data.synthetic, true);
  assert.match(data.attribution, /Global Fishing Watch/);
  assert.ok(data.mpas.every(area => !String(area.mpa_id).startsWith('sample-')));
  const missing = createSnapshotReader({POSEIDON_SNAPSHOT_PATH: new URL('./absent.json', import.meta.url)});
  let reader = readBundled;
  const app = createApp({readSnapshot: () => reader()});
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => app.close(resolve)));
  const url = 'http://127.0.0.1:' + app.address().port + '/api/snapshot';
  const bookmark = await fetch(new URL('/monitor', url), {redirect: 'manual'});
  assert.equal(bookmark.status, 302);
  assert.equal(bookmark.headers.get('location'), '/');
  for (const path of ['/', '/archive']) {
    const page = await fetch(new URL(path, url));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="brief-dialog" class="evidence-drawer"/);
  }
  const good = await fetch(url);
  assert.equal(good.headers.get('X-Poseidon-Source'), 'bundled-export');
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

test('an unchanged publication answers with 304 and a changed one is sent compressed', async t => {
  const read = createSnapshotReader({});
  let data = (await read()).data;
  const app = createApp({readSnapshot: async () => ({source: 'bundled-export', data})});
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => app.close(resolve)));
  const url = 'http://127.0.0.1:' + app.address().port + '/data/poseidon_snapshot.json';
  const first = await fetch(url, {headers: {'Accept-Encoding': 'gzip'}});
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-encoding'), 'gzip');
  assert.equal(first.headers.get('x-poseidon-source'), 'bundled-export');
  assert.equal((await first.json()).cases.length, data.cases.length);
  const tag = first.headers.get('etag');
  assert.ok(tag);
  const again = await fetch(url, {headers: {'If-None-Match': tag}});
  assert.equal(again.status, 304);
  assert.equal(await again.text(), '');
  data = {...data, generated_at: '2030-01-01T00:00:00+00:00'};
  const changed = await fetch(url, {headers: {'If-None-Match': tag}});
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), tag);
  assert.equal((await changed.json()).generated_at, '2030-01-01T00:00:00+00:00');
  const index = await fetch(new URL('/data/mpa_index.json', url), {headers: {'Accept-Encoding': 'gzip'}});
  assert.equal(index.headers.get('content-encoding'), 'gzip');
  assert.ok(Array.isArray(await index.json()));
});
