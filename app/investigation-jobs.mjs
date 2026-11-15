import {createHash} from 'node:crypto';
import {createWorkspaceRequest, volumePath, workspaceOrigin} from './databricks-workspace.mjs';

function problem(status, message) {
  return Object.assign(new Error(message), {status});
}

function validCaseId(value) {
  return typeof value === 'string' && value.length <= 255 && /^[\w-]+:[\w.-]+$/.test(value);
}

export function validInvestigationKey(caseId, fingerprint) {
  return validCaseId(caseId) && typeof fingerprint === 'string' && /^[0-9a-f]{12}$/.test(fingerprint);
}

// Jobs uses signed 64-bit numeric IDs. Keep them exact through JSON and browser URLs.
function validId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

function stateOf(run) {
  const lifecycle = run.status?.state ?? run.state?.life_cycle_state;
  if (lifecycle === 'TERMINATED') {
    const result = run.status?.termination_details?.code ?? run.state?.result_state;
    return result === 'SUCCESS' ? 'succeeded' : 'failed';
  }
  if (lifecycle === 'SKIPPED' || lifecycle === 'INTERNAL_ERROR') return 'failed';
  if (lifecycle === 'RUNNING' || lifecycle === 'TERMINATING') return 'running';
  if (['QUEUED','BLOCKED','WAITING','WAITING_FOR_RETRY','PENDING'].includes(lifecycle)) return 'pending';
  throw problem(502, 'Databricks returned an unrecognized investigation state. Check the run again.');
}

function queuedCase(snapshot, caseId) {
  if (!validCaseId(caseId)) throw problem(400,'Select a published case.');
  const row = snapshot?.cases?.find(c => c.case_id === caseId);
  if (!row) throw problem(404,'The selected case is no longer in the publication.');
  const run = [snapshot.latest_run, ...(snapshot.runs || [])].find(r => r?.run_id === row.run_id);
  if (snapshot.synthetic === true || snapshot.data_source === 'sample' || row.data_source === 'sample' ||
      run?.data_source === 'sample' || run?.llm_endpoint === 'sample-scripted-model' || caseId.startsWith('sample-')) {
    throw problem(409,'Select a case from a real publication.');
  }
  if (row.status !== 'queued') throw problem(409,'This case is no longer awaiting investigation. Refresh to view it.');
  if (caseId !== row.mpa_id + ':' + row.vessel_id || !validInvestigationKey(caseId, row.fingerprint)) {
    throw problem(422,'The published case lacks the identifiers required for an investigation.');
  }
  return row;
}

export function createInvestigationJobs({env = process.env, fetchImpl = fetch} = {}) {
  const jobId = env.POSEIDON_JOB_ID;
  const request = createWorkspaceRequest(env, fetchImpl);
  let enabled = false;
  if (validId(jobId) && env.DATABRICKS_CLIENT_ID && env.DATABRICKS_CLIENT_SECRET) {
    try {
      workspaceOrigin(env.DATABRICKS_HOST);
      volumePath(env.POSEIDON_VOLUME);
      enabled = true;
    } catch { /* A read-only deployment can still display the published snapshot. */ }
  }
  async function jobsApi(path, options) {
    if (!enabled) throw problem(503,'The on-demand Databricks job is not connected to this workspace.');
    let response;
    try { response = await request('/api/2.2/jobs/' + path, options); }
    catch { throw problem(503,'The app could not connect to the Databricks investigation job. Try again.'); }
    if (response.status === 401 || response.status === 403) {
      throw problem(503,'The app needs permission to run and view the Databricks investigation job.');
    }
    if (response.status === 404) throw problem(404,'The configured job or investigation run could not be found.');
    if (response.status === 429) throw problem(429,'Databricks is busy. Try again shortly.');
    if (!response.ok) throw problem(502,'Databricks could not process this investigation request. Try again.');
    try {
      return JSON.parse(await response.text(), (key,value,context) =>
        (key === 'run_id' || key === 'job_id') && typeof value === 'number' ? context.source : value);
    } catch { throw problem(502,'Databricks returned an unreadable job response. Try again.'); }
  }
  async function status(caseId, runId) {
    if (!validCaseId(caseId) || !validId(runId)) throw problem(400,'Invalid investigation identifier.');
    const run = await jobsApi('runs/get?run_id=' + runId);
    const params = Array.isArray(run?.job_parameters) ? run.job_parameters : [];
    const owner = params.find(p => p?.name === 'case_id')?.value;
    const fingerprint = params.find(p => p?.name === 'fingerprint')?.value;
    if (run?.job_id !== jobId || run.run_id !== runId || owner !== caseId || !validInvestigationKey(caseId, fingerprint)) {
      throw problem(404,'No matching investigation run was found for this case.');
    }
    return {caseId,runId,fingerprint,state:stateOf(run)};
  }
  async function start(snapshot, caseId, retryRunId) {
    const row = queuedCase(snapshot, caseId);
    if (retryRunId != null) {
      const previous = await status(caseId, retryRunId);
      if (previous.state !== 'failed' || previous.fingerprint !== row.fingerprint) {
        throw problem(409,'Only a failed investigation of these observations can be retried.');
      }
    }
    // One token per case revision and attempt, even across simultaneous clients and app restarts.
    const token = createHash('sha256').update(JSON.stringify([jobId,caseId,row.fingerprint,retryRunId ?? null])).digest('hex');
    if (!enabled) throw problem(503,'The on-demand Databricks job is not connected to this workspace.');
    const result = await jobsApi('run-now', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({job_id:JSON.rawJSON(jobId),idempotency_token:token,
        job_parameters:{case_id:caseId, fingerprint:row.fingerprint}})
    });
    if (!validId(result?.run_id)) throw problem(502,'Databricks did not return a run ID. Try again.');
    return {caseId,runId:result.run_id,fingerprint:row.fingerprint,state:'pending'};
  }
  return {enabled,start,status};
}
