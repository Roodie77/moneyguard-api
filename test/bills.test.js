import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
let alice;
let bob;
before(async () => {
  app = await startApp();
  alice = await registerUser(app.api);
  bob = await registerUser(app.api);
});
after(() => app.stop());

const createBill = (user, body) => app.api('POST', '/api/bills', { token: user.token, body });

test('create: returns the bill with numeric amount; numeric strings are accepted', async () => {
  const res = await createBill(alice, { name: '  Rent ', amount: '250.75', dueDate: '2026-10-30' });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Rent');
  assert.equal(res.body.amount, 250.75);
  assert.equal(res.body.userId, alice.user.id);
  assert.ok(res.body.dueDate.startsWith('2026-10-30'));
});

test('create: dueDate is optional', async () => {
  const res = await createBill(alice, { name: 'Gym', amount: 20 });
  assert.equal(res.status, 201);
  assert.equal(res.body.dueDate, null);
});

test('create: invalid input returns every field error at once', async () => {
  const res = await createBill(alice, { name: '', amount: -1 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.details.map((d) => d.field).sort(), ['amount', 'name']);

  for (const amount of [0, true, '', null, [1]]) {
    assert.equal((await createBill(alice, { name: 'X', amount })).status, 400, `amount: ${JSON.stringify(amount)}`);
  }
  assert.equal((await createBill(alice, { name: 'X', amount: 5, dueDate: 'soon' })).status, 400);
});

test('list: a user only sees their own bills', async () => {
  const mine = await app.api('GET', '/api/bills', { token: alice.token });
  const theirs = await app.api('GET', '/api/bills', { token: bob.token });
  assert.equal(mine.body.length, 2);
  assert.ok(mine.body.every((b) => b.userId === alice.user.id));
  assert.deepEqual(theirs.body, []);
});

test('delete: another user cannot delete my bill; I can, once', async () => {
  const { body: bill } = await createBill(alice, { name: 'Temp', amount: 5 });

  assert.equal((await app.api('DELETE', `/api/bills/${bill.id}`, { token: bob.token })).status, 404);
  assert.equal((await app.api('DELETE', `/api/bills/${bill.id}`, { token: alice.token })).status, 200);
  assert.equal((await app.api('DELETE', `/api/bills/${bill.id}`, { token: alice.token })).status, 404);
});

test('delete: a malformed id is a 404, not a server error', async () => {
  const res = await app.api('DELETE', '/api/bills/not-a-uuid', { token: alice.token });
  assert.equal(res.status, 404);
});

test('bills require authentication', async () => {
  assert.equal((await app.api('GET', '/api/bills')).status, 401);
});
