import {validatePublishedExport, exportRevision as publicationRevision} from '../../public/published-export.mjs';

export function exportRevision(data) {
  return JSON.stringify([publicationRevision(data), data.local_report_revision ?? null]);
}

const published = new URL('../../data/poseidon_snapshot.json', import.meta.url);
const sample = new URL('../../data/poseidon_snapshot.sample.json', import.meta.url);

export async function loadWorkspaceSnapshot(fetchImpl = fetch, {signal} = {}) {
  const options = {cache: 'no-cache', signal};
  const real = await fetchImpl(published, options);
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
  const fallback = await fetchImpl(sample, options);
  if (!fallback.ok) throw new Error(`The sample export is unavailable (HTTP ${fallback.status}).`);
  return {data: validatePublishedExport(await fallback.json()), source: 'sample'};
}
