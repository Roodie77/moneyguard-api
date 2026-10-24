// The calculator numbers a user saves, and that they are still there after logging out and back in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
let user;
before(async () => {
  app = await startApp();
  user = await registerUser(app.api);
});
after(() => app.stop());

const get = (token = user.token) => app.api('GET', '/api/financial-profile', { token });
const put = (body, token = user.token) => app.api('PUT', '/api/financial-profile', { token, body });

const DEFAULTS = {
  monthlyIncome: 0, monthlyExpenses: 0, existingDebtPayments: 0, proposedPayment: 0,
  targetDtiRatio: 0.4, annualInterestRate: 0, loanTermMonths: 12, updatedAt: null,
};

test('before anything is saved the defaults come back (not an error), so the app can always pre-fill its form', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, DEFAULTS);
});

test('saving some fields keeps the rest at their defaults, and the next save keeps what was saved before', async () => {
  const first = await put({ monthlyIncome: 450000 });
  assert.equal(first.status, 200);
  assert.equal(first.body.monthlyIncome, 450000);
  assert.equal(first.body.targetDtiRatio, 0.4);
  assert.equal(first.body.loanTermMonths, 12);
  assert.ok(first.body.updatedAt);

  const second = await put({ existingDebtPayments: 35000, annualInterestRate: 0.18 });
  assert.equal(second.body.monthlyIncome, 450000); // still there
  assert.equal(second.body.existingDebtPayments, 35000);
  assert.equal(second.body.annualInterestRate, 0.18);

  assert.deepEqual((await get()).body, second.body);
});

test('all seven fields can be saved and read back exactly', async () => {
  const all = {
    monthlyIncome: 400000, monthlyExpenses: 150000, existingDebtPayments: 30000, proposedPayment: 50000,
    targetDtiRatio: 0.35, annualInterestRate: 0.125, loanTermMonths: 24,
  };
  const res = await put(all);
  assert.equal(res.status, 200);
  assert.deepEqual({ ...res.body, updatedAt: undefined }, { ...all, updatedAt: undefined });
  assert.deepEqual((await get()).body.monthlyExpenses, 150000);
});

test('money is rounded to cents, numeric text is accepted, and unknown fields are ignored', async () => {
  const res = await put({ monthlyIncome: '1234.567', isAdmin: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.monthlyIncome, 1234.57);
  assert.equal('isAdmin' in res.body, false);
});

test('bad values are a 400 that names the field', async () => {
  const bad = [
    [{}, null], // nothing to save
    [{ monthlyIncome: -1 }, 'monthlyIncome'],
    [{ monthlyIncome: 'lots' }, 'monthlyIncome'],
    [{ monthlyExpenses: 1e13 }, 'monthlyExpenses'],
    [{ targetDtiRatio: 1.5 }, 'targetDtiRatio'],
    [{ annualInterestRate: 12 }, 'annualInterestRate'],
    [{ loanTermMonths: 0 }, 'loanTermMonths'],
    [{ loanTermMonths: 481 }, 'loanTermMonths'],
    [{ loanTermMonths: 2.5 }, 'loanTermMonths'],
  ];
  for (const [body, field] of bad) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    if (field) assert.ok(res.body.details.some((d) => d.field === field), `${JSON.stringify(body)}: expected an error on "${field}"`);
  }
  const rate = await put({ annualInterestRate: 12 });
  assert.match(rate.body.details[0].message, /fraction/);
});

test('the numbers are private: another user sees defaults and cannot change them', async () => {
  const other = await registerUser(app.api);
  assert.deepEqual((await get(other.token)).body, DEFAULTS);
  await put({ monthlyIncome: 99 }, other.token);
  assert.equal((await get()).body.monthlyIncome, 1234.57); // unchanged by the other user's save
});

test('it needs a token', async () => {
  assert.equal((await app.api('GET', '/api/financial-profile')).status, 401);
  assert.equal((await app.api('PUT', '/api/financial-profile', { body: { monthlyIncome: 1 } })).status, 401);
});

test('the saved numbers go straight into the calculators, which is what the app does after login', async () => {
  const fresh = await registerUser(app.api);
  await put({ monthlyIncome: 400000, monthlyExpenses: 150000, existingDebtPayments: 30000, proposedPayment: 50000, annualInterestRate: 0.18, loanTermMonths: 24 }, fresh.token);
  const p = (await get(fresh.token)).body;
  const result = await app.api('POST', '/api/affordability', {
    token: fresh.token,
    body: {
      monthlyGrossIncome: p.monthlyIncome, otherMonthlyExpenses: p.monthlyExpenses, existingMonthlyDebtPayments: p.existingDebtPayments,
      proposedMonthlyPayment: p.proposedPayment, targetDtiRatio: p.targetDtiRatio, annualInterestRate: p.annualInterestRate, loanTermMonths: p.loanTermMonths,
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.projectedBalance, 170000); // 400000 - 150000 - 30000 - 50000
  const emi = await app.api('POST', '/api/projected-balance', {
    token: fresh.token,
    body: { monthlyIncome: p.monthlyIncome, ordinaryExpenses: p.monthlyExpenses, existingEMI: p.existingDebtPayments, proposedEMI: p.proposedPayment },
  });
  assert.equal(emi.status, 200);
});

test('the saved numbers are still there after logging out and back in', async () => {
  const email = `fp-${Date.now()}@test.dev`;
  const reg = await app.api('POST', '/api/auth/register', { body: { email, password: 'password123' } });
  await put({ monthlyIncome: 777, loanTermMonths: 60 }, reg.body.token);
  await app.api('POST', '/api/auth/logout', { body: { refreshToken: reg.body.refreshToken } });
  const back = await app.api('POST', '/api/auth/login', { body: { email, password: 'password123' } });
  const profile = (await get(back.body.token)).body;
  assert.equal(profile.monthlyIncome, 777);
  assert.equal(profile.loanTermMonths, 60);
});
