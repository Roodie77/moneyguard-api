import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

process.env.AUTH_LIMIT_MAX = '8'; // the production default; must be set before the app is imported

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

test('/health reports the database and is never rate limited', async () => {
  const res = await app.api('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.database, 'connected');

  for (let i = 0; i < 320; i++) assert.equal((await app.api('GET', '/health')).status, 200);
});

test('every response carries a request id', async () => {
  const res = await app.api('GET', '/api/me');
  assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{8}$/);
});

test('unknown routes return a JSON 404', async () => {
  const res = await app.api('GET', '/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Not found' });
});

test('malformed JSON is a clean 400', async () => {
  const res = await app.api('POST', '/api/auth/login', { rawBody: '{bad json' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'Invalid JSON body' });
});

test('oversized JSON bodies are refused', async () => {
  const res = await app.api('POST', '/api/auth/login', { body: { email: 'a@test.dev', password: 'x'.repeat(20_000) } });
  assert.equal(res.status, 413);
});

test('login attempts are limited: the 9th failed try in a window gets 429', async () => {
  const attempt = () => app.api('POST', '/api/auth/login', { body: { email: 'nobody@test.dev', password: 'password123' } });
  for (let i = 0; i < 8; i++) assert.equal((await attempt()).status, 401);

  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /Too many attempts/);
  assert.ok(blocked.headers.get('ratelimit-limit'));
});
