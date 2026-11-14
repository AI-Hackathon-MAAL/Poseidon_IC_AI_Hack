import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const dataDir = new URL('../data/', import.meta.url);
const { map } = JSON.parse(await readFile(new URL('areas.json', dataDir), 'utf8'));
export const effectiveDate = '2017-11-28';

export function within(lon, lat, [west, south, east, north] = map.bounds) {
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

export function makeCandidate(row) {
  const stamp = (s) => new Date(s.replace(' ', 'T')).toISOString();
  const start = stamp(row.gap_start_timestamp), end = stamp(row.gap_end_timestamp);
  const point = (key, label) => {
    const xy = [row['gap_' + key + '_lon'], row['gap_' + key + '_lat']];
    if (xy.some(v => v == null || v.trim() === '' || !Number.isFinite(Number(v)))) {
      throw new Error('Invalid coordinates for ' + row.gap_id);
    }
    const [lon, lat] = xy.map(Number);
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new Error('Out-of-range coordinate');
    return { lon, lat, label };
  };
  const points = [point('start', 'Last signal'), point('end', 'Signal resumed')];
  if (start < effectiveDate || end <= start || !points.some(p => within(p.lon, p.lat))) return null;
  return {
    id:row.gap_id, areaId:'revillagigedo', kind:'AIS reporting gap',
    title:within(points[1].lon, points[1].lat) ? 'Signal resumes inside the park' : 'Signal lost inside the park',
    vessel:'MMSI ' + row.mmsi, mmsi:row.mmsi, date:start.slice(0,10), endDate:end.slice(0,10),
    start, end, mapPoints:points, evidenceType:'measured-gap', location:'Eastern tropical Pacific',
    datasetHours:Number(row.gap_hours), gear:row.vessel_class
  };
}

// This release uses unquoted, comma-delimited fields. Fail closed if its format changes.
export async function importGaps(file) {
  const lines = createInterface({ input:createReadStream(file), crlfDelay:Infinity });
  let fields, count = 0;
  const selected = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (line.includes('"')) throw new Error('Unexpected CSV quoting; verify release schema.');
    const cells = line.split(',');
    if (!fields) {
      fields = cells;
      for (const col of ['gap_id','mmsi','gap_start_timestamp','gap_end_timestamp','gap_hours']) {
        if (!fields.includes(col)) throw new Error('Missing column ' + col);
      }
      continue;
    }
    if (cells.length !== fields.length) throw new Error('Invalid row width');
    const event = makeCandidate(Object.fromEntries(fields.map((key, i) => [key, cells[i]])));
    if (event) selected.push(event);
    count++;
  }
  selected.sort((a,b) => a.start.localeCompare(b.start));
  return { inspected:count, events:selected };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: npm run import:gaps -- path/to/disabling_events.csv');
  const result = await importGaps(process.argv[2]);
  await writeFile(new URL('gaps.json', dataDir), JSON.stringify(result,null,2) + '\n');
  console.info(`Read ${result.inspected} events; selected ${result.events.length}.`);
}
