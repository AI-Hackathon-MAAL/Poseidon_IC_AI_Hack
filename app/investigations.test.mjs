import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {createInvestigationJobs} from './investigation-jobs.mjs';
import {createResultReader} from './investigation-results.mjs';
import {createSnapshotInvestigations} from './snapshot-investigations.mjs';

test('a queued case launches once and publishes only the matching observations', async t => {
  const row = {case_id:'12:boat', mpa_id:'12', vessel_id:'boat', fingerprint:'012345abcdef', status:'queued',
    risk_level:'low', risk_score:10, events:[], steps:[]};
  const neighbor = {...row, case_id:'12:other', vessel_id:'other'};
  const snapshot = {product:'Poseidon', cases:[row,neighbor], mpas:[{mpa_id:'12', n_cases:2}], runs:[], news:[], global_news:[]};
  const run = {run_id:'agent-run', finished_at:'2026-11-15T12:00:00Z'};
  const report = {case_id:row.case_id, fingerprint:row.fingerprint, run, case:{...row, run_id:run.run_id,
    investigated_at:run.finished_at, status:'complete', risk_level:'medium', risk_score:50, brief_markdown:'Published case evidence.'}};
  const file = createHash('sha256').update(row.case_id + '\n' + row.fingerprint).digest('hex') + '.json';
  const env = {POSEIDON_VOLUME:'/Volumes/workspace/poseidon/exports', POSEIDON_JOB_ID:'45',
    DATABRICKS_HOST:'test.cloud.databricks.com', DATABRICKS_CLIENT_ID:'fixture', DATABRICKS_CLIENT_SECRET:'fixture'};
  let published = false;
  const attempts = [];
  async function workspace(url, options) {
    const {pathname} = new URL(url);
    if (pathname === '/oidc/v1/token') return Response.json({access_token:'test',expires_in:3600});
    if (pathname.endsWith('/jobs/run-now')) {
      const input = JSON.parse(options.body);
      assert.deepEqual(input.job_parameters,{case_id:row.case_id,fingerprint:row.fingerprint});
      attempts.push(input.idempotency_token);
      return Response.json({run_id:90});
    }
    if (pathname.endsWith('/jobs/runs/get')) return Response.json({job_id:45,run_id:90,
      state:{life_cycle_state:published ? 'TERMINATED' : 'RUNNING', result_state:published ? 'SUCCESS' : undefined},
      job_parameters:[{name:'case_id',value:row.case_id},{name:'fingerprint',value:row.fingerprint}]});
    if (pathname.includes('/fs/directories/')) {
      return published ? Response.json({contents:[{name:file}]}) : new Response(null,{status:404});
    }
    if (pathname.endsWith('/' + file)) return Response.json(report);
    throw new Error('Unexpected workspace request ' + pathname);
  }
  const app = createApp({readSnapshot:async () => ({source:'export',data:snapshot}),
    jobs:createInvestigationJobs({env,fetchImpl:workspace}), readResults:createResultReader(env,workspace)});
  await new Promise((resolve,reject) => {app.once('error',reject); app.listen(0,'127.0.0.1',resolve);});
  t.after(() => new Promise(resolve => app.close(resolve)));
  const origin = 'http://127.0.0.1:' + app.address().port;
  const input = {caseId:row.case_id,fingerprint:row.fingerprint};
  const post = (data, source = origin) => fetch(origin + '/api/investigations',{method:'POST',
    headers:{Origin:source,'Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.match(await (await fetch(origin)).text(), /data-investigation-api="\/api\/investigations"/);
  assert.equal((await post(input,'https://elsewhere.example')).status,403);
  assert.equal((await post({...input,fingerprint:'ffffeeeeaaaa'})).status,409);
  assert.equal(attempts.length,0);
  for (const response of await Promise.all([post(input),post(input)])) {
    assert.equal(response.status,202);
    assert.equal((await response.json()).runId,'90');
  }
  assert.equal(new Set(attempts).size,1);
  const status = id => fetch(origin + '/api/investigations/90?caseId=' + encodeURIComponent(id));
  assert.equal((await status(neighbor.case_id)).status,404);
  assert.equal((await (await status(row.case_id)).json()).state,'running');
  published = true;
  assert.equal((await (await status(row.case_id)).json()).state,'succeeded');
  const read = async () => (await fetch(origin + '/data/poseidon_snapshot.json')).json();
  const data = await read();
  assert.deepEqual(data.cases,[report.case,neighbor]);
  assert.equal(data.mpas[0].n_queued,1);
  assert.equal(data.latest_run.run_id,report.case.run_id);
  assert.equal((await post(input)).status,409);
  row.fingerprint = '112345abcdef';
  assert.equal((await read()).cases[0].status,'queued');
  assert.equal(attempts.length,2);
});

test('snapshot reports survive a reopen and belong only to their source publication', async t => {
  const directory = await mkdtemp(join(tmpdir(),'poseidon-snapshot-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const row = {case_id:'12:ship',mpa_id:'12',vessel_id:'ship',fingerprint:'012345abcdef',
    risk_score:30,risk_level:'low',status:'queued',events:[],steps:[]};
  const data = {product:'Poseidon',cases:[row],mpas:[{mpa_id:'12',n_queued:1}],runs:[],news:[],global_news:[]};
  const publication = {source:'bundled-export',data};
  let runs = 0;
  let unblock;
  const waiting = new Promise(resolve => {unblock = resolve;});
  const run = async () => {
    runs++;
    await waiting;
    return {...row, report_origin:'snapshot-python', status:'incomplete', brief_markdown:'Offline evidence',
      investigated_at:'2026-11-15T12:00:00Z', reasons:[],steps:[]};
  };
  const reports = createSnapshotInvestigations(directory,run);
  const app = createApp({readSnapshot:async () => publication, jobs:{enabled:false}, snapshotInvestigations:reports});
  await new Promise((resolve,reject) => {app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(() => new Promise(resolve => app.close(resolve)));
  const origin = 'http://127.0.0.1:' + app.address().port;
  const post = (fingerprint = row.fingerprint, requestOrigin = origin, extraHeaders = {}) => fetch(origin + '/api/snapshot-investigations', {
    method:'POST', headers:{Origin:requestOrigin,'Content-Type':'application/json',...extraHeaders},
    body:JSON.stringify({caseId:row.case_id, fingerprint})
  });
  assert.match(await (await fetch(origin)).text(), /data-snapshot-investigation-api="\/api\/snapshot-investigations"/);
  assert.equal((await post(row.fingerprint,'https://example.org')).status,403);
  const httpsOrigin = 'https://' + new URL(origin).host;
  assert.equal((await post(row.fingerprint,httpsOrigin,{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await post('dddddddddddd',httpsOrigin,{'Sec-Fetch-Site':'same-origin'})).status,409);
  assert.equal((await post('dddddddddddd')).status,409);
  row.run_id = 'mixed-import';
  data.runs.push({run_id:row.run_id, data_source:'sample'});
  assert.equal((await post()).status,409);
  data.runs.length = 0;
  assert.equal(runs,0);
  const pair = [post(),post()];
  unblock();
  for (const response of await Promise.all(pair)) {
    assert.equal(response.status,200);
    assert.equal((await response.json()).case.brief_markdown,'Offline evidence');
  }
  assert.equal(runs,1);
  assert.equal(data.cases[0].status,'queued');
  const reopened = createSnapshotInvestigations(directory,run);
  assert.equal((await reopened.generate(publication,row.case_id,row.fingerprint)).report_origin,'snapshot-python');
  assert.equal(runs,1);
  const result = await (await fetch(origin + '/api/snapshot')).json();
  assert.equal(result.cases[0].status,'incomplete');
  assert.equal(result.mpas[0].n_queued,0);
  assert.ok(result.local_report_revision);

  // A corrected area boundary can change the original risk rules even with identical events.
  data.mpas[0].boundary = {type:'MultiPolygon',coordinates:[]};
  assert.equal((await reopened.overlay(publication)).data.cases[0].status,'queued');
  row.status='complete';
  row.brief_markdown='Published notebook brief';
  assert.equal((await reopened.generate(publication,row.case_id,row.fingerprint)).brief_markdown,row.brief_markdown);
  assert.equal(runs,1);
});
