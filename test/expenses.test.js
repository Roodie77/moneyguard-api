import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
let user;
before(async () => {
  app = await startApp();
  user = await registerUser(app.api);
  await app.api('PUT', '/api/balance', { token: user.token, body: { balance: 1000 } });
});
after(() => app.stop());

const spend = (body) => app.api('POST', '/api/expenses', { token: user.token, body });
const balance = async () => (await app.api('GET', '/api/me', { token: user.token })).body.balance;

test('an expense is recorded with defaults and reduces the balance exactly', async () => {
  const res = await spend({ amount: 99.99 });
  assert.equal(res.status, 201);
  assert.equal(res.body.category, 'Other');
  assert.equal(res.body.description, '');
  assert.equal(res.body.amount, 99.99);
  assert.equal(await balance(), 900.01);
});

test('category and description are trimmed and stored', async () => {
  const res = await spend({ amount: 1, category: ' Food ', description: ' lunch ' });
  assert.equal(res.body.category, 'Food');
  assert.equal(res.body.description, 'lunch');
});

test('invalid expenses are rejected and leave the balance untouched', async () => {
  const before = await balance();
  const bad = [
    { amount: 0 },
    { amount: -5 },
    { amount: 'abc' },
    { amount: true },
    { amount: 5, date: 12345 }, // used to break the dashboard for that user permanently
    { amount: 5, date: 'yesterday' },
    { amount: 5, category: { a: 1 } },
    { amount: 5, description: 'x'.repeat(201) },
  ];
  for (const body of bad) {
    assert.equal((await spend(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await balance(), before);
});

test('amounts are rounded to cents; an amount that rounds to 0 is rejected (not a database error)', async () => {
  assert.equal((await spend({ amount: 0.004 })).status, 400);
  assert.equal((await spend({ amount: 10.999 })).body.amount, 11);
});

test('list: newest first', async () => {
  await spend({ amount: 2, date: '2020-01-01T00:00:00Z' });
  await spend({ amount: 3, date: '2030-01-01T00:00:00Z' });
  const { body } = await app.api('GET', '/api/expenses', { token: user.token });
  const times = body.map((e) => new Date(e.date).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.equal(body[0].amount, 3);
});

test('dashboard: recent expenses are the 5 newest, spentToday counts only today', async () => {
  const fresh = await registerUser(app.api);
  const add = (body) => app.api('POST', '/api/expenses', { token: fresh.token, body });
  await app.api('PUT', '/api/balance', { token: fresh.token, body: { balance: 500 } });

  await add({ amount: 10 }); // today
  await add({ amount: 10, date: '2020-01-01T00:00:00Z' }); // long ago
  for (let i = 0; i < 4; i++) await add({ amount: 1, date: `2025-01-0${i + 1}T00:00:00Z` });

  const { status, body } = await app.api('GET', '/api/dashboard', { token: fresh.token });
  assert.equal(status, 200);
  assert.equal(body.recentExpenses.length, 5);
  assert.equal(body.safeToSpend.spentToday, 10);
  assert.ok('dailySafeToSpend' in body.safeToSpend && 'warnings' in body.safeToSpend);
  assert.equal(body.user.balance, 500 - 10 - 10 - 4);
});

test('spending more than the balance is refused (422) and changes nothing', async () => {
  const fresh = await registerUser(app.api);
  await app.api('PUT', '/api/balance', { token: fresh.token, body: { balance: 50 } });
  const add = (amount) => app.api('POST', '/api/expenses', { token: fresh.token, body: { amount } });
  const balanceOf = async () => (await app.api('GET', '/api/me', { token: fresh.token })).body.balance;

  const res = await add(50.01);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'Insufficient balance');
  assert.equal((await app.api('GET', '/api/expenses', { token: fresh.token })).body.length, 0);
  assert.equal(await balanceOf(), 50);

  assert.equal((await add(50)).status, 201); // exactly the balance is allowed
  assert.equal(await balanceOf(), 0);
  assert.equal((await add(0.01)).status, 422);
});

test('expenses are private to their owner', async () => {
  const other = await registerUser(app.api);
  const { body } = await app.api('GET', '/api/expenses', { token: other.token });
  assert.deepEqual(body, []);
});
