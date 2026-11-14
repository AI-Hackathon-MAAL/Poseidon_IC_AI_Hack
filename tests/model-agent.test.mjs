import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { runModelInvestigation } from '../model-agent.mjs';

const caseRecord = { id: 'clarion-jan-2025', areaId: 'revillagigedo', date: '2025-01-29' };
const allowedNextSteps = ['Request the original observations.', 'Ask an analyst to check the source.'];
const service = {
  DATABRICKS_AGENT_LIVE: '1',
  DATABRICKS_HOST: 'https://test-workspace.cloud.databricks.com',
  DATABRICKS_TOKEN: 'fictional-test-token',
  DATABRICKS_MODEL_ENDPOINT: 'test_endpoint-1',
};
const saved = {};
beforeEach(() => {
  for (const [name, value] of Object.entries(service)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function namedCall(name, id, args = '{}') {
  return { id, type: 'function', function: { name, arguments: args } };
}
function completion(message, reason = 'stop') {
  return { ok: true, json: async () => ({ choices: [{ finish_reason: reason, message: { role: 'assistant', ...message } }] }) };
}
function requestTools(...calls) {
  return completion({ content: null, tool_calls: calls }, 'tool_calls');
}
function conclude(nextStep = allowedNextSteps[0]) {
  return completion({ content: JSON.stringify({ nextStep }) });
}
function callbacks(eventKind = 'gap') {
  return {
    getEvent: () => ({ kind: eventKind }),
    getHistory: () => [],
    getRule: () => ({ text: 'The historical rule was verified.' }),
    searchSources: () => ({ sources: [], mode: 'unavailable' }),
  };
}
function simulate(replies, tools = callbacks(), extraOptions = {}) {
  const requests = [];
  const result = runModelInvestigation(caseRecord, tools, {
    allowedNextSteps, ...extraOptions,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, init, body });
      const reply = replies[requests.length - 1];
      if (!reply) throw new Error('Unexpected extra model call.');
      return typeof reply === 'function' ? reply(body) : reply;
    },
  });
  return { requests, result };
}

test('tool results drive different model requests and both approved next steps can be selected', async () => {
  for (const kind of ['gap', 'transit']) {
    const calls = [];
    const tools = {};
    for (const [name, callback] of Object.entries(callbacks(kind))) {
      tools[name] = (...args) => { calls.push(name); assert.deepEqual(args, []); return callback(); };
    }
    const expectedTool = kind === 'gap' ? 'searchSources' : 'getHistory';
    const selection = allowedNextSteps[kind === 'gap' ? 0 : 1];
    const { requests, result } = simulate([
      requestTools(namedCall('getEvent', 'read')),
      body => {
        const event = JSON.parse(body.messages.at(-1).content);
        return requestTools(namedCall(event.kind === 'gap' ? 'searchSources' : 'getHistory', 'next'));
      },
      conclude(selection),
    ], tools);
    const outcome = await result;
    assert.equal(outcome.mode, 'model');
    assert.equal(outcome.selectedNextStep, selection);
    assert.deepEqual(outcome.usedTools, ['getEvent', expectedTool]);
    assert.deepEqual(calls, outcome.usedTools);
    assert.equal(outcome.steps.length, 2);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, 'https://test-workspace.cloud.databricks.com/serving-endpoints/test_endpoint-1/invocations');
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer ' + service.DATABRICKS_TOKEN);
    assert.equal(requests[0].init.redirect, 'error');
    assert.ok(requests[0].init.signal instanceof AbortSignal);
    assert.equal(requests[0].body.tool_choice, 'required');
    assert.equal(requests[1].body.tool_choice, 'auto');
    assert.deepEqual(requests[1].body.messages.at(-2).tool_calls.map(c => c.id), ['read']);
    assert.equal(Object.hasOwn(requests[1].body.messages.at(-2), 'content'), false);
    assert.equal(requests[1].body.messages.at(-1).tool_call_id, 'read');
    assert.equal(requests[2].body.messages.at(-1).tool_call_id, 'next');
  }
});

test('a multi-tool request correlates each result with its own call ID and bounds the loop', async () => {
  const tools = callbacks();
  const names = Object.keys(tools);
  const { requests, result } = simulate([requestTools(...names.map((name, i) => namedCall(name, 'id_' + i))), conclude()], tools);
  const outcome = await result;
  assert.equal(outcome.mode, 'model');
  assert.deepEqual(outcome.usedTools, names);
  assert.equal(requests[1].body.tool_choice, 'none');
  assert.deepEqual(requests[1].body.messages.slice(-4).map(m => m.tool_call_id), ['id_0', 'id_1', 'id_2', 'id_3']);
});

test('only explicit opt-in, valid workspace origin, endpoint and token allow a network call', async () => {
  const invalid = [
    ['DATABRICKS_AGENT_LIVE', 'true'], ['DATABRICKS_TOKEN', ''], ['DATABRICKS_HOST', ''],
    ['DATABRICKS_HOST', 'http://fake.cloud.databricks.com'],
    ['DATABRICKS_HOST', 'https://outside.test@fake.cloud.databricks.com'],
    ['DATABRICKS_HOST', 'https://fake.cloud.databricks.com.evil.test'],
    ['DATABRICKS_HOST', 'https://fake.cloud.databricks.com:1443'],
    ['DATABRICKS_HOST', 'https://fake.cloud.databricks.com/ignored'],
    ['DATABRICKS_MODEL_ENDPOINT', '../other'], ['DATABRICKS_MODEL_ENDPOINT', ''],
  ];
  for (const [key, value] of invalid) {
    process.env[key] = value;
    const { requests, result } = simulate([]);
    const outcome = await result;
    assert.equal(outcome.mode, 'rules');
    assert.equal(outcome.selectedNextStep, undefined);
    assert.equal(requests.length, 0);
    process.env[key] = service[key];
  }
  for (const valid of ['adb-123.4.azuredatabricks.net', 'https://workspace.gcp.databricks.com/']) {
    process.env.DATABRICKS_HOST = valid;
    const { result } = simulate([requestTools(namedCall('getEvent', 'a')), conclude()]);
    assert.equal((await result).mode, 'model');
  }
});

test('unscoped tool requests are rejected before executing any member of their batch', async () => {
  const invalid = [
    namedCall('getEvent', 'b', '{"caseId":"other"}'), namedCall('getEvent', 'b', 'null'),
    namedCall('__proto__', 'b'), namedCall('constructor', 'b'), namedCall('sendAlert', 'b'),
    namedCall('getRule', 'a'), namedCall('getRule', ''), namedCall('getRule', 'b', '['),
  ];
  for (const call of invalid) {
    const { result } = simulate([requestTools(namedCall('getHistory', 'a'), call)]);
    const outcome = await result;
    assert.equal(outcome.mode, 'rules');
    assert.deepEqual(outcome.usedTools, []);
  }
});

test('a repeated tool request ends the run and cannot invoke the tool twice', async () => {
  const { requests, result } = simulate([
    requestTools(namedCall('getEvent', 'first')),
    requestTools(namedCall('getEvent', 'again')),
  ]);
  const outcome = await result;
  assert.equal(outcome.mode, 'rules');
  assert.deepEqual(outcome.usedTools, ['getEvent']);
  assert.equal(requests.length, 2);
});

test('model prose, extra fields, unfinished output and content-free decisions never appear in the brief', async () => {
  const unsafe = 'unverified-assertion-private-test';
  const invalidDecisions = [
    conclude(unsafe), completion({ content: unsafe }), completion({ content: null }),
    completion({ content: JSON.stringify({ nextStep: allowedNextSteps[0], accusation: unsafe }) }),
    completion({ content: JSON.stringify({ nextStep: allowedNextSteps[0] }) }, 'length'),
  ];
  for (const invalid of invalidDecisions) {
    const { result } = simulate([requestTools(namedCall('getEvent', 'a')), invalid]);
    const outcome = await result;
    assert.equal(outcome.mode, 'rules');
    assert.equal(outcome.selectedNextStep, undefined);
    assert.ok(!JSON.stringify(outcome).includes(unsafe));
  }
  assert.equal((await simulate([conclude()]).result).mode, 'rules');
  assert.equal((await simulate([requestTools(namedCall('getHistory', 'a')), conclude()]).result).mode, 'rules');
});

test('provider and tool failures fall back without exposing the error or credentials', async () => {
  const fakeSecret = 'private-error-test:' + service.DATABRICKS_TOKEN;
  for (const [replies, tools] of [
    [[() => { throw new Error(fakeSecret); }], callbacks()],
    [[{ ok: false, status: 503, json: () => ({ message: fakeSecret }) }], callbacks()],
    [[requestTools(namedCall('getEvent', 'a'))], { ...callbacks(), getEvent: () => { throw new Error(fakeSecret); } }],
    [[requestTools(namedCall('getEvent', 'a'))], { ...callbacks(), getEvent: () => undefined }],
    [[requestTools(namedCall('getEvent', 'a'))], { ...callbacks(), getEvent: () => ({}) }],
  ]) {
    const { result } = simulate(replies, tools);
    const outcome = await result;
    assert.equal(outcome.mode, 'rules');
    assert.ok(!JSON.stringify(outcome).includes(service.DATABRICKS_TOKEN));
    assert.equal(outcome.selectedNextStep, undefined);
  }
});

test('a stalled case tool times out and cannot dispatch a model request after fallback', async () => {
  let resolveTool;
  const getEvent = () => new Promise(resolve => { resolveTool = resolve; });
  const { requests, result } = simulate([requestTools(namedCall('getEvent', 'a')), conclude()], { ...callbacks(), getEvent }, { timeoutMs: 20 });
  const outcome = await result;
  assert.equal(outcome.mode, 'rules');
  assert.equal(requests[0].init.signal.aborted, true);
  resolveTool({ observed: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.deepEqual(outcome.steps, []);
});
