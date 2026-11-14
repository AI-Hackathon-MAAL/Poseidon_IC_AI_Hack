import {validatePublishedExport} from '../../public/published-export.mjs';
export {exportRevision} from '../../public/published-export.mjs';

const published = new URL('../../data/poseidon_snapshot.json', import.meta.url);
const sample = new URL('../../data/poseidon_snapshot.sample.json', import.meta.url);

export async function loadWorkspaceSnapshot(fetchImpl = fetch, {signal} = {}) {
  const options = {cache: 'no-cache', signal};
  let response = await fetchImpl(published, options);
  let source = response.headers.get('X-Poseidon-Source') || 'bundled-export';
  if (response.status === 404 || response.status === 410) {
    response = await fetchImpl(sample, options);
    source = 'sample';
  }
  if (!response.ok) throw new Error(`The notebook export is unavailable (HTTP ${response.status}).`);
  const data = validatePublishedExport(await response.json());
  return {data, source};
}
