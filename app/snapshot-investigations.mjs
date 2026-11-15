import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {refreshArea} from './investigation-results.mjs';

const script = fileURLToPath(new URL('./snapshot_case.py', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const problem = (status, message) => Object.assign(new Error(message), {status});
const hasBrief = row => row.status !== 'queued' && typeof row.brief_markdown === 'string' && Boolean(row.brief_markdown.trim());

function isSampleCase(snapshot, row) {
  const run = snapshot.latest_run?.run_id === row.run_id ? snapshot.latest_run :
    snapshot.runs?.find(item => item.run_id === row.run_id);
  return row.synthetic === true || row.data_source === 'sample' || String(row.mpa_id).startsWith('sample-') ||
    run?.synthetic === true || run?.data_source === 'sample' || run?.llm_endpoint === 'sample-scripted-model';
}

export function runSnapshotPython(snapshot, caseId) {
  const python = process.env.POSEIDON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  return new Promise((resolve, reject) => {
    const child = execFile(python, ['-X', 'utf8', script], {
      windowsHide:true, timeout:60000, maxBuffer:8 * 1024 * 1024, encoding:'utf8'
    }, (error, stdout) => {
      if (error) {
        return reject(problem(503, error.code === 'ENOENT'
          ? 'Python is unavailable on the app server. Install Python or set POSEIDON_PYTHON.'
          : 'The Python agent could not finish this report. Try again.'));
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(problem(502, 'The Python agent returned an unreadable report.')); }
    });
    child.stdin.on('error', error => {
      // A missing or failed interpreter may close its pipe; execFile reports why.
      if (error.code !== 'EPIPE' && error.code !== 'EOF') reject(error);
    });
    child.stdin.end(JSON.stringify({snapshot, caseId}));
  });
}

function matches(row, original) {
  return row && row.report_origin === 'snapshot-python' &&
    row.case_id === original.case_id && row.fingerprint === original.fingerprint &&
    row.vessel_id === original.vessel_id && String(row.mpa_id) === String(original.mpa_id) &&
    ['complete', 'incomplete'].includes(row.status) && hasBrief(row) &&
    Number.isFinite(row.risk_score) && Array.isArray(row.reasons) && Array.isArray(row.steps);
}

export function createSnapshotInvestigations(directory, run = runSnapshotPython) {
  const active = new Map();
  // Cross-case vessel history and area boundaries are evidence too. A case's
  // event fingerprint alone cannot identify the snapshot used for its report.
  function publicationDirectory({source, data}) {
    return join(directory, hash(source + '\n' + JSON.stringify(data)));
  }
  async function readResult(path, original) {
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      return matches(saved, original) ? saved : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  async function generate(publication, caseId, fingerprint) {
    const original = publication.data.cases.find(row => row.case_id === caseId);
    if (!original) throw problem(404, 'This case is absent from the published snapshot.');
    if (isSampleCase(publication.data, original)) throw problem(409, 'Select a case from the real snapshot.');
    if (original.fingerprint !== fingerprint) throw problem(409, 'This case changed. Refresh and select it again.');
    if (hasBrief(original)) return original;
    const dir = publicationDirectory(publication);
    const path = join(dir, hash(caseId) + '.json');
    if (active.has(path)) return active.get(path);
    if (active.size >= 4) throw problem(429, 'The agent is processing other reports. Try again shortly.');
    const task = (async () => {
      const saved = await readResult(path, original);
      if (saved) return saved;
      const realCases = publication.data.cases.filter(candidate => !isSampleCase(publication.data, candidate));
      const row = await run({...publication.data, cases:realCases}, caseId);
      if (!matches(row, original)) throw problem(502, 'The Python report did not match this case.');
      await mkdir(dir, {recursive:true});
      const temporary = path + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(row), {flag:'wx'});
        await rename(temporary, path);
      } finally {
        await rm(temporary, {force:true});
      }
      return row;
    })();
    active.set(path, task);
    try { return await task; }
    finally { active.delete(path); }
  }
  async function overlay(publication) {
    const dir = publicationDirectory(publication);
    let files;
    try { files = new Set(await readdir(dir)); }
    catch (error) {
      if (error.code === 'ENOENT') return publication;
      throw error;
    }
    const updatedAreas = new Set(), updatedCases = [];
    const cases = await Promise.all(publication.data.cases.map(async original => {
      if (hasBrief(original)) return original;
      const filename = hash(original.case_id) + '.json';
      if (!files.has(filename)) return original;
      const row = await readResult(join(dir, filename), original);
      if (!row) return original;
      updatedAreas.add(String(original.mpa_id));
      updatedCases.push(original.case_id);
      return row;
    }));
    if (!updatedCases.length) return publication;
    const mpas = publication.data.mpas.map(area => updatedAreas.has(String(area.mpa_id)) ? refreshArea(area, cases) : area);
    return {...publication, data:{...publication.data, cases, mpas, local_report_revision:hash(JSON.stringify(updatedCases.sort()))}};
  }
  return {generate, overlay};
}
