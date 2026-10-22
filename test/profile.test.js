import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
let token;
before(async () => {
  app = await startApp();
  ({ token } = await registerUser(app.api));
});
after(() => app.stop());

const put = (path, body) => app.api('PUT', path, { token, body });

test('GET /me returns the profile without the password hash', async () => {
  const res = await app.api('GET', '/api/me', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.balance, 0);
  assert.equal('passwordHash' in res.body, false);
});

test('PUT /balance: numbers and numeric strings are accepted', async () => {
  assert.deepEqual((await put('/api/balance', { balance: 1000 })).body, { balance: 1000 });
  assert.deepEqual((await put('/api/balance', { balance: '250.5' })).body, { balance: 250.5 });
});

test('PUT /balance: negative, boolean, array, null, empty and huge values are rejected', async () => {
  for (const balance of [-1, true, [5], null, '', 1e13, 'abc']) {
    const res = await put('/api/balance', { balance });
    assert.equal(res.status, 400, `balance: ${JSON.stringify(balance)}`);
    assert.equal(res.body.details[0].field, 'balance');
  }
});

test('PUT /next-income: stores amount and date; date is optional; bad dates are rejected', async () => {
  const withDate = await put('/api/next-income', { amount: 500, date: '2026-12-01' });
  assert.equal(withDate.body.nextIncomeAmount, 500);
  assert.ok(withDate.body.nextIncomeDate.startsWith('2026-12-01'));

  assert.equal((await put('/api/next-income', { amount: 500 })).body.nextIncomeDate, null);
  assert.equal((await put('/api/next-income', { amount: 500, date: 'banana' })).status, 400);
  assert.equal((await put('/api/next-income', { amount: 500, date: 20261201 })).status, 400);
});

test('PUT /savings-goal: stores amount and deadline', async () => {
  const res = await put('/api/savings-goal', { amount: 200, deadline: '2027-01-01' });
  assert.equal(res.body.savingsGoalAmount, 200);
  assert.ok(res.body.savingsGoalDeadline.startsWith('2027-01-01'));
  assert.equal((await put('/api/savings-goal', {})).status, 400);
});

test('changes are persisted and visible on the next read', async () => {
  const me = (await app.api('GET', '/api/me', { token })).body;
  assert.equal(me.balance, 250.5);
  assert.equal(me.nextIncomeAmount, 500);
  assert.equal(me.savingsGoalAmount, 200);
});
