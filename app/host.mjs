import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository = new URL('../', import.meta.url);
const snapshotFile = fileURLToPath(new URL('data/poseidon_snapshot.json', repository));

// Only these public browser resources are available through the app host.
const files = new Set([
  'app/globe/workspace.mjs', 'app/globe/shell.js', 'app/globe/style.css',
  'app/globe/maritime-map.js', 'app/globe/snapshot-loader.mjs', 'app/globe/agent-context.mjs',
  'app/assets/poseidon.svg', 'app/assets/fonts/inter-latin.woff2',
  'app/assets/earth-relief.webp', 'app/assets/pacific-relief.webp',
  'public/style.css', 'public/maritime-map.css', 'public/snapshot-drawer.js',
  'public/case-query.mjs', 'public/snapshot-workspace.mjs', 'public/vessel-photo.mjs',
  'public/published-export.mjs',
  'data/poseidon_snapshot.sample.json',
]);
const types = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

export async function serveGlobe(path, res) {
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
    const page = template.replace('href="./globe/archive.html"', 'href="/archive"')
      .replaceAll('src="./', 'src="/app/').replaceAll('href="./', 'href="/app/');
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'}).end(page);
    return true;
  }
  const filename = path.slice(1);
  if (!files.has(filename)) return false;
  const bytes = await readFile(new URL(filename, repository));
  res.writeHead(200, {'Content-Type': types[extname(filename)], 'Cache-Control': 'no-cache'}).end(bytes);
  return true;
}

// A missing checked-in export can use the documented sample. Configuration,
// permission, validation and upstream failures remain visible as unavailable.
export function isMissingBundledExport(error, env = process.env) {
  return error?.code === 'ENOENT' && error.path === snapshotFile &&
    !env.POSEIDON_VOLUME && !env.POSEIDON_SNAPSHOT_PATH && !env.DATABRICKS_APP_NAME;
}
