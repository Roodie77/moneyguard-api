// POST /api/forecast: more scenarios (a separate file so it has its own rate-limit budget).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';
import { userWithHistory, days } from './forecast-fixtures.js';


let app;
let query;
before(async () => {
  app = await startApp();
  ({ query } = await import('../src/utils/db.js'));
});
after(() => app.stop());

const forecast = (token, body) => app.api('POST', '/api/forecast', { token, body });

const history = (opts) => userWithHistory(app, query, opts);

test('asking for more certainty lowers the maximum purchase; the answer is identical when repeated on the same day', async () => {
  const u = await history();
  const loose = await forecast(u.token, { confidence: 0.8 });
  const strict = await forecast(u.token, { confidence: 0.99 });
  assert.ok(strict.body.maxPurchaseNow < loose.body.maxPurchaseNow);
  const again = await forecast(u.token, { confidence: 0.99 });
  assert.deepEqual(again.body, strict.body);
});

test('the risk rises when spending is heavy, and an unpaid bill is counted', async () => {
  const calm = await history({ perDay: 100 });
  const heavy = await history({ perDay: 900 });
  const a = await forecast(calm.token);
  const b = await forecast(heavy.token);
  assert.ok(b.body.ruinProbability > a.body.ruinProbability);
  assert.ok(b.body.maxPurchaseNow < a.body.maxPurchaseNow);

  // a past-due bill is still owed: it is counted today
  const owing = await history({ balance: 1500 });
  await query("INSERT INTO bills (user_id, name, amount) VALUES ($1, 'Old debt', 1400)", [owing.user.id]);
  const res = await forecast(owing.token);
  assert.ok(res.body.ruinProbability > 0.9);
});

test('a purchase planned after the next income does not put this period at risk', async () => {
  const u = await history();
  const res = await forecast(u.token, { amount: 30_000, inDays: 30 });
  assert.equal(res.status, 200);
  assert.equal(res.body.purchase.ruinProbability, res.body.ruinProbability);
  assert.ok(res.body.warnings.some((w) => /next income/.test(w)));
});

test('a next income far away only forecasts 90 days, and says so', async () => {
  const u = await history();
  await query('UPDATE users SET next_income_date = $2 WHERE id = $1', [u.user.id, days(200)]);
  const res = await forecast(u.token);
  assert.equal(res.body.horizonDays, 90);
  assert.ok(res.body.warnings.some((w) => /90 days/.test(w)));
});

test('it reads data only: nothing it does changes the balance, bills or expenses', async () => {
  const u = await history();
  const before = await query('SELECT (SELECT count(*) FROM expenses WHERE user_id = $1) AS e, (SELECT count(*) FROM bills WHERE user_id = $1) AS b, (SELECT balance FROM users WHERE id = $1) AS bal', [u.user.id]);
  await forecast(u.token, { amount: 1000 });
  const after = await query('SELECT (SELECT count(*) FROM expenses WHERE user_id = $1) AS e, (SELECT count(*) FROM bills WHERE user_id = $1) AS b, (SELECT balance FROM users WHERE id = $1) AS bal', [u.user.id]);
  assert.deepEqual(after, before);
});
