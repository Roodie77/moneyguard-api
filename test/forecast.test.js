// POST /api/forecast: the survival forecast through the real server and database.
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

test('it needs a login', async () => {
  assert.equal((await forecast(undefined, {})).status, 401);
});

test('bad input is a 400: amount, confidence and inDays are checked', async () => {
  const u = await registerUser(app.api);
  for (const body of [{ amount: 0 }, { amount: -5 }, { amount: 'abc' }, { confidence: 0.2 }, { confidence: 1 }, { inDays: -1 }, { inDays: 1.5 }]) {
    const res = await forecast(u.token, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('a brand-new user still gets a forecast, built from starting assumptions and labelled as such', async () => {
  const u = await registerUser(app.api);
  const res = await forecast(u.token); // no body at all
  assert.equal(res.status, 200);
  assert.equal(res.body.model.source, 'default');
  assert.equal(res.body.purchase, null);
  assert.equal(res.body.confidence, 0.95);
  assert.ok(res.body.warnings.length > 0); // "No next income date; using 30 days."
  assert.ok(res.body.disclaimer);
  assert.equal(res.body.survivalProbability + res.body.ruinProbability, 1);
  // with no money at all there is nothing safe to spend
  assert.equal(res.body.maxPurchaseNow, 0);
});

test('with history: learned from the user\'s own spending, and the answers hang together', async () => {
  const u = await history();
  const base = await forecast(u.token);
  assert.equal(base.status, 200);
  assert.equal(base.body.model.source, 'history');
  assert.equal(base.body.model.observedDays, 45);
  assert.ok(base.body.model.meanDailySpend > 200 && base.body.model.meanDailySpend < 500, `mean ${base.body.model.meanDailySpend}`);
  assert.equal(base.body.horizonDays, 10);
  assert.equal(base.body.ruinByDay.length, 11);
  // 10000 balance, 2000 bill, about 300 x 10 days spending: comfortably safe
  assert.ok(base.body.survivalProbability > 0.95);
  assert.ok(base.body.maxPurchaseNow > 3000 && base.body.maxPurchaseNow < 8000, `max ${base.body.maxPurchaseNow}`);

  const small = await forecast(u.token, { amount: 500 });
  assert.equal(small.body.purchase.verdict, 'Safe');
  assert.equal(small.body.purchase.amount, 500);

  const big = await forecast(u.token, { amount: 30_000 });
  assert.equal(big.body.purchase.verdict, 'NotRecommended');
  assert.equal(big.body.purchase.ruinProbability, 1);
  assert.ok(big.body.purchase.expectedShortfallInWorstCase > 20_000);
  assert.match(big.body.summary, /next income/);

  // the largest safe purchase really is within the chosen risk, and a bit more is not
  const atLimit = await forecast(u.token, { amount: base.body.maxPurchaseNow });
  assert.ok(atLimit.body.purchase.ruinProbability <= 0.0501, `at the limit: ${atLimit.body.purchase.ruinProbability}`);
  const over = await forecast(u.token, { amount: base.body.maxPurchaseNow * 1.3 });
  assert.ok(over.body.purchase.ruinProbability > atLimit.body.purchase.ruinProbability);
});

