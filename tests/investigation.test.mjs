import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { investigate, replay, validCatalog } from '../investigator.mjs';
import { createApp } from '../server.mjs';
import { within } from '../scripts/import-gaps.mjs';

const search = async () => ({mode:'unavailable',sources:[],detail:'Replay sources only.'});
const model = async () => ({mode:'rules',steps:[],detail:'Rule-based evaluation.'});
const lookupHistory = async () => ({mode:'unavailable',sources:[],observations:[],detail:'Offline history.'});
const options = {search, model, lookupHistory};

test('six historical cases resolve all cited evidence and retain distinct incidents', async () => {
  assert.ok(validCatalog(replay));
  assert.equal(replay.length,6);
  const briefs = await Promise.all(replay.map(row => investigate(row,replay,options)));
  for (const brief of briefs) {
    assert.ok(brief.observations.every(o => o.sourceIds.every(id => brief.sources.some(s => s.id === id))));
    assert.ok(brief.sources.every(s => s.url.startsWith('https://')));
    assert.equal(brief.synthetic,false);
  }
  const march = briefs.find(b => b.id === 'clarion-mar-2025');
  assert.ok(march.observations.some(o => o.date === '2025-01-29'));
  assert.equal(march.mapPoints.length,0);
  assert.equal(briefs.find(b => b.id === 'phoenix-2015').priority,'No follow-up indicated');
  assert.match(briefs.find(b => b.id === 'dogger-2023').nextStep,/gear-use/);
});

test('archive calculations use recorded endpoints and actual UTC intervals', async () => {
  const gap = replay[0];
  assert.equal(within(gap.mapPoints[0].lon,gap.mapPoints[0].lat),false);
  assert.equal(within(gap.mapPoints[1].lon,gap.mapPoints[1].lat),true);
  const brief = await investigate(gap,replay,options);
  assert.match(brief.summary,/24\.86 hours/);
  assert.equal(brief.observations[1].date,'2019-03-18T19:25:59.000Z');
  assert.ok(brief.unknowns.some(t => t.includes('cause')));
  const old = await investigate({...gap,date:'2017-01-01'},[],options);
  assert.equal(old.priority,'Rule unverified');
  assert.equal(validCatalog([{...gap,id:'../file'}]),false);
});

test('HTTP workflow saves an independently readable brief and handles retries and invalid cases', async t => {
  const dir = await mkdtemp(join(tmpdir(),'soundings-test-'));
  const app = createApp({...options, dataDir:dir, candidates:async () => null,readStored:async () => null,store:async () => ({mode:'unavailable',detail:'Replay.'})});
  await new Promise((resolve,reject) => { app.once('error',reject); app.listen(0,'127.0.0.1',resolve); });
  t.after(async () => { await new Promise(r => app.close(r)); await rm(dir,{recursive:true,force:true}); });
  const url = 'http://127.0.0.1:' + app.address().port;
  const catalog = await (await fetch(url+'/api/catalog')).json();
  assert.equal(catalog.areas.length,3);
  assert.equal(catalog.origin,'Published replay');
  assert.deepEqual(catalog.cases[0].mapPoints, replay[0].mapPoints);
  assert.equal(catalog.cases[0].start, replay[0].start);
  assert.deepEqual(catalog.cases.find(item => item.id === 'clarion-mar-2025').mapPoints, []);
  const post = caseId => fetch(url+'/api/investigate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caseId})});
  assert.equal((await post('unknown')).status,404);
  const id = catalog.cases[0].id;
  assert.equal((await fetch(url + '/api/briefs/' + id)).status,404);
  const responses = await Promise.all([post(id),post(id)]);
  for (const response of responses) {
    assert.equal(response.status,200);
    const brief = await response.json();
    assert.equal(brief.storage.mode,'local');
  }
  assert.deepEqual(await readdir(dir),[id+'.json']);
  assert.equal(JSON.parse(await readFile(join(dir,id+'.json'),'utf8')).id,id);
  const retrieved = await (await fetch(url+'/api/briefs/'+id)).json();
  assert.equal(retrieved.id,id);
  assert.equal(retrieved.storage.mode,'local');
});

test('an empty connected warehouse stays empty and retrieved Delta briefs retain their storage origin', async t => {
  const dir = await mkdtemp(join(tmpdir(),'soundings-empty-'));
  const app = createApp({dataDir:dir,candidates:async () => [],readStored:async id => ({id,summary:'Stored brief'})});
  await new Promise((resolve,reject) => { app.once('error',reject);app.listen(0,'127.0.0.1',resolve); });
  t.after(async () => { await new Promise(r => app.close(r));await rm(dir,{recursive:true,force:true}); });
  const url = 'http://127.0.0.1:' + app.address().port;
  const catalog = await (await fetch(url+'/api/catalog')).json();
  assert.deepEqual(catalog.cases,[]);
  assert.equal(catalog.origin,'Databricks');
  assert.equal((await (await fetch(url+'/api/briefs/example')).json()).storage.mode,'stored');
});
