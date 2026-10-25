// The assistant's input checks and its own, tighter rate limit (a separate file so it has its own rate-limit budget).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
let token;
before(async () => {
  app = await startApp();
  token = (await registerUser(app.api)).token;
  const { setAiDriver } = await import('../src/services/assistant.js');
  setAiDriver({ async complete() { return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello.' }] }; } });
});
after(() => app.stop());

const ask = (body, t = token) => app.api('POST', '/api/assistant', { token: t, body });

test('it needs a login', async () => {
  assert.equal((await app.api('POST', '/api/assistant', { body: { message: 'hi' } })).status, 401);
});

test('the message is required, not empty, and at most 500 characters', async () => {
  for (const body of [{}, { message: '' }, { message: '   ' }, { message: 5 }, { message: 'x'.repeat(501) }]) {
    assert.equal((await ask(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await ask({ message: 'x'.repeat(500) })).status, 200);
});

test('it is limited to 10 calls a minute, because each one costs money', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await ask({ message: 'hi' });
  assert.equal(last.status, 429);
});
