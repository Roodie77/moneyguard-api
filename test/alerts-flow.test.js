// The alerts a user sees through the API, from the action that triggers them to marking them read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp, registerUser } from './helpers.js';

let app;
let user;
let other;
before(async () => {
  app = await startApp();
  user = await registerUser(app.api);
  other = await registerUser(app.api);
});
after(() => app.stop());

const call = (method, path, body, token = user.token) => app.api(method, path, { token, body });

test('spending past a low-balance level raises an alert, shown in the list and on the dashboard', async () => {
  await call('PUT', '/api/balance', { balance: 100 });
  const rule = await call('PUT', '/api/alert-rules', { type: 'low_balance', threshold: 80 });
  assert.equal(rule.status, 200);
  assert.equal((await call('GET', '/api/alerts')).body.total, 0); // 100 is above 80: nothing yet

  await call('POST', '/api/expenses', { amount: 30 }); // balance 70
  const { body } = await call('GET', '/api/alerts');
  assert.equal(body.total, 1);
  assert.equal(body.unreadCount, 1);
  const [alert] = body.alerts;
  assert.equal(alert.type, 'low_balance');
  assert.equal(alert.ruleId, rule.body.id);
  assert.match(alert.message, /70\.00.*80\.00/);

  assert.equal((await call('GET', '/api/dashboard')).body.unreadAlerts, 1);
});

test('more spending the same day does not repeat the alert', async () => {
  await call('POST', '/api/expenses', { amount: 5 });
  assert.equal((await call('GET', '/api/alerts')).body.total, 1);
});

test('a rule already triggered by current data fires as soon as it is saved', async () => {
  const res = await call('PUT', '/api/alert-rules', { type: 'daily_spend_limit', threshold: 10 }); // 35 spent today
  assert.equal(res.status, 200);
  const { body } = await call('GET', '/api/alerts');
  assert.equal(body.total, 2);
  assert.equal(body.alerts[0].type, 'daily_spend_limit'); // newest first
});

test('unread filter, marking one alert read, then all of them', async () => {
  const all = (await call('GET', '/api/alerts')).body.alerts;
  const read = await call('POST', `/api/alerts/${all[0].id}/read`);
  assert.equal(read.status, 200);
  assert.ok(read.body.readAt);
  const again = await call('POST', `/api/alerts/${all[0].id}/read`);
  assert.equal(again.body.readAt, read.body.readAt); // the first read time is kept

  const unread = (await call('GET', '/api/alerts?unread=true')).body;
  assert.equal(unread.alerts.length, 1);
  assert.equal(unread.unreadCount, 1);
  assert.equal(unread.total, 1);

  const readAll = await call('POST', '/api/alerts/read-all');
  assert.deepEqual(readAll.body, { updated: 1 });
  assert.equal((await call('POST', '/api/alerts/read-all')).body.updated, 0);
  assert.equal((await call('GET', '/api/dashboard')).body.unreadAlerts, 0);
});

test('paging: limit and offset, with the unread count and total unaffected', async () => {
  const page = (await call('GET', '/api/alerts?limit=1&offset=1')).body;
  assert.equal(page.alerts.length, 1);
  assert.equal(page.total, 2);
  assert.equal((await call('GET', '/api/alerts?limit=0')).status, 400);
});

test("alerts are private: another user sees none and cannot mark them read", async () => {
  const mine = (await call('GET', '/api/alerts')).body.alerts[0];
  assert.deepEqual((await call('GET', '/api/alerts', undefined, other.token)).body.alerts, []);
  assert.equal((await call('POST', `/api/alerts/${mine.id}/read`, undefined, other.token)).status, 404);
  assert.equal((await call('POST', `/api/alerts/${randomUUID()}/read`)).status, 404);
  assert.equal((await call('POST', '/api/alerts/not-an-id/read')).status, 404);
});

test('deleting the rule keeps the alerts it produced', async () => {
  const rules = (await call('GET', '/api/alert-rules')).body;
  const low = rules.find((r) => r.type === 'low_balance');
  assert.equal((await call('DELETE', `/api/alert-rules/${low.id}`)).status, 200);
  const alerts = (await call('GET', '/api/alerts')).body.alerts;
  assert.equal(alerts.length, 2);
  assert.equal(alerts.find((a) => a.type === 'low_balance').ruleId, null);
});

test('a bill added with a due date inside the window raises an alert', async () => {
  await call('PUT', '/api/alert-rules', { type: 'bill_due_soon', threshold: 7 });
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
  await call('POST', '/api/bills', { name: 'Rent', amount: 400, dueDate: due });
  const alert = (await call('GET', '/api/alerts')).body.alerts.find((a) => a.type === 'bill_due_soon');
  assert.ok(alert);
  assert.match(alert.message, /^Rent \(400\.00\) is due/);
});
