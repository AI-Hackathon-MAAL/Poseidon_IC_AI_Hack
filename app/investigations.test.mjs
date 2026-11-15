import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createApp} from '../server.mjs';
import {createInvestigationJobs} from './investigation-jobs.mjs';
import {createResultReader} from './investigation-results.mjs';

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
