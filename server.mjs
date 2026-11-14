import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { areas, map, replay, listItem, rankCases, investigate, validCatalog } from './investigator.mjs';
import { loadCandidates, recordBrief, readBrief } from './providers.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const assets = new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']]]);
const json = (res,status,data) => res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(data));

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function save(dir, brief) {
  await mkdir(dir,{recursive:true});
  const filename = join(dir, brief.id + '.json');
  const temp = filename + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp,JSON.stringify(brief,null,2),{flag:'wx'});
    await rename(temp,filename);
  } finally {
    await rm(temp,{force:true});
  }
}

export function createApp({dataDir = resolve(root,'.soundings','briefs'), candidates = loadCandidates, store = recordBrief, readStored = readBrief, search, model, lookupHistory} = {}) {
  const pendingRuns = new Map();
  async function complete(record, records, origin) {
    const brief = await investigate(record,records,{search,model,lookupHistory,origin});
    const stored = await store(brief);
    brief.storage = stored.mode === 'stored' ? stored : {mode:'local',detail:'Saved on this computer. ' + stored.detail};
    await save(dataDir,brief);
    return brief;
  }
  async function getCases() {
    const remote = await candidates();
    if (validCatalog(remote)) return {records:remote,origin:'Databricks'};
    return {records:replay,origin:'Published replay'};
  }
  return http.createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const path = (req.url || '/').split('?')[0];
    try {
      if (req.method === 'GET' && assets.has(path)) {
        const [filename,type] = assets.get(path);
        const content = await readAsset(filename);
        return res.writeHead(200,{'Content-Type':type+'; charset=utf-8'}).end(content);
      }
      if (req.method === 'GET' && path === '/api/catalog') {
        const {records,origin} = await getCases();
        return json(res,200,{areas,map,cases:rankCases(records).map(listItem),origin});
      }
      const saved = path.match(/^\/api\/briefs\/([a-zA-Z0-9_-]{1,100})$/);
      if (req.method === 'GET' && saved) {
        let brief;
        try { brief = JSON.parse(await readFile(join(dataDir,saved[1]+'.json'),'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!brief) {
          brief = await readStored(saved[1]);
          if (brief) brief.storage = {mode:'stored',detail:'Retrieved from the Databricks briefs table.'};
        }
        return brief ? json(res,200,brief) : json(res,404,{error:'This case has no saved brief.'});
      }
      if (req.method === 'POST' && path === '/api/investigate') {
        if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) return json(res,403,{error:'Use this local analyst workspace to run an investigation.'});
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res,415,{error:'Send a JSON case ID.'});
        let payload;
        try { payload = await body(req); } catch {return json(res,400,{error:'Supply a small JSON object with a caseId.'});}
        if (typeof payload?.caseId !== 'string') return json(res,400,{error:'Select a case.'});
        const {records,origin} = await getCases();
        const record = records.find(row => row.id === payload.caseId);
        if (!record) return json(res,404,{error:'Case unavailable in this collection.'});
        if (!pendingRuns.has(record.id)) {
          const run = complete(record,records,origin).finally(() => pendingRuns.delete(record.id));
          pendingRuns.set(record.id,run);
        }
        return json(res,200,await pendingRuns.get(record.id));
      }
      return json(res,404,{error:'Unknown resource.'});
    } catch (error) {
      console.error('Soundings request failed', error.code || error.name, path);
      if (!res.headersSent) return json(res,500,{error:'Unable to complete this request. Check the server and try again.'});
      res.end();
    }
  });
}

async function readAsset(name) {
  return readFile(join(root,'public',name));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.on('error', e => { console.error('Unable to start Soundings:',e.code); process.exitCode = 1; });
  app.listen(port,'127.0.0.1',() => console.info('Soundings is open at http://127.0.0.1:' + app.address().port));
}
