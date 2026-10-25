// The AI assistant, with a fake model (no network, no API key). The point of these tests is the guard rails: the model only
// gets numbers from the forecast engine, and any other number in its answer is thrown away.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { userWithHistory } from './forecast-fixtures.js';

delete process.env.OLLAMA_MODEL;

let app;
let query;
let setAiDriver;
let user;
before(async () => {
  app = await startApp();
  ({ query } = await import('../src/utils/db.js'));
  ({ setAiDriver } = await import('../src/services/assistant.js'));
  user = await userWithHistory(app, query);
});
after(() => app.stop());

const ask = (message) => app.api('POST', '/api/assistant', { token: user.token, body: { message } });
const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const useTool = (input, name = 'forecast') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_1', name, input }] });
const toolResultOf = (args) => JSON.parse(args.messages.at(-1).content[0].content);
function fakeModel(script) {
  const calls = [];
  setAiDriver({ async complete(args) { calls.push(structuredClone(args)); return script(args, calls.length); } });
  return calls;
}

test('without an Ollama model configured on the server it answers 503, not a crash', async () => {
  const res = await ask('Can I afford 500?');
  assert.equal(res.status, 503);
  assert.match(res.body.error, /not set up/);
});

test('it asks the forecast engine and the reply may quote the engine\'s numbers', async () => {
  const calls = fakeModel((args, n) => {
    if (n === 1) return useTool({ amount: 500 });
    const r = toolResultOf(args);
    return text(`Buying 500 leaves about a ${r.purchase.chanceOfRunningOutPercent}% chance of running out. The most that is safe now is ${r.largestSafePurchaseNow}.`);
  });
  const res = await ask('Can I afford a thing that costs 500?');
  assert.equal(res.status, 200);
  assert.equal(res.body.replacedUnverifiedReply, false);
  assert.equal(res.body.checked, true);
  assert.match(res.body.reply, /Buying 500/);
  assert.equal(res.body.facts.length, 1);
  assert.deepEqual(res.body.facts[0].input, { amount: 500 });
  assert.equal(res.body.facts[0].result.purchase.verdict, 'Safe');
  assert.equal(calls.length, 2);
  // the model was told it has the forecast tool and that it must not calculate
  assert.equal(calls[0].tools[0].name, 'forecast');
  assert.match(calls[0].system, /never calculate/);
});

test('a number the model made up is caught: the reply is replaced by the engine\'s own summary', async () => {
  fakeModel((args, n) => (n === 1 ? useTool({ amount: 500 }) : text('You will have exactly 777777 left over, and a 3% chance of trouble.')));
  const res = await ask('Can I afford 500?');
  assert.equal(res.status, 200);
  assert.equal(res.body.replacedUnverifiedReply, true);
  assert.doesNotMatch(res.body.reply, /777777/);
  assert.equal(res.body.reply, res.body.facts[0].result.summary);
});

test('arithmetic done by the model is caught too (a number that is not in the results)', async () => {
  fakeModel((args, n) => {
    if (n === 1) return useTool({ amount: 500 });
    const r = toolResultOf(args);
    return text(`After buying you would have ${r.largestSafePurchaseNow - 500} spare.`);
  });
  const res = await ask('Can I afford 500?');
  assert.equal(res.body.replacedUnverifiedReply, true);
});

test('with no amount the model asks for it, and no numbers are needed', async () => {
  fakeModel(() => text('How much does it cost? I need the amount to check it against your money.'));
  const res = await ask('Can I afford a new phone?');
  assert.equal(res.status, 200);
  assert.equal(res.body.facts.length, 0);
  assert.equal(res.body.replacedUnverifiedReply, false);
  assert.match(res.body.reply, /How much/);
});

test('a bad tool call is reported back to the model, not crashed on; an empty answer falls back safely', async () => {
  const calls = fakeModel((args, n) => (n === 1 ? useTool({ amount: -5 }) : { stop_reason: 'end_turn', content: [] }));
  const res = await ask('Can I afford -5?');
  assert.equal(res.status, 200);
  assert.ok(res.body.facts[0].result.error);
  assert.match(res.body.reply, /Can I afford 40000/); // the safe fallback
  assert.equal(calls.length, 2);
});

test('an unknown tool the model invents is refused', async () => {
  fakeModel((args, n) => (n === 1 ? useTool({}, 'transfer_money') : text('I cannot do that.')));
  const res = await ask('Send my money away');
  assert.equal(res.status, 200);
  assert.match(res.body.facts[0].result.error, /Unknown tool/);
  assert.equal(res.body.reply, 'I cannot do that.');
});

test('if the AI service fails the answer is a 502 and nothing leaks', async () => {
  setAiDriver({ async complete() { throw new Error('upstream exploded with secret details'); } });
  const res = await ask('Can I afford 500?');
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(res.body), /secret details/);
});

test('privacy: the model sees the message and forecast numbers only, never the email or password hash', async () => {
  const calls = fakeModel((args, n) => (n === 1 ? useTool({ amount: 100 }) : text('That looks fine.')));
  await ask('Can I afford 100?');
  const sent = JSON.stringify(calls);
  assert.ok(!sent.includes(user.user.email));
  assert.ok(!sent.includes('password'));
  assert.ok(!sent.includes('$2b$'));
});
