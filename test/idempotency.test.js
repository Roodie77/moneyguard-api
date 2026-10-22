import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { startApp, registerUser } from './helpers.js';
import { idempotency } from '../src/middleware/idempotency.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

test('a retried request with the same key replays the first response without running again', async () => {
  const { token } = await registerUser(app.api);
  const headers = { 'idempotency-key': randomUUID() };

  const first = await app.api('POST', '/api/bills', { token, headers, body: { name: 'Once', amount: 10 } });
  const retry = await app.api('POST', '/api/bills', { token, headers, body: { name: 'Once', amount: 10 } });

  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.deepEqual(retry.body, first.body);
  assert.equal(retry.headers.get('idempotent-replayed'), 'true');

  const bills = (await app.api('GET', '/api/bills', { token })).body;
  assert.equal(bills.length, 1);
});

test('two users using the same key never see each other\'s response', async () => {
  const [a, b] = [await registerUser(app.api), await registerUser(app.api)];
  const headers = { 'idempotency-key': 'shared-key' };

  const ra = await app.api('PUT', '/api/balance', { token: a.token, headers, body: { balance: 100 } });
  const rb = await app.api('PUT', '/api/balance', { token: b.token, headers, body: { balance: 200 } });

  assert.equal(ra.body.balance, 100);
  assert.equal(rb.body.balance, 200);
});

test('the same key with a different body is treated as a new request, not a stale replay', async () => {
  const { token } = await registerUser(app.api);
  const headers = { 'idempotency-key': randomUUID() };

  await app.api('PUT', '/api/balance', { token, headers, body: { balance: 100 } });
  const second = await app.api('PUT', '/api/balance', { token, headers, body: { balance: 300 } });
  assert.equal(second.body.balance, 300);
});

test('two simultaneous identical requests: one runs, the other gets 409 "still processing"', async () => {
  const email = `${randomUUID()}@test.dev`; // register is slow (bcrypt), so the requests overlap
  const headers = { 'idempotency-key': randomUUID() };
  const send = () => app.api('POST', '/api/auth/register', { headers, body: { email, password: 'password123' } });

  const results = await Promise.all([send(), send()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.match(results.find((r) => r.status === 409).body.error, /still processing/);

  const replay = await send();
  assert.equal(replay.status, 201); // the finished result is now replayed
});

test('requests without a key, or with an oversized key, are not touched', async () => {
  const { token } = await registerUser(app.api);
  const long = { 'idempotency-key': 'x'.repeat(129) };
  const one = await app.api('POST', '/api/bills', { token, headers: long, body: { name: 'A', amount: 1 } });
  const two = await app.api('POST', '/api/bills', { token, headers: long, body: { name: 'A', amount: 1 } });
  assert.notEqual(one.body.id, two.body.id);
  assert.equal(two.headers.get('idempotent-replayed'), null);
});

test('server errors are not cached, so a retry runs again', async () => {
  let calls = 0;
  const mini = express();
  mini.use(express.json(), idempotency);
  mini.post('/flaky', (req, res) => {
    calls++;
    res.status(calls === 1 ? 500 : 200).json({ calls });
  });
  const server = mini.listen(0);
  const url = `http://localhost:${server.address().port}/flaky`;
  const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'flaky-key' }, body: '{}' });

  try {
    assert.equal((await post()).status, 500);
    const retry = await post();
    assert.equal(retry.status, 200); // the failure was not cached, and its lock was released
    assert.equal(calls, 2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
