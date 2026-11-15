import {validatePublishedExport} from '../published-export.mjs';
export {exportRevision} from '../published-export.mjs';

const apiSnapshot = '/api/snapshot';
const published = '/data/poseidon_snapshot.json';
const sample = '/data/poseidon_snapshot.sample.json';

export async function loadWorkspaceSnapshot(fetchImpl = fetch, {signal} = {}) {
  const options = {cache: 'no-cache', signal};
  for (const url of [apiSnapshot, published]) {
    const real = await fetchImpl(url, options);
    if (real.ok) {
      // Read the bytes outside the parse check. An interrupted transfer is an
      // outage; a completed file containing invalid JSON is a broken publication.
      const contents = await real.text();
      try {
        const data = validatePublishedExport(JSON.parse(contents));
        return {data, source: real.headers.get('X-Poseidon-Source') || 'bundled-export'};
      } catch {
        // A static host can return HTML or an incomplete snapshot with HTTP 200.
      }
    } else if (![404, 410, 422].includes(real.status)) {
      throw new Error(`The notebook export is unavailable (HTTP ${real.status}).`);
    }
  }
  const fallback = await fetchImpl(sample, options);
  if (!fallback.ok) throw new Error(`The sample export is unavailable (HTTP ${fallback.status}).`);
  return {data: validatePublishedExport(await fallback.json()), source: 'sample'};
}
