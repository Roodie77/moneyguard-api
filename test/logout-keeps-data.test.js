// Logging out ends the session. It must never remove or change what the user saved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

test('everything a user saved is still there after logging out and back in', async () => {
  const email = `keeps-${Date.now()}@test.dev`;
  const password = 'password123';
  const reg = await app.api('POST', '/api/auth/register', { body: { email, password } });
  assert.equal(reg.status, 201);
  const call = (method, path, body, token = reg.body.token) => app.api(method, path, { token, body });

  await call('PUT', '/api/balance', { balance: 1000 });
  await call('PUT', '/api/next-income', { amount: 500, date: '2030-01-01' });
  await call('PUT', '/api/savings-goal', { amount: 200, deadline: '2031-01-01' });
  await call('POST', '/api/bills', { name: 'Rent', amount: 250, dueDate: '2030-01-01' });
  await call('POST', '/api/expenses', { amount: 40, category: 'Food', description: 'lunch' });
  await call('PUT', '/api/alert-rules', { type: 'low_balance', threshold: 10 });

  const dashboardBefore = (await call('GET', '/api/dashboard')).body;
  assert.equal(dashboardBefore.user.balance, 960);

  const out = await app.api('POST', '/api/auth/logout', { body: { refreshToken: reg.body.refreshToken } });
  assert.equal(out.status, 200);
  // The refresh token is dead now, so the app cannot silently renew the session.
  assert.equal((await app.api('POST', '/api/auth/refresh', { body: { refreshToken: reg.body.refreshToken } })).status, 401);

  const back = await app.api('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(back.status, 200);
  const token = back.body.token;
  assert.equal(back.body.user.id, reg.body.user.id); // the same account, not a new one

  const dashboardAfter = (await call('GET', '/api/dashboard', undefined, token)).body;
  assert.deepEqual(dashboardAfter.user, dashboardBefore.user);
  assert.equal(dashboardAfter.recentExpenses.length, 1);
  assert.equal((await call('GET', '/api/bills', undefined, token)).body.length, 1);
  assert.equal((await call('GET', '/api/expenses', undefined, token)).body.length, 1);
  assert.equal((await call('GET', '/api/alert-rules', undefined, token)).body.length, 1);
});
