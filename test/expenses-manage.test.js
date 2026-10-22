// Listing with filters and pages, editing and deleting expenses (the balance moves with them).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp, registerUser } from './helpers.js';

let app;
let user;
const ids = {};
before(async () => {
  app = await startApp();
  user = await registerUser(app.api);
  await app.api('PUT', '/api/balance', { token: user.token, body: { balance: 1000 } });
  const add = async (key, body) => { ids[key] = (await app.api('POST', '/api/expenses', { token: user.token, body })).body.id; };
  await add('a', { amount: 10, category: 'Food', date: '2026-01-10T12:00:00Z' });
  await add('b', { amount: 20, category: 'food', date: '2026-01-20T12:00:00Z' });
  await add('c', { amount: 30, category: 'Travel', date: '2026-02-05T23:30:00Z' });
  await add('d', { amount: 40, category: 'Travel', date: '2026-02-15T12:00:00Z' });
  await add('e', { amount: 50, category: 'Other', date: '2026-03-01T12:00:00Z' });
});
after(() => app.stop());

const list = (qs = '') => app.api('GET', `/api/expenses${qs}`, { token: user.token });
const balance = async () => (await app.api('GET', '/api/me', { token: user.token })).body.balance;
const amounts = (res) => res.body.map((e) => e.amount);

test('list: newest first, with the total count in a header', async () => {
  const res = await list();
  assert.equal(res.status, 200);
  assert.deepEqual(amounts(res), [50, 40, 30, 20, 10]);
  assert.equal(res.headers.get('x-total-count'), '5');
});

test('list: category filter ignores letter case', async () => {
  const res = await list('?category=FOOD');
  assert.deepEqual(amounts(res), [20, 10]);
  assert.equal(res.headers.get('x-total-count'), '2');
  assert.deepEqual(amounts(await list('?category=nothing')), []);
});

test('list: from and to are whole UTC days, both included', async () => {
  assert.deepEqual(amounts(await list('?from=2026-02-01&to=2026-02-28')), [40, 30]);
  assert.deepEqual(amounts(await list('?to=2026-02-05')), [30, 20, 10]); // 23:30 on the 5th is still the 5th
  assert.deepEqual(amounts(await list('?from=2026-02-05&to=2026-02-05')), [30]);
  assert.deepEqual(amounts(await list('?from=2026-03-02')), []);
});

test('list: amount range, and filters combine', async () => {
  assert.deepEqual(amounts(await list('?minAmount=30&maxAmount=40')), [40, 30]);
  assert.deepEqual(amounts(await list('?category=travel&minAmount=35')), [40]);
});

test('list: pages with limit and offset; total stays the full match count', async () => {
  const first = await list('?limit=2');
  assert.deepEqual(amounts(first), [50, 40]);
  assert.equal(first.headers.get('x-total-count'), '5');
  assert.deepEqual(amounts(await list('?limit=2&offset=2')), [30, 20]);
  assert.deepEqual(amounts(await list('?limit=2&offset=4')), [10]);
  assert.deepEqual(amounts(await list('?limit=2&offset=99')), []);
});

test('list: bad filters are a 400 with the field named; unknown parameters are ignored', async () => {
  const bad = [
    ['?limit=0', 'limit'], ['?limit=501', 'limit'], ['?limit=abc', 'limit'], ['?offset=-1', 'offset'],
    ['?from=2026-02-30', 'from'], ['?to=yesterday', 'to'], ['?minAmount=0', 'minAmount'], ['?maxAmount=x', 'maxAmount'],
  ];
  for (const [qs, field] of bad) {
    const res = await list(qs);
    assert.equal(res.status, 400, qs);
    assert.ok(res.body.details.some((d) => d.field === field), `${qs}: expected an error on ${field}`);
  }
  assert.equal((await list('?from=2026-03-01&to=2026-01-01')).status, 400); // from after to
  assert.equal((await list('?minAmount=50&maxAmount=10')).status, 400);
  assert.equal((await list('?colour=red')).status, 200);
});

test('edit: category and description change without touching the balance', async () => {
  const before = await balance();
  const res = await app.api('PUT', `/api/expenses/${ids.c}`, { token: user.token, body: { category: ' Fun ', description: 'cinema' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.category, 'Fun');
  assert.equal(res.body.description, 'cinema');
  assert.equal(res.body.amount, 30);
  assert.equal(await balance(), before);
});

test('edit: a changed amount moves the balance by the difference, up or down', async () => {
  const start = await balance();
  const up = await app.api('PUT', `/api/expenses/${ids.e}`, { token: user.token, body: { amount: 70 } });
  assert.equal(up.body.amount, 70);
  assert.equal(await balance(), start - 20);
  const down = await app.api('PUT', `/api/expenses/${ids.e}`, { token: user.token, body: { amount: 20.25 } });
  assert.equal(down.body.amount, 20.25);
  assert.equal(await balance(), start + 29.75);
  await app.api('PUT', `/api/expenses/${ids.e}`, { token: user.token, body: { amount: 50 } }); // back to the original
  assert.equal(await balance(), start);
});

test('edit: raising an amount beyond the balance is a 422 and changes nothing; exactly the balance is allowed', async () => {
  const start = await balance();
  const refused = await app.api('PUT', `/api/expenses/${ids.a}`, { token: user.token, body: { amount: 10 + start + 0.01 } });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, 'Insufficient balance');
  assert.equal(await balance(), start);
  assert.equal((await list()).body.find((e) => e.id === ids.a).amount, 10);

  const exact = await app.api('PUT', `/api/expenses/${ids.a}`, { token: user.token, body: { amount: 10 + start } });
  assert.equal(exact.status, 200);
  assert.equal(await balance(), 0);
  await app.api('PUT', '/api/balance', { token: user.token, body: { balance: 1000 } }); // reset for the tests below
  await app.api('PUT', `/api/expenses/${ids.a}`, { token: user.token, body: { amount: 10 } });
});

test('edit: nothing to change, bad values, unknown and malformed ids', async () => {
  const put = (id, body) => app.api('PUT', `/api/expenses/${id}`, { token: user.token, body });
  assert.equal((await put(ids.a, {})).status, 400);
  assert.equal((await put(ids.a, { amount: 0 })).status, 400);
  assert.equal((await put(ids.a, { amount: 'lots' })).status, 400);
  assert.equal((await put(ids.a, { date: '2026-02-30' })).status, 400);
  assert.equal((await put(randomUUID(), { amount: 5 })).status, 404);
  assert.equal((await put('not-an-id', { amount: 5 })).status, 404);
});

test('delete: the amount goes back to the balance, once', async () => {
  const start = await balance();
  const res = await app.api('DELETE', `/api/expenses/${ids.d}`, { token: user.token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, balance: start + 40 });
  assert.equal(await balance(), start + 40);
  assert.equal((await app.api('DELETE', `/api/expenses/${ids.d}`, { token: user.token })).status, 404);
  assert.equal(await balance(), start + 40);
  assert.equal((await list()).headers.get('x-total-count'), '4');
});

test("one user cannot edit or delete another user's expense", async () => {
  const other = await registerUser(app.api);
  const before = await balance();
  assert.equal((await app.api('PUT', `/api/expenses/${ids.b}`, { token: other.token, body: { amount: 1 } })).status, 404);
  assert.equal((await app.api('DELETE', `/api/expenses/${ids.b}`, { token: other.token })).status, 404);
  assert.equal(await balance(), before);
  assert.equal((await list()).body.find((e) => e.id === ids.b).amount, 20);
});
