/** The notebook also publishes a valid empty snapshot when its run has no matching cases. */
export function validatePublishedExport(data) {
  if (data?.product === 'Poseidon' && (Array.isArray(data.cases) || Array.isArray(data.mpas))) {
    data = {...data, cases: data.cases ?? [], mpas: data.mpas ?? [], news: data.news ?? [],
      runs: data.runs ?? [], global_news: data.global_news ?? [], latest_run: data.latest_run ?? null};
  }
  const lists = ['cases', 'mpas', 'news', 'runs', 'global_news'];
  if (data?.product !== 'Poseidon' || !lists.every(key => Array.isArray(data[key])) ||
      !Object.hasOwn(data, 'latest_run') ||
      (data.latest_run !== null && typeof data.latest_run?.run_id !== 'string') ||
      !data.cases.every(row => typeof row?.case_id === 'string' && row.mpa_id != null &&
        (row.events == null || Array.isArray(row.events)) && (row.steps == null || Array.isArray(row.steps))) ||
      !data.mpas.every(row => row?.mpa_id != null) ||
      !data.runs.every(row => typeof row?.run_id === 'string') ||
      !data.news.every(row => row && typeof row === 'object')) {
    throw new Error('The notebook export is incomplete.');
  }
  return data;
}

/** Re-read the publisher's one finished document. Leave retry/selection to the caller. */
export async function loadPublishedExport(fetchImpl = fetch, {signal} = {}) {
  const response = await fetchImpl('/api/snapshot', {cache:'no-store', signal});
  if (!response.ok) throw new Error('The notebook export is unavailable.');
  const data = validatePublishedExport(await response.json());
  return {data, source:response.headers.get('X-Poseidon-Source') || 'export'};
}

export function exportRevision(data) {
  // Both supported notebook versions stamp every publication. Old imported files
  // without a publication time need their payload compared, including the briefs.
  if (!data.generated_at) return JSON.stringify(data);
  return JSON.stringify([data.generated_at, data.latest_run?.run_id, data.latest_run?.finished_at,
    data.cases.length, data.mpas.length, data.news.length, data.runs.length]);
}
