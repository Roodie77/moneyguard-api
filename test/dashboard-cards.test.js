// The dashboard carries what the Savings and Bills cards need, so they need no extra request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
let token;
before(async () => {
  app = await startApp();
  token = (await registerUser(app.api)).token;
});
after(() => app.stop());

const call = (method, path, body) => app.api(method, path, { token, body });
const dashboard = async () => (await call('GET', '/api/dashboard')).body;

test('a new account: no deadline and no bills', async () => {
  const d = await dashboard();
  assert.equal(d.user.savingsGoalDeadline, null);
  assert.equal(d.billsCount, 0);
});

test('the savings deadline appears on the dashboard, can be changed and cleared', async () => {
  await call('PUT', '/api/savings-goal', { amount: 300000, deadline: '2026-12-31' });
  const d = await dashboard();
  assert.equal(d.user.savingsGoalAmount, 300000);
  assert.equal(d.user.savingsGoalDeadline, '2026-12-31T00:00:00.000Z');
  await call('PUT', '/api/savings-goal', { amount: 300000, deadline: null });
  assert.equal((await dashboard()).user.savingsGoalDeadline, null);
});

test('billsCount follows adding and deleting bills, and counts every bill whatever its date', async () => {
  const dated = await call('POST', '/api/bills', { name: 'Rent', amount: 120000, dueDate: new Date(Date.now() + 3 * 86_400_000).toISOString() });
  await call('POST', '/api/bills', { name: 'No date', amount: 500 });
  await call('POST', '/api/bills', { name: 'Far away', amount: 700, dueDate: '2099-01-01' }); // due after the next income
  const d = await dashboard();
  assert.equal(d.billsCount, 3);
  assert.ok(d.safeToSpend.upcomingBillsTotal < 120000 + 500 + 700); // the far-away one is not in the upcoming total
  assert.equal((await call('DELETE', `/api/bills/${dated.body.id}`)).status, 200);
  assert.equal((await dashboard()).billsCount, 2);
});

test("one user's bills are not counted for another", async () => {
  const other = await registerUser(app.api);
  const res = await app.api('GET', '/api/dashboard', { token: other.token });
  assert.equal(res.body.billsCount, 0);
});
