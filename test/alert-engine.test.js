// What each rule type fires on. Data is set up with SQL and the engine called directly, so the
// tests are about the rules, not about HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
let query;
let evaluateAlerts;
let setNotifier;
before(async () => {
  app = await startApp();
  ({ query } = await import('../src/utils/db.js'));
  ({ evaluateAlerts } = await import('../src/services/alerts.js'));
  ({ setNotifier } = await import('../src/services/notifier.js'));
});
after(() => app.stop());

const DAY = 86_400_000;
const dayStart = () => new Date(new Date().toISOString().slice(0, 10));
const daysFromToday = (n, hours = 12) => new Date(dayStart().getTime() + n * DAY + hours * 3_600_000);

async function newUser({ balance = 0, nextIncomeDate = null } = {}) {
  const { user } = await registerUser(app.api);
  await query('UPDATE users SET balance = $1, next_income_date = $2 WHERE id = $3', [balance, nextIncomeDate, user.id]);
  return user.id;
}
const rule = (userId, type, threshold = null, category = null, enabled = true) =>
  query('INSERT INTO alert_rules (user_id, type, threshold, category, enabled) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [userId, type, threshold, category, enabled]).then((r) => r[0].id);
const spend = (userId, amount, category = 'Other', date = new Date()) =>
  query('INSERT INTO expenses (user_id, amount, category, date) VALUES ($1, $2, $3, $4)', [userId, amount, category, date]);
const alertsOf = (userId) => query('SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at', [userId]);

test('low balance: fires below the level, not at or above it', async () => {
  const at = await newUser({ balance: 50 });
  await rule(at, 'low_balance', 50);
  assert.equal((await evaluateAlerts(at)).length, 0);

  const below = await newUser({ balance: 49.99 });
  await rule(below, 'low_balance', 50);
  const [alert] = await evaluateAlerts(below);
  assert.equal(alert.type, 'low_balance');
  assert.match(alert.message, /49\.99.*50\.00/);
  assert.equal(alert.readAt, null);
  assert.equal(alert.data.balance, 49.99);
});

test('a rule fires once per period: checking again, or moving the threshold, does not repeat it', async () => {
  const u = await newUser({ balance: 10 });
  const id = await rule(u, 'low_balance', 50);
  assert.equal((await evaluateAlerts(u)).length, 1);
  assert.equal((await evaluateAlerts(u)).length, 0);
  await query('UPDATE alert_rules SET threshold = 80 WHERE id = $1', [id]);
  assert.equal((await evaluateAlerts(u)).length, 0);
  assert.equal((await alertsOf(u)).length, 1);
});

test('checking at the same moment from several requests still produces one alert', async () => {
  const u = await newUser({ balance: 1 });
  await rule(u, 'low_balance', 50);
  const results = await Promise.all(Array.from({ length: 6 }, () => evaluateAlerts(u)));
  assert.equal(results.flat().length, 1);
  assert.equal((await alertsOf(u)).length, 1);
});

test('disabled rules and users without rules do nothing', async () => {
  const u = await newUser({ balance: 1 });
  await rule(u, 'low_balance', 50, null, false);
  assert.deepEqual(await evaluateAlerts(u), []);
  assert.deepEqual(await evaluateAlerts(await newUser({ balance: 1 })), []);
});

test('daily limit: counts only today (UTC), and only above the limit', async () => {
  const u = await newUser({ balance: 1000 });
  await rule(u, 'daily_spend_limit', 50);
  await spend(u, 500, 'Other', daysFromToday(-1)); // yesterday does not count
  await spend(u, 50);
  assert.equal((await evaluateAlerts(u)).length, 0); // exactly the limit is not over it
  await spend(u, 0.01);
  const [alert] = await evaluateAlerts(u);
  assert.match(alert.message, /50\.01 today.*50\.00/);
});

test('monthly limit: this UTC month only', async () => {
  const u = await newUser({ balance: 1000 });
  await rule(u, 'monthly_spend_limit', 100);
  await spend(u, 900, 'Other', daysFromToday(-70)); // two or three months ago
  await spend(u, 60);
  assert.equal((await evaluateAlerts(u)).length, 0);
  await spend(u, 60);
  const [alert] = await evaluateAlerts(u);
  assert.equal(alert.data.spent, 120);
});

test('category budget: only that category counts, whatever the letter case', async () => {
  const u = await newUser({ balance: 1000 });
  await rule(u, 'category_monthly_budget', 100, 'Food');
  await spend(u, 400, 'Travel');
  await spend(u, 60, 'food');
  assert.equal((await evaluateAlerts(u)).length, 0);
  await spend(u, 50, 'FOOD');
  const [alert] = await evaluateAlerts(u);
  assert.equal(alert.data.spent, 110);
  assert.match(alert.message, /110\.00 on Food/);
});

test('two category budgets fire independently', async () => {
  const u = await newUser({ balance: 1000 });
  await rule(u, 'category_monthly_budget', 10, 'Food');
  await rule(u, 'category_monthly_budget', 10, 'Travel');
  await spend(u, 20, 'Food');
  await spend(u, 20, 'Travel');
  assert.equal((await evaluateAlerts(u)).length, 2);
});

test('bill due soon: bills due within N days, including today; not later, past, or undated ones', async () => {
  const u = await newUser({ balance: 1000 });
  await rule(u, 'bill_due_soon', 5);
  const bill = (name, due) => query('INSERT INTO bills (user_id, name, amount, due_date) VALUES ($1, $2, 25, $3)', [u, name, due]);
  await bill('Today', daysFromToday(0));
  await bill('Tomorrow', daysFromToday(1));
  await bill('Day five', daysFromToday(5, 23));
  await bill('Day six', daysFromToday(6, 0));
  await bill('Yesterday', daysFromToday(-1));
  await bill('Someday', null);

  const created = await evaluateAlerts(u);
  const messages = created.map((a) => a.message).sort();
  assert.equal(created.length, 3);
  assert.match(messages.find((m) => m.startsWith('Today')), /due today/);
  assert.match(messages.find((m) => m.startsWith('Tomorrow')), /due tomorrow/);
  assert.match(messages.find((m) => m.startsWith('Day five')), /due in 5 days/);
  assert.equal((await evaluateAlerts(u)).length, 0); // each bill only once
  await bill('Next', daysFromToday(2));
  assert.equal((await evaluateAlerts(u)).length, 1); // a new bill is a new alert
});

test('over safe-to-spend: fires when today\'s spending is above today\'s safe amount', async () => {
  const u = await newUser({ balance: 1000, nextIncomeDate: daysFromToday(10, 0) }); // about 100 a day
  await rule(u, 'over_safe_to_spend');
  await spend(u, 60);
  assert.equal((await evaluateAlerts(u)).length, 0);
  await spend(u, 90);
  const [alert] = await evaluateAlerts(u);
  assert.equal(alert.type, 'over_safe_to_spend');
  assert.equal(alert.data.spent, 150);
  assert.match(alert.message, /150\.00 today.*safe amount/);
});

test('every new alert goes to the notifier once; a failing notifier does not lose the alert', async () => {
  const seen = [];
  setNotifier(async (alert) => { seen.push(alert.id); });
  const u = await newUser({ balance: 1 });
  await rule(u, 'low_balance', 50);
  const [alert] = await evaluateAlerts(u);
  await evaluateAlerts(u);
  assert.deepEqual(seen, [alert.id]);

  setNotifier(async () => { throw new Error('push service down'); });
  const v = await newUser({ balance: 1 });
  await rule(v, 'low_balance', 50);
  assert.equal((await evaluateAlerts(v)).length, 1);
  assert.equal((await alertsOf(v)).length, 1);
  setNotifier(async () => {});
});

test('deleting a rule keeps its alerts; deleting the user removes everything', async () => {
  const u = await newUser({ balance: 1 });
  const id = await rule(u, 'low_balance', 50);
  await evaluateAlerts(u);
  await query('DELETE FROM alert_rules WHERE id = $1', [id]);
  const [kept] = await alertsOf(u);
  assert.equal(kept.ruleId, null);
  await query('DELETE FROM users WHERE id = $1', [u]);
  assert.equal((await query('SELECT 1 FROM alerts WHERE user_id = $1', [u])).length, 0);
});

test('an unknown user, or a broken database call, returns no alerts instead of throwing', async () => {
  assert.deepEqual(await evaluateAlerts('00000000-0000-0000-0000-000000000000'), []);
  assert.deepEqual(await evaluateAlerts('not-a-uuid'), []);
});

test('old alerts are purged after 90 days, recent ones stay', async () => {
  const { purgeOldAlerts } = await import('../src/services/alerts.js');
  const u = await newUser({ balance: 1 });
  const id = await rule(u, 'low_balance', 50);
  await query("INSERT INTO alerts (user_id, rule_id, type, message, period_key, created_at) VALUES ($1, $2, 'low_balance', 'old', 'k1', now() - interval '91 days')", [u, id]);
  await query("INSERT INTO alerts (user_id, rule_id, type, message, period_key, created_at) VALUES ($1, $2, 'low_balance', 'recent', 'k2', now() - interval '89 days')", [u, id]);
  await purgeOldAlerts();
  assert.deepEqual((await alertsOf(u)).map((a) => a.message), ['recent']);
});
