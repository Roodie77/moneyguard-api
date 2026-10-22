// Setting, validating, updating and deleting the thresholds a user chooses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp, registerUser } from './helpers.js';

let app;
let user;
let query;
before(async () => {
  app = await startApp();
  ({ query } = await import('../src/utils/db.js'));
  user = await registerUser(app.api);
});
after(() => app.stop());

const put = (body, token = user.token) => app.api('PUT', '/api/alert-rules', { token, body });
const rules = async (token = user.token) => (await app.api('GET', '/api/alert-rules', { token })).body;

test('a new user has no rules and no alerts: nothing is on until they choose', async () => {
  assert.deepEqual(await rules(), []);
  const { body } = await app.api('GET', '/api/alerts', { token: user.token });
  assert.deepEqual(body, { alerts: [], unreadCount: 0, total: 0 });
});

test('each rule type can be set with the threshold that fits it', async () => {
  const valid = [
    { type: 'low_balance', threshold: 500 },
    { type: 'daily_spend_limit', threshold: 40.5 },
    { type: 'monthly_spend_limit', threshold: '1200' },
    { type: 'category_monthly_budget', threshold: 300, category: 'Food' },
    { type: 'bill_due_soon', threshold: 3 },
    { type: 'over_safe_to_spend' },
  ];
  for (const body of valid) {
    const res = await put(body);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(res.body.type, body.type);
    assert.equal(res.body.enabled, true);
  }
  assert.equal((await rules()).length, 6);
  const safe = (await rules()).find((r) => r.type === 'over_safe_to_spend');
  assert.equal(safe.threshold, null);
});

test('setting the same rule again updates it instead of adding another', async () => {
  const before = (await rules()).find((r) => r.type === 'low_balance');
  const res = await put({ type: 'low_balance', threshold: 250, enabled: false });
  assert.equal(res.body.id, before.id);
  assert.equal(res.body.threshold, 250);
  assert.equal(res.body.enabled, false);
  assert.equal((await rules()).filter((r) => r.type === 'low_balance').length, 1);
});

test('category budgets are one per category, whatever the letter case', async () => {
  const res = await put({ type: 'category_monthly_budget', threshold: 350, category: ' food ' });
  const all = await rules();
  assert.equal(all.filter((r) => r.type === 'category_monthly_budget').length, 1);
  assert.equal(res.body.threshold, 350);
  assert.equal(res.body.category, 'food');
  await put({ type: 'category_monthly_budget', threshold: 100, category: 'Travel' });
  assert.equal((await rules()).filter((r) => r.type === 'category_monthly_budget').length, 2);
});

test('there is a limit of 50 rules per user, but existing rules can still be edited', async () => {
  const full = await registerUser(app.api);
  for (let i = 0; i < 50; i++) {
    await query(
      "INSERT INTO alert_rules (user_id, type, threshold, category) VALUES ($1, 'category_monthly_budget', 10, $2)",
      [full.user.id, `cat${i}`],
    );
  }
  const refused = await put({ type: 'low_balance', threshold: 10 }, full.token);
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /At most 50/);
  const edit = await put({ type: 'category_monthly_budget', threshold: 99, category: 'CAT7' }, full.token);
  assert.equal(edit.status, 200);
  assert.equal(edit.body.threshold, 99);
  assert.equal((await rules(full.token)).length, 50);
});

test("rules are private: other users do not see them and cannot delete them", async () => {
  const other = await registerUser(app.api);
  assert.deepEqual(await rules(other.token), []);
  const mine = (await rules())[0];
  assert.equal((await app.api('DELETE', `/api/alert-rules/${mine.id}`, { token: other.token })).status, 404);
  assert.equal((await rules()).some((r) => r.id === mine.id), true);
});

test('delete: removes the rule; a second delete, an unknown id and a malformed id are 404', async () => {
  const rule = await put({ type: 'monthly_spend_limit', threshold: 999 });
  assert.equal((await app.api('DELETE', `/api/alert-rules/${rule.body.id}`, { token: user.token })).status, 200);
  assert.equal((await rules()).some((r) => r.id === rule.body.id), false);
  assert.equal((await app.api('DELETE', `/api/alert-rules/${rule.body.id}`, { token: user.token })).status, 404);
  assert.equal((await app.api('DELETE', `/api/alert-rules/${randomUUID()}`, { token: user.token })).status, 404);
  assert.equal((await app.api('DELETE', '/api/alert-rules/nope', { token: user.token })).status, 404);
});

test('all alert endpoints need a token', async () => {
  for (const [method, path] of [['GET', '/api/alert-rules'], ['PUT', '/api/alert-rules'], ['GET', '/api/alerts'], ['POST', '/api/alerts/read-all']]) {
    assert.equal((await app.api(method, path)).status, 401, `${method} ${path}`);
  }
});
