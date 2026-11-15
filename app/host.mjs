import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';

const repository = new URL('../', import.meta.url);

// Only these public browser resources are available through the app host.
const files = new Set([
  'app/globe/workspace.mjs', 'app/globe/shell.js', 'app/globe/style.css', 'app/globe/investigation-control.mjs',
  'app/globe/area-explorer.mjs', 'app/globe/area-explorer.css',
  'app/globe/watch-summary.mjs', 'app/globe/watch-summary.css', 'app/globe/news-feed.mjs',
  'app/globe/agent-report.mjs', 'app/globe/report.css',
  'app/globe/geo-layers.js', 'app/globe/geo-layers.css', 'app/globe/detail-relief.js',
  'app/globe/maritime-map.js', 'app/globe/snapshot-loader.mjs', 'app/globe/agent-context.mjs',
  'app/assets/poseidon.svg', 'app/assets/fonts/inter-latin.woff2',
  'app/assets/earth-relief.webp', 'app/assets/pacific-relief.webp',
  'public/style.css', 'public/maritime-map.css', 'public/snapshot-drawer.js',
  'public/case-query.mjs', 'public/snapshot-workspace.mjs', 'public/vessel-photo.mjs',
  'public/published-export.mjs',
  'data/poseidon_snapshot.sample.json','data/mpa_index.json',
]);
const types = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

export async function serveGlobe(path, res, investigationsEnabled = false) {
  if (path === '/app') {
    res.writeHead(302, {Location: '/app/'}).end();
    return true;
  }
  if (path === '/app/globe/archive.html') {
    res.writeHead(302, {Location: '/archive'}).end();
    return true;
  }
  if (path === '/' || path === '/app/' || path === '/app/index.html') {
    const template = await readFile(new URL('app/index.html', repository), 'utf8');
    // Qualify the app's local assets for its root alias. Fragment links still
    // target the current page and preserve the analyst's selection.
    const page = template.replace('data-investigation-api=""', investigationsEnabled ? 'data-investigation-api="/api/investigations"' : 'data-investigation-api=""')
      .replace('href="./globe/archive.html"', 'href="/archive"')
      .replaceAll('src="./', 'src="/app/').replaceAll('href="./', 'href="/app/');
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'}).end(page);
    return true;
  }
  const filename = path.slice(1);
  const terrainTile = /^app\/assets\/terrain\/(?:[0-9]|1[0-9]|2[0-3])-(?:[0-9]|1[01])\.webp$/.test(filename);
  if (!files.has(filename) && !terrainTile) return false;
  let bytes;
  try { bytes = await readFile(new URL(filename, repository)); }
  catch (error) {
    if (filename !== 'data/mpa_index.json' || error.code !== 'ENOENT') throw error;
    // The optional index was not published. The explorer still searches the watched areas.
    res.writeHead(200, {'Content-Type': types['.json'], 'Cache-Control':'no-cache'}).end('[]');
    return true;
  }
  res.writeHead(200, {'Content-Type': types[extname(filename)], 'Cache-Control': 'no-cache'}).end(bytes);
  return true;
}
