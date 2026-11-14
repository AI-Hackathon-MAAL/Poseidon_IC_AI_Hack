import { createHash } from 'node:crypto';

const sourceLimit = 5;
const candidateLimit = 500;

function allowedDomain(value) {
  if (typeof value !== 'string') return null;
  const domain = value.trim().toLowerCase().replace(/^www\./, '');
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain) ? domain : null;
}

export async function searchOfficial(caseRecord) {
  const unavailable = detail => ({ mode: 'unavailable', sources: [], detail });
  if (process.env.LINKUP_LIVE !== '1' || !process.env.LINKUP_API_KEY) {
    return unavailable('Live Linkup search is disabled or unconfigured.');
  }
  const query = typeof caseRecord?.searchQuery === 'string' ? caseRecord.searchQuery.trim() : '';
  const domainList = Array.isArray(caseRecord?.searchDomains) ? caseRecord.searchDomains : [];
  const domains = [...new Set(domainList.map(allowedDomain).filter(Boolean))];
  if (!query || !domains.length) return unavailable('No official-source query is configured for this area.');

  try {
    const response = await fetch('https://api.linkup.so/v1/search', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(9000),
      headers: { Authorization: 'Bearer ' + process.env.LINKUP_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: query, depth: 'standard', outputType: 'searchResults',
        includeDomains: domains, maxResults: sourceLimit, includeImages: false,
      }),
    });
    if (!response.ok) return unavailable('Linkup returned HTTP ' + response.status + '.');
    const body = await response.json();
    const sources = [];
    const seen = new Set();
    for (const entry of Array.isArray(body.results) ? body.results : []) {
      if (entry?.type === 'image' || typeof entry?.url !== 'string' || !URL.canParse(entry.url)) continue;
      const url = new URL(entry.url);
      if (url.protocol !== 'https:' || url.port || url.username || url.password) continue;
      if (!domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const title = typeof entry.name === 'string' ? entry.name.trim() : '';
      sources.push({ title: title || url.hostname, url: url.href });
      if (sources.length === sourceLimit) break;
    }
    return sources.length
      ? { mode: 'live', sources, detail: 'Linkup returned ' + sources.length + ' matching source links.' }
      : unavailable('Linkup returned no links on the configured source domains.');
  } catch {
    return unavailable('Linkup search could not complete within the request window.');
  }
}

function warehouseConfig(table) {
  const { DATABRICKS_LIVE, DATABRICKS_HOST, DATABRICKS_WAREHOUSE_ID, DATABRICKS_TOKEN } = process.env;
  if (DATABRICKS_LIVE !== '1' || !DATABRICKS_HOST || !DATABRICKS_WAREHOUSE_ID || !DATABRICKS_TOKEN) return null;
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*){2}$/i.test(table || '')) return null;
  try {
    const url = new URL(DATABRICKS_HOST.includes('://') ? DATABRICKS_HOST : 'https://' + DATABRICKS_HOST);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (!/\.(?:databricks\.com|azuredatabricks\.net|databricks\.us)$/.test(url.hostname)) return null;
    return { endpoint: url.origin + '/api/2.0/sql/statements', warehouse: DATABRICKS_WAREHOUSE_ID, token: DATABRICKS_TOKEN };
  } catch {
    return null;
  }
}

// CANCEL bounds warehouse work as well as HTTP waiting. Only Databricks' final state confirms a write.
async function execute(config, statement, parameters) {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      warehouse_id: config.warehouse, statement, parameters,
      wait_timeout: '10s', on_wait_timeout: 'CANCEL', disposition: 'INLINE', format: 'JSON_ARRAY',
    }),
  });
  if (!response.ok) throw new Error('Databricks returned HTTP ' + response.status + '.');
  const body = await response.json();
  if (body.status?.state !== 'SUCCEEDED') throw new Error('Databricks did not confirm statement completion.');
  return body;
}

function stringParam(name, value) {
  return { name, value, type: 'STRING' };
}

function briefId(brief, payload) {
  return typeof brief.id === 'string' && brief.id.trim()
    ? brief.id
    : createHash('sha256').update(payload).digest('hex');
}

function resultRows(body) {
  if (body.manifest?.truncated || body.result?.next_chunk_index != null) return null;
  const rows = body.result?.data_array ?? (body.manifest?.total_row_count === 0 ? [] : null);
  return Array.isArray(rows) ? rows : null;
}

export async function recordBrief(brief) {
  const table = process.env.DATABRICKS_BRIEFS_TABLE;
  const config = warehouseConfig(table);
  if (!config) return { mode: 'unavailable', detail: 'Databricks brief storage is disabled or unconfigured.' };
  try {
    if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
      return { mode: 'unavailable', detail: 'The brief must be a JSON object.' };
    }
    const payload = JSON.stringify(brief);
    const id = briefId(brief, payload);
    const statement = [
      'MERGE INTO IDENTIFIER(:table_name) AS target',
      'USING (SELECT :brief_id AS brief_id, :payload AS payload) AS source',
      'ON target.brief_id = source.brief_id',
      'WHEN MATCHED AND target.payload <> source.payload THEN',
      '  UPDATE SET payload = source.payload, recorded_at = current_timestamp()',
      'WHEN NOT MATCHED THEN',
      '  INSERT (brief_id, payload, recorded_at) VALUES (source.brief_id, source.payload, current_timestamp())',
    ].join('\n');
    await execute(config, statement, [stringParam('table_name', table), stringParam('brief_id', id), stringParam('payload', payload)]);
    return { mode: 'stored', detail: 'Databricks confirmed the brief in the Delta table.' };
  } catch {
    return { mode: 'unavailable', detail: 'Databricks did not confirm this brief was saved.' };
  }
}

export async function readBrief(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  const table = process.env.DATABRICKS_BRIEFS_TABLE;
  const config = warehouseConfig(table);
  if (!config) return null;
  try {
    const statement = 'SELECT payload FROM IDENTIFIER(:table_name) WHERE brief_id = :brief_id LIMIT 2';
    const body = await execute(config, statement, [stringParam('table_name', table), stringParam('brief_id', id)]);
    const rows = resultRows(body);
    if (rows?.length !== 1 || !Array.isArray(rows[0]) || typeof rows[0][0] !== 'string') return null;
    const payload = rows[0][0];
    const brief = JSON.parse(payload);
    if (!brief || typeof brief !== 'object' || Array.isArray(brief) || briefId(brief, payload) !== id) return null;
    return brief;
  } catch {
    return null;
  }
}

export async function loadCandidates() {
  const table = process.env.DATABRICKS_CANDIDATES_TABLE;
  const config = warehouseConfig(table);
  if (!config) return null;
  try {
    const statement = [
      'WITH records AS (SELECT DISTINCT payload FROM IDENTIFIER(:table_name))',
      'SELECT payload FROM records',
      "ORDER BY get_json_object(payload, '$.date') DESC, get_json_object(payload, '$.id'), payload",
      'LIMIT ' + (candidateLimit + 1),
    ].join('\n');
    const body = await execute(config, statement, [stringParam('table_name', table)]);
    const rows = resultRows(body);
    if (!rows || rows.length > candidateLimit) return null;
    const records = rows.map(([payload]) => JSON.parse(payload));
    const ids = new Set();
    for (const record of records) {
      if (!record || !['id', 'date', 'areaId', 'kind'].every(key => typeof record[key] === 'string' && record[key].trim())) return null;
      if (ids.has(record.id)) return null;
      ids.add(record.id);
    }
    return records;
  } catch {
    return null;
  }
}
