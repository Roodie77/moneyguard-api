// "Today's allowance left" and "can I afford this?" through the real API, after real expenses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
let user;
before(async () => {
  app = await startApp();
  user = await registerUser(app.api);
  const payday = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10); // 10 days away
  await app.api('PUT', '/api/balance', { token: user.token, body: { balance: 1000 } });
  await app.api('PUT', '/api/next-income', { token: user.token, body: { amount: 500, date: payday } });
});
after(() => app.stop());

const dashboard = async () => (await app.api('GET', '/api/dashboard', { token: user.token })).body.safeToSpend;
const canAfford = (amount) => app.api('POST', '/api/can-i-afford', { token: user.token, body: { amount } });

test('before spending: 1000 over 10 days is 100 a day, all of it left', async () => {
  const s = await dashboard();
  assert.equal(s.dailySafeToSpend, 100);
  assert.equal(s.remainingToday, 100);
  assert.equal(s.spentToday, 0);
});

test('after spending 60 the allowance is still 100 and 40 is left (the 60 is not counted twice)', async () => {
  await app.api('POST', '/api/expenses', { token: user.token, body: { amount: 60 } });
  const s = await dashboard();
  assert.equal(s.spentToday, 60);
  assert.equal(s.dailySafeToSpend, 100);
  assert.equal(s.remainingToday, 40);
});

test('can-i-afford uses that: 30 is safe (10 would remain), 60 deserves a second thought, 100 is not recommended', async () => {
  const small = await canAfford(30);
  assert.equal(small.body.recommendation, 'Safe');
  assert.equal(small.body.remainingAfterPurchase, 10);
  assert.equal(small.body.safeToSpend.remainingToday, 40);
  assert.equal((await canAfford(60)).body.recommendation, 'ThinkTwice');
  assert.equal((await canAfford(100)).body.recommendation, 'NotRecommended');
});

test('spending right up to the allowance leaves exactly 0, and only spending more shows over budget', async () => {
  await app.api('POST', '/api/expenses', { token: user.token, body: { amount: 40 } }); // 100 spent in all
  const exact = await dashboard();
  assert.equal(exact.remainingToday, 0);
  assert.ok(!exact.warnings.includes("Already over today's safe amount."));

  await app.api('POST', '/api/expenses', { token: user.token, body: { amount: 25 } }); // 125 spent
  const over = await dashboard();
  assert.equal(over.remainingToday, -25);
  assert.ok(over.warnings.includes("Already over today's safe amount."));
});
