// The Ollama connection: the request it sends, how it reads the reply, and the whole assistant flow over HTTP to a
// pretend Ollama server (fetch is replaced for that one host only; the test's own calls to the app pass through).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { userWithHistory } from './forecast-fixtures.js';
import { toOllamaRequest, fromOllamaResponse } from '../src/services/assistant.js';

const HOST = 'http://ollama.test:11434';
const realFetch = globalThis.fetch;
let app;
let user;
let sent; // the requests the pretend Ollama received
let script; // (requestBody, n) => { status?, body }

before(async () => {
  process.env.OLLAMA_MODEL = 'llama3.1';
  process.env.OLLAMA_BASE_URL = `${HOST}/`; // the trailing slash must not break the address
  delete process.env.OLLAMA_API_KEY;
  app = await startApp();
  const { query } = await import('../src/utils/db.js');
  const { setAiDriver } = await import('../src/services/assistant.js');
  setAiDriver(null); // the real Ollama driver
  user = await userWithHistory(app, query);
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith(HOST)) return realFetch(url, init);
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), headers: init.headers, body });
    const { status = 200, body: reply } = script(body, sent.length);
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_BASE_URL;
  await app.stop();
});

const ask = (message) => app.api('POST', '/api/assistant', { token: user.token, body: { message } });

test('toOllamaRequest: system first, tools as functions, tool results tied to the tool they answer', () => {
  const messages = [
    { role: 'user', content: 'Can I afford 500?' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'forecast', input: { amount: 500 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}' }] },
  ];
  const tools = [{ name: 'forecast', description: 'd', input_schema: { type: 'object', properties: {} } }];
  const req = toOllamaRequest({ system: 'RULES', messages, tools });
  assert.deepEqual(req.messages[0], { role: 'system', content: 'RULES' });
  assert.deepEqual(req.messages[1], { role: 'user', content: 'Can I afford 500?' });
  assert.deepEqual(req.messages[2].tool_calls, [{ function: { name: 'forecast', arguments: { amount: 500 } } }]);
  assert.deepEqual(req.messages[3], { role: 'tool', tool_name: 'forecast', content: '{"ok":true}' });
  assert.deepEqual(req.tools[0], { type: 'function', function: { name: 'forecast', description: 'd', parameters: { type: 'object', properties: {} } } });
});

test('fromOllamaResponse: text, tool calls (arguments as an object or as a JSON string), and junk', () => {
  assert.deepEqual(fromOllamaResponse({ message: { content: ' hello ' } }).content, [{ type: 'text', text: ' hello ' }]);
  const calls = fromOllamaResponse({ message: { content: '', tool_calls: [{ function: { name: 'forecast', arguments: { amount: 5 } } }, { function: { name: 'forecast', arguments: '{"amount":7}' } }, { function: { name: 'forecast', arguments: 'not json' } }] } }).content;
  assert.deepEqual(calls.map((c) => [c.type, c.name, c.input]), [['tool_use', 'forecast', { amount: 5 }], ['tool_use', 'forecast', { amount: 7 }], ['tool_use', 'forecast', {}]]);
  assert.deepEqual(fromOllamaResponse(null).content, []);
  assert.deepEqual(fromOllamaResponse({}).content, []);
});

test('end to end: the model calls the forecast tool (even with the amount as text) and the reply is checked', async () => {
  sent = [];
  script = (body, n) => (n === 1
    ? { body: { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'forecast', arguments: { amount: '500' } } }] } } }
    : { body: { message: { role: 'assistant', content: `Buying 500 leaves about a ${JSON.parse(body.messages.at(-1).content).purchase.chanceOfRunningOutPercent}% chance of running out.` } } });
  const res = await ask('Can I afford 500?');
  assert.equal(res.status, 200);
  assert.equal(res.body.replacedUnverifiedReply, false);
  assert.match(res.body.reply, /Buying 500 leaves about a \d+% chance/);
  assert.equal(res.body.facts[0].result.purchase.amount, 500); // "500" became the number 500
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, `${HOST}/api/chat`);
  assert.equal(sent[0].body.model, 'llama3.1');
  assert.equal(sent[0].body.stream, false);
  assert.equal(sent[0].body.options.temperature, 0);
  assert.equal(sent[0].body.tools[0].function.name, 'forecast');
  assert.equal(sent[1].body.messages.at(-1).role, 'tool');
  assert.equal(sent[0].headers.authorization, undefined);
  assert.ok(!JSON.stringify(sent).includes(user.user.email)); // privacy
});

test('a number the local model invents is still caught', async () => {
  sent = [];
  script = (body, n) => (n === 1
    ? { body: { message: { tool_calls: [{ function: { name: 'forecast', arguments: { amount: 500 } } }] } } }
    : { body: { message: { content: 'You will keep exactly 424242 after this.' } } });
  const res = await ask('Can I afford 500?');
  assert.equal(res.body.replacedUnverifiedReply, true);
  assert.doesNotMatch(res.body.reply, /424242/);
});

test('an API key is sent as a bearer token when one is configured; Ollama errors become a 502', async () => {
  process.env.OLLAMA_API_KEY = 'test-key-123';
  sent = [];
  script = () => ({ status: 500, body: { error: 'model crashed' } });
  const res = await ask('Can I afford 500?');
  delete process.env.OLLAMA_API_KEY;
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(res.body), /model crashed/);
  assert.equal(sent[0].headers.authorization, 'Bearer test-key-123');
});
