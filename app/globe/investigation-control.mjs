const states = new Set(['pending', 'running', 'succeeded', 'failed']);
const pollDelay = 4000;
export const hasReport = record => record?.snapshotCase.status !== 'queued' && Boolean(record?.snapshotCase.brief_markdown?.trim());

export function mountInvestigationControl({button, label, note, refreshPublication, openReport}) {
  const endpoint = document.documentElement.dataset.investigationApi;
  const enabled = endpoint === '/api/investigations';
  const jobs = new Map();
  let selected = null, timer;

  // Keep only the job handle in this tab. A reload can reconnect to Databricks
  // without launching or persisting a second copy of the investigation.
  const storageKey = (caseId, fingerprint) => 'poseidon:investigation:' + JSON.stringify([caseId, fingerprint]);
  function save(caseId, fingerprint, runId) {
    const key = storageKey(caseId, fingerprint);
    try {
      if (runId) sessionStorage.setItem(key, runId);
      else sessionStorage.removeItem(key);
    } catch { /* Browsers with storage disabled can still follow jobs in memory. */ }
  }
  function resume(caseId, fingerprint) {
    try {
      const runId = sessionStorage.getItem(storageKey(caseId, fingerprint));
      if (runId) jobs.set(caseId, {runId, fingerprint, state:'pending'});
    } catch { /* Session storage is optional. */ }
  }
  function show(text, disabled, description = '') {
    label.textContent = text;
    button.disabled = disabled;
    button.lastElementChild.hidden = disabled;
    if (note.textContent !== description) note.textContent = description;
    note.hidden = !description;
  }
  function render() {
    if (!selected) return show('Generate report', true);
    if (!enabled || hasReport(selected)) return show('Generate report', false);
    if (selected.snapshotCase.status !== 'queued') return show('Report unavailable', true);
    if (selected.synthetic) return show('Awaiting investigation', true, 'This example uses synthetic data.');
    if (!selected.snapshotCase.fingerprint) return show('Awaiting investigation', true, 'Refresh the publication to get a case that can be submitted.');
    const job = jobs.get(selected.id);
    if (!job) return show('Investigate now', false);
    if (job.problem) {
      const action = job.state === 'failed' || !job.runId ? 'Retry investigation' : job.state === 'succeeded' ? 'Check for report' : 'Check progress';
      return show(action, false, job.problem);
    }
    if (job.state === 'failed') return show('Retry investigation', false, 'The Databricks run ended before it could publish a report.');
    if (job.state === 'starting') return show('Starting…', true, 'Requesting an investigation for this vessel and area.');
    if (job.state === 'succeeded') return show('Loading report…', true, 'The run finished. Checking the publication for this case.');
    if (job.state === 'running') return show('Investigating…', true, 'The agent is running in Databricks. You can explore other vessels.');
    show('Investigation queued', true, 'Databricks accepted this case and is waiting to start the run.');
  }
  async function request(url, options, caseId, fingerprint) {
    const response = await fetch(url, {...options, cache:'no-store', signal:AbortSignal.timeout(30000)});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || 'The investigation service is unavailable.'), {status:response.status});
    if (result.caseId !== caseId || result.fingerprint !== fingerprint || !result.runId || !states.has(result.state)) throw new Error('The investigation service returned an unexpected response.');
    return result;
  }
  function schedule(delay = pollDelay) {
    clearTimeout(timer);
    const caseId = selected?.id, job = jobs.get(caseId);
    if (!job?.runId || job.busy || job.problem || job.state === 'failed' || document.hidden) return;
    timer = setTimeout(() => check(caseId, job), delay);
  }
  async function loadReport(caseId, job) {
    const {report, selectedAtRefresh} = await refreshPublication(caseId);
    if (jobs.get(caseId) !== job || !report || report.snapshotCase.fingerprint !== job.fingerprint || report.synthetic || !hasReport(report)) return false;
    jobs.delete(caseId);
    save(caseId, job.fingerprint, null);
    if ((selected?.id === caseId || (!selected && selectedAtRefresh === caseId)) &&
      !document.hidden && !document.querySelector('dialog[open]')) openReport(report);
    return true;
  }
  async function check(caseId, job) {
    if (job.busy || jobs.get(caseId) !== job) return;
    job.busy = true;
    job.problem = '';
    try {
      if (job.state !== 'succeeded') {
        const url = endpoint + '/' + encodeURIComponent(job.runId) + '?caseId=' + encodeURIComponent(caseId);
        const result = await request(url, {}, caseId, job.fingerprint);
        if (String(result.runId) !== String(job.runId)) throw new Error('The run status did not match this request.');
        job.state = result.state;
      }
      if (job.state === 'succeeded') {
        if (selected?.id === caseId) render();
        job.publicationChecks = (job.publicationChecks || 0) + 1;
        if (!await loadReport(caseId, job) && job.publicationChecks >= 6) {
          job.problem = 'The run finished. The latest publication still has no report for this case.';
        }
      }
    } catch (error) {
      job.problem = error.message || 'The run status is temporarily unavailable.';
    } finally {
      job.busy = false;
      if (selected?.id === caseId) { render(); schedule(); }
    }
  }
  async function start(caseId, fingerprint, previous) {
    const job = {state:'starting', busy:true, fingerprint};
    jobs.set(caseId, job);
    render();
    // Retrying after a lost response must repeat the same launch request.
    const retryRunId = previous?.state === 'failed' ? previous.runId : previous?.retryRunId;
    if (retryRunId) job.retryRunId = retryRunId;
    try {
      const result = await request(endpoint, {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({caseId, fingerprint, retryRunId})}, caseId, fingerprint);
      if (jobs.get(caseId) !== job) return;
      job.runId = String(result.runId);
      job.state = result.state;
      save(caseId, fingerprint, job.runId);
    } catch (error) {
      if (error.status === 409 && await loadReport(caseId, job)) return;
      job.problem = error.message || 'Could not request this investigation.';
    } finally {
      job.busy = false;
      if (selected?.id === caseId) { render(); schedule(0); }
    }
  }
  button.addEventListener('click', () => {
    if (!selected || button.disabled) return;
    if (!enabled || hasReport(selected)) { openReport(selected); return; }
    if (selected.synthetic || selected.snapshotCase.status !== 'queued') return;
    const job = jobs.get(selected.id);
    if (job?.busy) return;
    if (job?.runId && job.state !== 'failed') {
      job.publicationChecks = 0;
      check(selected.id, job);
    } else start(selected.id, selected.snapshotCase.fingerprint, job);
  });
  document.addEventListener('visibilitychange', () => schedule(0));
  return function select(record) {
    const fingerprint = record?.snapshotCase.fingerprint;
    const changed = selected?.id !== record?.id || selected?.snapshotCase.fingerprint !== fingerprint;
    selected = record;
    const previous = record && jobs.get(record.id);
    if (previous && previous.fingerprint !== fingerprint) {
      jobs.delete(record.id);
      save(record.id, previous.fingerprint, null);
    }
    if (enabled && fingerprint && !record.synthetic && record.snapshotCase.status === 'queued' && !jobs.has(record.id)) resume(record.id, fingerprint);
    render();
    if (changed) schedule(0);
  };
}
