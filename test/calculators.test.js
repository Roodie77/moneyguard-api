import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
let token;
let userId;
before(async () => {
  app = await startApp();
  const user = await registerUser(app.api);
  token = user.token;
  userId = user.user.id;
});
after(() => app.stop());

const post = (path, body) => app.api('POST', path, { token, body });

test('projected-balance: the product-plan example', async () => {
  const res = await post('/api/projected-balance', { monthlyIncome: 450000, ordinaryExpenses: 180000, existingEMI: 35000, proposedEMI: 50000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.projectedBalance, 185000);
  assert.equal(res.body.isNegative, false);
});

test('projected-balance: a negative result carries a warning; omitted fields default to 0', async () => {
  const res = await post('/api/projected-balance', { monthlyIncome: 1000, proposedEMI: 1500 });
  assert.equal(res.body.projectedBalance, -500);
  assert.equal(res.body.isNegative, true);
  assert.ok(res.body.warning);
});

test('projected-balance: missing income or junk values are a 400, not a silent 0', async () => {
  const missing = await post('/api/projected-balance', {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.details[0].field, 'monthlyIncome');
  assert.equal((await post('/api/projected-balance', { monthlyIncome: 'lots' })).status, 400);
  assert.equal((await post('/api/projected-balance', { monthlyIncome: 100, existingEMI: -1 })).status, 400);
});

test('affordability: full result for a normal case', async () => {
  const res = await post('/api/affordability', {
    monthlyGrossIncome: 10000,
    otherMonthlyExpenses: 3000,
    existingMonthlyDebtPayments: 1000,
    proposedMonthlyPayment: 500,
    annualInterestRate: 0.12,
    loanTermMonths: 12,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.projectedBalance, 5500);
  assert.equal(res.body.isAffordable, true);
  assert.equal(res.body.debtToIncomeRatio, 0.15);
  assert.ok(res.body.maxAffordableLoanAmount > 0);
});

test('affordability: a percentage like 12 instead of 0.12 is rejected with an explanation', async () => {
  const res = await post('/api/affordability', { monthlyGrossIncome: 1000, annualInterestRate: 12 });
  assert.equal(res.status, 400);
  assert.match(res.body.details[0].message, /fraction/);
});

test('cash-flow: projects the requested months; absurd months are rejected', async () => {
  const ok = await post('/api/cash-flow', { monthlyGrossIncome: 1000, otherMonthlyExpenses: 400, startingCashBalance: 100, months: 3 });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.projection.map((m) => m.endingBalance), [700, 1300, 1900]);
  assert.equal(ok.body.summary.negativeMonths.length, 0);

  assert.equal((await post('/api/cash-flow', { monthlyGrossIncome: 1000, months: 9999 })).status, 400);
  assert.equal((await post('/api/cash-flow', { monthlyGrossIncome: 1000, months: 2.5 })).status, 400);
});

test('can-i-afford: gives a recommendation and records the check', async () => {
  const res = await post('/api/can-i-afford', { amount: 50 });
  assert.equal(res.status, 200);
  assert.ok(['Safe', 'ThinkTwice', 'NotRecommended'].includes(res.body.recommendation));
  assert.ok('safeToSpend' in res.body);

  const { query } = await import('../src/utils/db.js');
  const rows = await query('SELECT * FROM affordability_checks WHERE user_id = $1', [userId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 50);
  assert.equal(rows[0].recommendation, res.body.recommendation);
});

test('can-i-afford: zero, negative and junk amounts are a 400', async () => {
  for (const amount of [0, -5, 'abc', null]) {
    assert.equal((await post('/api/can-i-afford', { amount })).status, 400);
  }
});

test('calculators require authentication', async () => {
  assert.equal((await app.api('POST', '/api/projected-balance', { body: { monthlyIncome: 1 } })).status, 401);
});
