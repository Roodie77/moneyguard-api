// Editing a bill that was entered wrongly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp, registerUser } from './helpers.js';

let app;
let user;
let bill;
before(async () => {
  app = await startApp();
  user = await registerUser(app.api);
  bill = (await app.api('POST', '/api/bills', { token: user.token, body: { name: 'Rent', amount: 250, dueDate: '2030-01-15' } })).body;
});
after(() => app.stop());

const put = (id, body, token = user.token) => app.api('PUT', `/api/bills/${id}`, { token, body });
const list = async () => (await app.api('GET', '/api/bills', { token: user.token })).body;

test('only the fields sent change', async () => {
  const res = await put(bill.id, { amount: 300 });
  assert.equal(res.status, 200);
  assert.equal(res.body.amount, 300);
  assert.equal(res.body.name, 'Rent');
  assert.equal(res.body.dueDate, '2030-01-15T00:00:00.000Z');
  const renamed = await put(bill.id, { name: ' Flat rent ', dueDate: '2030-02-01' });
  assert.equal(renamed.body.name, 'Flat rent');
  assert.equal(renamed.body.dueDate, '2030-02-01T00:00:00.000Z');
  assert.equal(renamed.body.amount, 300);
  assert.deepEqual((await list())[0], renamed.body);
});

test('a due date can be removed with null', async () => {
  const res = await put(bill.id, { dueDate: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.dueDate, null);
});

test('bad values and an empty request are a 400', async () => {
  for (const body of [{}, { amount: 0 }, { amount: 'lots' }, { name: '' }, { dueDate: '2026-02-30' }, { dueDate: 'yesterday' }]) {
    assert.equal((await put(bill.id, body)).status, 400, JSON.stringify(body));
  }
});

test("another user's bill, an unknown id and a malformed id are all 404", async () => {
  const other = await registerUser(app.api);
  assert.equal((await put(bill.id, { amount: 1 }, other.token)).status, 404);
  assert.equal((await put(randomUUID(), { amount: 1 })).status, 404);
  assert.equal((await put('not-an-id', { amount: 1 })).status, 404);
  assert.equal((await list())[0].amount, 300); // untouched by the other user's attempt
});

test('it needs a token', async () => {
  assert.equal((await app.api('PUT', `/api/bills/${bill.id}`, { body: { amount: 1 } })).status, 401);
});
