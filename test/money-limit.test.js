// Amounts above one trillion: a clear 400 that names the field and carries the limit, on every screen of the setup flow.
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

const TRILLION = 1_000_000_000_000;
const date = () => new Date(Date.now() + 20 * 86_400_000).toISOString();
const put = (path, body) => app.api('PUT', path, { token, body });

// Each step of the "set up your plan" screen: [path, body with the amount, the field the error names].
const steps = [
  ['/api/balance', (v) => ({ balance: v }), 'balance'],
  ['/api/next-income', (v) => ({ amount: v, date: date() }), 'amount'],
  ['/api/savings-goal', (v) => ({ amount: v }), 'amount'],
  ['/api/financial-profile', (v) => ({ monthlyIncome: v }), 'monthlyIncome'],
];

test('exactly one trillion is accepted by every setup step', async () => {
  for (const [path, body] of steps) assert.equal((await put(path, body(TRILLION))).status, 200, path);
});

test('above a trillion: a 400 naming the field, saying the limit in words, and carrying it as a number', async () => {
  for (const [path, body, field] of steps) {
    for (const value of [TRILLION + 0.01, 2 * TRILLION]) {
      const res = await put(path, body(value));
      assert.equal(res.status, 400, `${path} ${value}`);
      assert.equal(res.body.error, 'Validation failed');
      const detail = res.body.details.find((d) => d.field === field);
      assert.ok(detail, `${path}: no detail for ${field}`);
      assert.match(detail.message, /too large: the most allowed is 1,000,000,000,000 \(one trillion\)/);
      assert.equal(detail.max, TRILLION);
    }
  }
});

test('a rejected value changes nothing: the last good value is still there', async () => {
  await put('/api/balance', { balance: 5000 });
  assert.equal((await put('/api/balance', { balance: 2 * TRILLION })).status, 400);
  assert.equal((await app.api('GET', '/api/me', { token })).status, 200);
  const dash = await app.api('GET', '/api/dashboard', { token });
  assert.equal(dash.body.user.balance, 5000);
});

test('a number below its limit also carries it, and one problem does not hide another', async () => {
  const res = await put('/api/next-income', { amount: -1, date: 'not a date' });
  assert.equal(res.status, 400);
  assert.equal(res.body.details.find((d) => d.field === 'amount').min, 0);
  assert.ok(res.body.details.find((d) => d.field === 'date'));
});
