import { readFile } from 'node:fs/promises';
import {validatePublishedExport} from './public/published-export.mjs';
import {createWorkspaceRequest, volumePath} from './app/databricks-workspace.mjs';

const bundledExport = new URL('./data/poseidon_snapshot.json', import.meta.url);

function parseExport(contents) {
  try {
    return validatePublishedExport(JSON.parse(contents.replace(/^\uFEFF/, '')));
  } catch (cause) {
    throw Object.assign(new Error('Invalid Poseidon snapshot.', {cause}), {code: 'INVALID_SNAPSHOT'});
  }
}

// Local demos read an export from disk. A Databricks App reads the same file
// through the Files API with its own service principal.
export function createSnapshotReader(env = process.env, fetchImpl = fetch) {
  const request = createWorkspaceRequest(env, fetchImpl);
  async function fromVolume() {
    const path = volumePath(env.POSEIDON_VOLUME) + '/poseidon_snapshot.json';
    const response = await request('/api/2.0/fs/files' + path);
    if (response.status === 404 || response.status === 410) {
      throw Object.assign(new Error('Databricks export missing.'), {code: 'ENOENT'});
    }
    if (!response.ok) throw new Error('Databricks export unavailable.');
    return parseExport(await response.text());
  }
  return async () => {
    if (env.POSEIDON_VOLUME) return {source: 'export', data: await fromVolume()};
    if (env.DATABRICKS_APP_NAME && !env.POSEIDON_SNAPSHOT_PATH) throw new Error('Missing app volume.');
    const path = env.POSEIDON_SNAPSHOT_PATH || bundledExport;
    const data = parseExport(await readFile(path, 'utf8'));
    return {source: env.POSEIDON_SNAPSHOT_PATH ? 'export' : 'bundled-export', data};
  };
}
