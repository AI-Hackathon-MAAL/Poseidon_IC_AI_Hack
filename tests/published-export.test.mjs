import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPublishedExport, exportRevision} from '../public/published-export.mjs';

const empty = {product:'Poseidon',latest_run:null,mpas:[],cases:[],news:[],runs:[]};
test('reads each completed publication afresh, including valid empty results', async () => {
  let requests = 0;
  const signal = new AbortController().signal;
  const read = () => loadPublishedExport(async (url, opts) => {
    assert.equal(url, '/api/snapshot');
    assert.equal(opts.cache, 'no-store');
    assert.equal(opts.signal, signal);
    const generated_at = '2026-11-14T21:00:0' + (++requests) + 'Z';
    return Response.json({...empty,generated_at}, {headers:{'X-Poseidon-Source':'bundled-export'}});
  }, {signal});
  const first = await read();
  const second = await read();
  assert.equal(first.source, 'bundled-export');
  assert.notEqual(exportRevision(first.data), exportRevision(second.data));
});

test('incomplete and failed responses cannot replace the displayed export', async () => {
  await assert.rejects(loadPublishedExport(async () => Response.json({error:'unavailable'},{status:503})), /unavailable/);
  await assert.rejects(loadPublishedExport(async () => new Response('{"product":"Poseidon",')));
  await assert.rejects(loadPublishedExport(async () => Response.json({...empty, latest_run:{}})), /incomplete/);
  await assert.rejects(loadPublishedExport(async () => Response.json({...empty, cases:[{case_id:'a',mpa_id:'x', events:{}}]})), /incomplete/);
});
