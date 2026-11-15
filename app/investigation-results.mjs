import {createHash} from 'node:crypto';
import {createWorkspaceRequest, volumePath} from './databricks-workspace.mjs';

// The notebook publishes one immutable file per case and set of observed events.
function resultName(record) {
  return createHash('sha256').update(record.case_id + '\n' + record.fingerprint).digest('hex') + '.json';
}

function matchesCase(report, queued) {
  const row = report?.case;
  return row && report.case_id === queued.case_id && report.fingerprint === queued.fingerprint &&
    row.case_id === queued.case_id && row.fingerprint === queued.fingerprint &&
    String(row.mpa_id) === String(queued.mpa_id) && row.vessel_id === queued.vessel_id &&
    ['complete','incomplete'].includes(row.status) && typeof row.brief_markdown === 'string' &&
    row.brief_markdown.trim() && Array.isArray(row.steps) && Array.isArray(row.events) &&
    row.run_id && row.run_id === report.run?.run_id && Number.isFinite(Date.parse(report.run.finished_at));
}

export function refreshArea(area, cases) {
  const records = cases.filter(row => String(row.mpa_id) === String(area.mpa_id));
  const count = predicate => records.filter(predicate).length;
  const dates = records.map(r => r.investigated_at).filter(Boolean).sort();
  return {...area, n_high:count(r => r.risk_level === 'high'), n_medium:count(r => r.risk_level === 'medium'),
    n_low:count(r => r.risk_level === 'low'), n_incomplete:count(r => r.status === 'incomplete'),
    n_queued:count(r => r.status === 'queued'), n_unidentified:count(r => r.vessel_identified === false),
    n_flagged_for_review:count(r => r.tracking_status === 'flagged_for_review'),
    top_risk_score:records.reduce((max, r) => Math.max(max, Number(r.risk_score) || 0), 0),
    last_investigated_at:dates.at(-1) ?? area.last_investigated_at};
}

export function applyInvestigationResults(snapshot, reports) {
  const byCase = new Map(reports.map(report => [report.case_id,report]));
  const updatedAreas = new Set(), newRuns = new Map();
  const cases = snapshot.cases.map(row => {
    const report = byCase.get(row.case_id);
    if (row.status !== 'queued' || !matchesCase(report, row)) return row;
    updatedAreas.add(String(row.mpa_id));
    newRuns.set(report.run.run_id, report.run);
    return report.case;
  });
  if (!newRuns.size) return snapshot;
  const runs = [...newRuns.values(), ...(snapshot.runs || []).filter(r => !newRuns.has(r.run_id))]
    .sort((a,b) => Date.parse(b.finished_at) - Date.parse(a.finished_at));
  const latest = snapshot.latest_run;
  const latestRun = latest && Date.parse(latest.finished_at) > Date.parse(runs[0].finished_at) ? latest : runs[0];
  return {...snapshot, cases, runs, latest_run:latestRun,
    generated_at:Date.parse(snapshot.generated_at) >= Date.parse(latestRun.finished_at) ? snapshot.generated_at : latestRun.finished_at,
    mpas:snapshot.mpas.map(area => updatedAreas.has(String(area.mpa_id)) ? refreshArea(area,cases) : area)};
}

export function createResultReader(env = process.env, fetchImpl = fetch) {
  const request = createWorkspaceRequest(env, fetchImpl);
  const cache = new Map();
  return async snapshot => {
    const directory = volumePath(env.POSEIDON_VOLUME) + '/investigations';
    const wanted = new Set(snapshot.cases.filter(r => r.status === 'queued' && r.fingerprint).map(resultName));
    for (const name of cache.keys()) if (!wanted.has(name)) cache.delete(name);
    if (!wanted.size) return snapshot;
    const names = new Set();
    let pageToken = '';
    do {
      const query = pageToken ? '?page_token=' + encodeURIComponent(pageToken) : '';
      const listing = await request('/api/2.0/fs/directories' + directory + query);
      if (listing.status === 404) return snapshot; // First run has yet to create this directory.
      if (!listing.ok) throw new Error('Could not list published investigations.');
      const page = await listing.json();
      for (const entry of page.contents || []) if (!entry.is_directory && wanted.has(entry.name)) names.add(entry.name);
      pageToken = page.next_page_token;
    } while (pageToken);
    const pending = [...names].filter(name => !cache.has(name));
    for (let offset = 0; offset < pending.length; offset += 8) {
      await Promise.all(pending.slice(offset, offset + 8).map(async name => {
        const response = await request('/api/2.0/fs/files' + directory + '/' + name);
        if (response.status === 404) return;
        if (!response.ok) throw new Error('Could not read a published investigation.');
        const result = await response.json();
        if (result?.case_id && result?.fingerprint && resultName(result) === name) cache.set(name,result);
      }));
    }
    return applyInvestigationResults(snapshot, [...names].map(name => cache.get(name)).filter(Boolean));
  };
}
