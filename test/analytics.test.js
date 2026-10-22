import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
let user;
let query;
before(async () => {
  app = await startApp();
  ({ query } = await import('../src/utils/db.js'));
  user = await registerUser(app.api);
  // Inserted directly: the point here is the maths and the UTC bucketing, not the write endpoint.
  const rows = [
    [10, 'Food', '2026-03-01T08:00:00Z'],
    [5, 'food', '2026-03-01T20:00:00Z'], // same category, different spelling
    [100, 'Travel', '2026-03-02T12:00:00Z'],
    [1, 'Food', '2026-03-31T23:59:59Z'], // last second of March
    [7, 'Food', '2026-04-01T00:00:00Z'], // first second of April
    [20, 'Other', '2026-03-31T23:30:00-05:00'], // = 2026-04-01 04:30 UTC
    [3, 'Other', '2026-02-28T12:00:00Z'],
  ];
  for (const [amount, category, date] of rows) {
    await query('INSERT INTO expenses (user_id, amount, category, date) VALUES ($1, $2, $3, $4)', [user.user.id, amount, category, date]);
  }
});
after(() => app.stop());

const summary = (qs = '') => app.api('GET', `/api/analytics/summary${qs}`, { token: user.token });

test('totals, average and categories for a range (both end days included)', async () => {
  const res = await summary('?from=2026-03-01&to=2026-03-31');
  assert.equal(res.status, 200);
  const b = res.body;
  assert.equal(b.from, '2026-03-01');
  assert.equal(b.to, '2026-03-31');
  assert.equal(b.days, 31);
  assert.equal(b.totalSpent, 116);
  assert.equal(b.transactionCount, 4);
  assert.equal(b.averageDailySpend, 3.74);
  assert.equal(b.topCategory, 'Travel');
  assert.equal(b.byCategory.length, 2);
  assert.deepEqual(b.byCategory[0], { category: 'Travel', total: 100, count: 1, percent: 86.2 });
  assert.equal(b.byCategory[1].total, 16); // Food and food are one group
  assert.equal(b.byCategory[1].count, 3);
  assert.equal(b.byCategory[1].percent, 13.8);
});

test('the day series is UTC, oldest first, and leaves out days with no spending', async () => {
  const { body } = await summary('?from=2026-03-01&to=2026-03-31');
  assert.deepEqual(body.series, [
    { period: '2026-03-01', total: 15, count: 2 },
    { period: '2026-03-02', total: 100, count: 1 },
    { period: '2026-03-31', total: 1, count: 1 },
  ]);
});

test('groupBy=month buckets by UTC month; a late-evening local time lands in the next UTC month', async () => {
  const { body } = await summary('?from=2026-02-01&to=2026-04-30&groupBy=month');
  assert.equal(body.groupBy, 'month');
  assert.deepEqual(body.series, [
    { period: '2026-02', total: 3, count: 1 },
    { period: '2026-03', total: 116, count: 4 },
    { period: '2026-04', total: 27, count: 2 }, // the 7 and the 20 (23:30 in UTC-5 on March 31)
  ]);
});

test('a single day, and a range with no spending', async () => {
  const one = await summary('?from=2026-03-02&to=2026-03-02');
  assert.equal(one.body.days, 1);
  assert.equal(one.body.totalSpent, 100);
  assert.equal(one.body.averageDailySpend, 100);

  const empty = await summary('?from=2025-01-01&to=2025-01-31');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.totalSpent, 0);
  assert.equal(empty.body.transactionCount, 0);
  assert.equal(empty.body.averageDailySpend, 0);
  assert.equal(empty.body.topCategory, null);
  assert.deepEqual(empty.body.byCategory, []);
  assert.deepEqual(empty.body.series, []);
});

test('with no parameters it covers the last 30 days up to today', async () => {
  await query('INSERT INTO expenses (user_id, amount, category) VALUES ($1, 12.34, $2)', [user.user.id, 'Today']);
  const { body } = await summary();
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(body.to, today);
  assert.equal(body.days, 30);
  assert.equal(body.totalSpent, 12.34); // the 2026 rows above are outside the window
  assert.equal(body.topCategory, 'Today');
  assert.equal(body.series.at(-1).period, today);
});

test('a missing "to" defaults to today, so a start date far in the past is rejected as too long', async () => {
  const res = await summary('?from=2020-01-01');
  assert.equal(res.status, 400);
  assert.match(res.body.details[0].message, /at most 731 days/);
});

test('bad parameters are a 400', async () => {
  const bad = ['?from=2026-02-30', '?to=soon', '?groupBy=week', '?from=2026-03-02&to=2026-03-01', '?from=2024-01-01&to=2026-12-31'];
  for (const qs of bad) assert.equal((await summary(qs)).status, 400, qs);
  assert.equal((await app.api('GET', '/api/analytics/summary')).status, 401);
});

test("one user's analytics never include another user's spending", async () => {
  const other = await registerUser(app.api);
  const res = await app.api('GET', '/api/analytics/summary?from=2026-03-01&to=2026-03-31', { token: other.token });
  assert.equal(res.body.totalSpent, 0);
  assert.deepEqual(res.body.byCategory, []);
});
