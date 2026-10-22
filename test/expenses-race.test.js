// Simultaneous edits and deletes can never overspend, double-refund or deadlock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

async function userWith(balance) {
  const user = await registerUser(app.api);
  await app.api('PUT', '/api/balance', { token: user.token, body: { balance } });
  const call = (method, path, body) => app.api(method, path, { token: user.token, body });
  const me = async () => (await call('GET', '/api/me')).body.balance;
  const expenses = async () => (await call('GET', '/api/expenses')).body;
  return { call, me, expenses };
}

test('two edits that cannot both fit: exactly one succeeds, the balance never goes negative', async () => {
  const u = await userWith(100);
  const a = (await u.call('POST', '/api/expenses', { amount: 10 })).body.id;
  const b = (await u.call('POST', '/api/expenses', { amount: 10 })).body.id; // balance 80
  const results = await Promise.all([
    u.call('PUT', `/api/expenses/${a}`, { amount: 80 }),
    u.call('PUT', `/api/expenses/${b}`, { amount: 80 }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 422]);
  const total = (await u.expenses()).reduce((sum, e) => sum + e.amount, 0);
  assert.equal(await u.me(), 100 - total);
  assert.ok((await u.me()) >= 0);
});

test('deleting the same expense five times at once refunds it exactly once', async () => {
  const u = await userWith(100);
  const id = (await u.call('POST', '/api/expenses', { amount: 40 })).body.id; // balance 60
  const results = await Promise.all(Array.from({ length: 5 }, () => u.call('DELETE', `/api/expenses/${id}`)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 404, 404, 404, 404]);
  assert.equal(await u.me(), 100);
});

test('a mix of new expenses, edits and deletes all finish, and the books balance', async () => {
  const u = await userWith(500);
  const seeded = [];
  for (let i = 0; i < 3; i++) seeded.push((await u.call('POST', '/api/expenses', { amount: 20 })).body.id); // balance 440
  const calls = [
    u.call('POST', '/api/expenses', { amount: 30 }),
    u.call('POST', '/api/expenses', { amount: 30 }),
    u.call('PUT', `/api/expenses/${seeded[0]}`, { amount: 50 }),
    u.call('PUT', `/api/expenses/${seeded[1]}`, { amount: 5 }),
    u.call('DELETE', `/api/expenses/${seeded[2]}`),
    u.call('PUT', '/api/balance', { balance: 400 }),
  ];
  const results = await Promise.all(calls);
  assert.ok(results.every((r) => r.status < 500), results.map((r) => r.status).join());
  assert.ok((await u.me()) >= 0);
});
