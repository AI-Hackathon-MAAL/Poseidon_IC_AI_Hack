import { readFile } from 'node:fs/promises';
import {validatePublishedExport} from './public/published-export.mjs';

const bundledExport = new URL('./data/poseidon_snapshot.json', import.meta.url);

function parseExport(contents) {
  try {
    return validatePublishedExport(JSON.parse(contents.replace(/^\uFEFF/, '')));
  } catch (cause) {
    throw Object.assign(new Error('Invalid Poseidon snapshot.', {cause}), {code: 'INVALID_SNAPSHOT'});
  }
}

function workspaceOrigin(value) {
  const url = new URL(value?.includes('://') ? value : 'https://' + value);
  const supported = /\.(?:cloud\.databricks\.(?:com|us)|gcp\.databricks\.com|azuredatabricks\.net|databricks\.azure\.(?:us|cn))$/i;
  if (url.protocol !== 'https:' || !supported.test(url.hostname) || url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid Databricks workspace host.');
  }
  return url.origin;
}

// Local demos read an export from disk. A Databricks App reads the same file
// through the Files API with its own service principal.
export function createSnapshotReader(env = process.env, fetchImpl = fetch) {
  let token;
  let expiresAt = 0;
  async function fromVolume() {
    const {POSEIDON_VOLUME, DATABRICKS_HOST, DATABRICKS_CLIENT_ID, DATABRICKS_CLIENT_SECRET} = env;
    if (!/^\/Volumes\/(?:[\w-]+\/){2}[\w-]+\/?$/.test(POSEIDON_VOLUME) ||
        !DATABRICKS_CLIENT_ID || !DATABRICKS_CLIENT_SECRET) throw new Error('Incomplete volume configuration.');
    const origin = workspaceOrigin(DATABRICKS_HOST);
    if (!token || Date.now() >= expiresAt) {
      const credentials = Buffer.from(DATABRICKS_CLIENT_ID + ':' + DATABRICKS_CLIENT_SECRET).toString('base64');
      const response = await fetchImpl(origin + '/oidc/v1/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {Authorization: 'Basic ' + credentials},
        body: new URLSearchParams({grant_type: 'client_credentials', scope: 'all-apis'}),
      });
      if (!response.ok) throw new Error('App authentication failed.');
      const auth = await response.json();
      if (typeof auth.access_token !== 'string' || !auth.access_token) throw new Error('No app access token.');
      token = auth.access_token;
      expiresAt = Date.now() + Math.max(0, Number(auth.expires_in || 0) - 60) * 1000;
    }
    const path = POSEIDON_VOLUME.replace(/\/$/, '') + '/poseidon_snapshot.json';
    const response = await fetchImpl(origin + '/api/2.0/fs/files' + path, {
      headers: {Authorization: 'Bearer ' + token}, redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (response.status === 401) token = undefined;
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
