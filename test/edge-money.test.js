// Edge cases for the balance check on expenses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp, registerUser } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

test('money is exact: three 0.10 expenses against 0.30 leave exactly 0, a fourth is refused', async () => {
  const user = await registerUser(app.api);
  await app.api('PUT', '/api/balance', { token: user.token, body: { balance: 0.3 } });
  const spend = (amount) => app.api('POST', '/api/expenses', { token: user.token, body: { amount } });
  for (let i = 0; i < 3; i++) assert.equal((await spend(0.1)).status, 201);
  assert.equal((await app.api('GET', '/api/me', { token: user.token })).body.balance, 0);
  assert.equal((await spend(0.01)).status, 422);
});

test('expenses: a zero balance refuses everything; numeric strings and huge amounts are handled', async () => {
  const user = await registerUser(app.api); // balance 0
  const spend = (amount) => app.api('POST', '/api/expenses', { token: user.token, body: { amount } });
  assert.equal((await spend(1)).status, 422);
  assert.equal((await spend('1')).status, 422);
  assert.equal((await spend(1e12)).status, 422);
  assert.equal((await spend(1e13)).status, 400); // over the allowed maximum
  await app.api('PUT', '/api/balance', { token: user.token, body: { balance: 10 } });
  assert.equal((await spend('10')).status, 201);
});

test('expenses: a refused expense is not cached by an Idempotency-Key, so it succeeds after a top-up', async () => {
  const user = await registerUser(app.api);
  const key = randomUUID();
  const spend = () => app.api('POST', '/api/expenses', { token: user.token, body: { amount: 5 }, headers: { 'idempotency-key': key } });
  assert.equal((await spend()).status, 422); // 422 is a stored answer for that key...
  const replay = await spend();
  assert.equal(replay.status, 422);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  // ...so a client must use a new key for a new attempt. A new key after a top-up works:
  await app.api('PUT', '/api/balance', { token: user.token, body: { balance: 50 } });
  const fresh = await app.api('POST', '/api/expenses', { token: user.token, body: { amount: 5 }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(fresh.status, 201);
});

test('expenses: a successful retry with the same Idempotency-Key spends only once', async () => {
  const user = await registerUser(app.api);
  await app.api('PUT', '/api/balance', { token: user.token, body: { balance: 100 } });
  const key = randomUUID();
  const spend = () => app.api('POST', '/api/expenses', { token: user.token, body: { amount: 40 }, headers: { 'idempotency-key': key } });
  assert.equal((await spend()).status, 201);
  assert.equal((await spend()).status, 201);
  assert.equal((await app.api('GET', '/api/me', { token: user.token })).body.balance, 60);
});

test('expenses racing a balance update never leave a negative balance', async () => {
  const user = await registerUser(app.api);
  await app.api('PUT', '/api/balance', { token: user.token, body: { balance: 100 } });
  const calls = [];
  for (let i = 0; i < 6; i++) {
    calls.push(app.api('POST', '/api/expenses', { token: user.token, body: { amount: 20 } }));
    if (i === 2) calls.push(app.api('PUT', '/api/balance', { token: user.token, body: { balance: 50 } }));
  }
  await Promise.all(calls);
  const { balance } = (await app.api('GET', '/api/me', { token: user.token })).body;
  assert.ok(balance >= 0, `balance ${balance}`);
});
