import { readFile } from 'node:fs/promises';

const table = process.argv[2] || 'soundings_candidates';
if (!/^(?:[a-zA-Z_][\w]*\.){0,2}[a-zA-Z_][\w]*$/.test(table)) throw new Error('Pass a SQL table name.');
const load = async name => JSON.parse(await readFile(new URL('../data/' + name,import.meta.url),'utf8'));
const rows = [...(await load('gaps.json')).events, ...await load('reports.json')];
const values = rows.map(row => "  ('" + Buffer.from(JSON.stringify(row)).toString('base64') + "')");
// Encode as base64 to preserve apostrophes and backslashes independently of SQL string settings.
console.log(`MERGE INTO ${table} t
USING (SELECT decode(unbase64(b64),'UTF-8') AS payload FROM VALUES
${values.join(',\n')}
AS v(b64)) s
ON get_json_object(t.payload,'$.id') = get_json_object(s.payload,'$.id')
WHEN MATCHED THEN UPDATE SET payload = s.payload
WHEN NOT MATCHED THEN INSERT (payload) VALUES (s.payload);`);
