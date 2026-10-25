// Deleting an account with a one-day grace period (files kept on this server's disk).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, registerUser } from './helpers.js';

const PASSWORD = 'password123';
// A private upload folder, so tests running at the same time do not see each other's files.
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'moneyguard-uploads-'));
process.env.UPLOADS_DIR = UPLOAD_DIR; // must be set before the app is imported
const created = new Set();

let app;
let query;
let sweep;
before(async () => {
  app = await startApp();
  ({ query } = await import('../src/utils/db.js'));
  ({ sweepDeletedAccounts: sweep } = await import('../src/services/account.js'));
});
after(async () => {
  for (const name of created) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
  await app.stop();
});

const call = (token, method, p, body) => app.api(method, p, { token, body });
const requestDeletion = (u, password = PASSWORD) => call(u.token, 'DELETE', '/api/me', { currentPassword: password });
// Moves the deadline into the past, as if a day had gone by.
const makeDue = (id) => query("UPDATE users SET deletion_requested_at = now() - interval '25 hours', deletes_at = now() - interval '1 hour' WHERE id = $1", [id]);
const rowsOf = async (table, id) => (await query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [id]))[0].n;
const userExists = async (id) => (await query('SELECT 1 FROM users WHERE id = $1', [id])).length === 1;

// A user with something in every table that holds their data. Created with SQL, not the API, so the many users these
// tests need do not run into the API's write rate limit.
async function userWithData() {
  const u = await registerUser(app.api);
  const id = u.user.id;
  await query('UPDATE users SET balance = 1000 WHERE id = $1', [id]);
  await query("INSERT INTO bills (user_id, name, amount) VALUES ($1, 'Rent', 100)", [id]);
  await query("INSERT INTO expenses (user_id, amount, category) VALUES ($1, 10, 'Food')", [id]);
  await query("INSERT INTO alert_rules (user_id, type, threshold) VALUES ($1, 'daily_spend_limit', 5)", [id]);
  await query('INSERT INTO financial_profiles (user_id, monthly_income) VALUES ($1, 500)', [id]);
  return u;
}

async function upload(token, kind, content = 'PNGDATA') {
  const form = new FormData();
  form.append(kind === 'avatar' ? 'avatar' : 'file', new Blob([content], { type: 'image/png' }), 'x.png');
  const res = await fetch(`${app.base}${kind === 'avatar' ? '/api/me/avatar' : '/api/files'}`, { method: kind === 'avatar' ? 'PUT' : 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  const body = await res.json();
  const name = path.basename(body.avatarUrl ?? body.url ?? '');
  if (name) created.add(name);
  return { status: res.status, body, name };
}

test('it needs the current password: missing or wrong is a 400 naming the field (never a 401), and nothing is scheduled', async () => {
  const u = await registerUser(app.api);
  const missing = await call(u.token, 'DELETE', '/api/me', {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.details[0].field, 'currentPassword');
  const wrong = await requestDeletion(u, 'not-the-password');
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body.details, [{ field: 'currentPassword', message: 'Current password is incorrect' }]);
  assert.equal((await call(u.token, 'GET', '/api/me')).body.accountStatus, 'active');
  assert.equal((await app.api('DELETE', '/api/me', { body: { currentPassword: PASSWORD } })).status, 401); // and a token
});

test('asking for deletion answers 202 "pending" with the deadline, 24 hours away, and a sentence to show', async () => {
  const u = await registerUser(app.api);
  const res = await requestDeletion(u);
  assert.equal(res.status, 202);
  assert.equal(res.body.accountStatus, 'pending_deletion');
  assert.equal(res.body.graceHours, 24);
  const hours = (Date.parse(res.body.deletesAt) - Date.parse(res.body.requestedAt)) / 3_600_000;
  assert.ok(Math.abs(hours - 24) < 0.01, `deadline is ${hours} hours away`);
  assert.ok(Math.abs(Date.parse(res.body.requestedAt) - Date.now()) < 60_000);
  assert.match(res.body.message, /scheduled for permanent deletion at /);
  assert.ok(res.body.message.includes(res.body.deletesAt));
  assert.match(res.body.message, /cancel/i);
  assert.ok(await userExists(u.user.id)); // nothing is deleted yet
});

test('while pending, the account still works, and every screen can tell the user it is pending', async () => {
  const u = await userWithData();
  const { body: pending } = await requestDeletion(u);

  const me = (await call(u.token, 'GET', '/api/me')).body;
  assert.equal(me.accountStatus, 'pending_deletion');
  assert.equal(me.deletesAt, pending.deletesAt);
  assert.equal(me.deletionRequestedAt, pending.requestedAt);

  const dashboard = (await call(u.token, 'GET', '/api/dashboard')).body;
  assert.equal(dashboard.accountDeletion.deletesAt, pending.deletesAt);
  assert.match(dashboard.accountDeletion.message, /permanent deletion/);

  const login = (await app.api('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } })).body;
  assert.equal(login.user.accountStatus, 'pending_deletion');
  assert.equal(login.accountDeletion.deletesAt, pending.deletesAt); // shown straight after logging in

  assert.equal((await call(u.token, 'GET', '/api/bills')).status, 200); // still usable, so the user can see and cancel
  assert.equal((await call(u.token, 'PUT', '/api/balance', { balance: 5 })).status, 200);
  assert.ok(!('passwordHash' in me));
});

test('an active account says so: status "active", no dates, no notice', async () => {
  const u = await registerUser(app.api);
  const me = (await call(u.token, 'GET', '/api/me')).body;
  assert.equal(me.accountStatus, 'active');
  assert.equal(me.deletesAt, null);
  assert.equal(me.deletionRequestedAt, null);
  assert.equal((await call(u.token, 'GET', '/api/dashboard')).body.accountDeletion, null);
  assert.equal((await app.api('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } })).body.accountDeletion, null);
  assert.equal(u.user.accountStatus, 'active'); // and the register answer
});

test('asking again keeps the same deadline: it is never pushed back', async () => {
  const u = await registerUser(app.api);
  const first = (await requestDeletion(u)).body;
  await new Promise((r) => setTimeout(r, 50));
  const second = await requestDeletion(u);
  assert.equal(second.status, 202);
  assert.equal(second.body.deletesAt, first.deletesAt);
  assert.equal(second.body.requestedAt, first.requestedAt);
});

test('cancelling restores everything, is safe to repeat, and a new request starts a fresh day', async () => {
  const u = await userWithData();
  const first = (await requestDeletion(u)).body;
  const cancel = await call(u.token, 'POST', '/api/me/cancel-deletion');
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.accountStatus, 'active');
  assert.equal(cancel.body.deletesAt, null);
  assert.match(cancel.body.message, /unchanged/);
  assert.equal(cancel.body.user.accountStatus, 'active');
  assert.equal((await call(u.token, 'GET', '/api/me')).body.deletesAt, null);
  assert.equal((await call(u.token, 'POST', '/api/me/cancel-deletion')).status, 200); // nothing pending: fine

  await sweep(); // nothing is due, nothing is removed
  assert.equal(await rowsOf('bills', u.user.id), 1);

  const again = await requestDeletion(u);
  assert.equal(again.status, 202);
  assert.ok(Date.parse(again.body.deletesAt) >= Date.parse(first.deletesAt));
});

test('before the deadline nothing is deleted, even by the sweep', async () => {
  const u = await userWithData();
  await requestDeletion(u);
  assert.equal(await sweep(), 0);
  assert.ok(await userExists(u.user.id));
  assert.equal(await rowsOf('bills', u.user.id), 1);
  assert.equal(await rowsOf('expenses', u.user.id), 1);
});

test('after the deadline the account is gone at once, even before the sweep runs, and so is all its data', async () => {
  const u = await userWithData();
  await requestDeletion(u);
  await makeDue(u.user.id);

  const res = await call(u.token, 'GET', '/api/me'); // the very next request
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Account not found');

  assert.equal(await userExists(u.user.id), false);
  for (const table of ['bills', 'expenses', 'alert_rules', 'financial_profiles', 'refresh_tokens', 'alerts', 'files', 'affordability_checks', 'password_reset_tokens']) {
    assert.equal(await rowsOf(table, u.user.id), 0, `${table} must be empty`);
  }
});

test('logging in after the deadline fails, and the email can be registered again', async () => {
  const u = await registerUser(app.api);
  await requestDeletion(u);
  await makeDue(u.user.id);
  assert.equal((await app.api('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } })).status, 401);
  assert.equal(await userExists(u.user.id), false);
  const again = await app.api('POST', '/api/auth/register', { body: { email: u.email, password: PASSWORD } });
  assert.equal(again.status, 201); // a brand-new, empty account
  assert.notEqual(again.body.user.id, u.user.id);
});

test('the sweep deletes due accounts with no request at all, and leaves the others alone', async () => {
  const due = await userWithData();
  const notYet = await userWithData();
  const active = await userWithData();
  await requestDeletion(due);
  await makeDue(due.user.id);
  await requestDeletion(notYet);

  assert.ok(await sweep() >= 1);
  assert.equal(await userExists(due.user.id), false);
  assert.equal(await rowsOf('bills', due.user.id), 0);
  assert.ok(await userExists(notYet.user.id));
  assert.ok(await userExists(active.user.id));
  assert.equal(await rowsOf('bills', active.user.id), 1);
});

test('a cancel that arrives after the deadline cannot bring the account back', async () => {
  const u = await registerUser(app.api);
  await requestDeletion(u);
  await makeDue(u.user.id);
  const res = await call(u.token, 'POST', '/api/me/cancel-deletion');
  assert.equal(res.status, 401);
  assert.equal(await userExists(u.user.id), false);
});

test('the email cannot be registered again while the deletion is only pending', async () => {
  const u = await registerUser(app.api);
  await requestDeletion(u);
  assert.equal((await app.api('POST', '/api/auth/register', { body: { email: u.email, password: PASSWORD } })).status, 409);
});

test("uploaded files and the profile picture are deleted too, and other people's files are not", async () => {
  const gone = await registerUser(app.api);
  const stays = await registerUser(app.api);
  const file = await upload(gone.token, 'file');
  const avatar = await upload(gone.token, 'avatar');
  const keep = await upload(stays.token, 'file');
  // An empty name would point at the folder itself (which exists), so make sure the uploads really worked.
  for (const up of [file, avatar, keep]) { assert.ok(up.status < 300 && up.name, `upload failed: ${up.status} ${JSON.stringify(up.body)}`); }
  const onDisk = (name) => fs.existsSync(path.join(UPLOAD_DIR, name));
  assert.ok(onDisk(file.name) && onDisk(avatar.name) && onDisk(keep.name));

  await requestDeletion(gone);
  assert.ok(onDisk(file.name) && onDisk(avatar.name)); // still there during the grace period
  await makeDue(gone.user.id);
  await sweep();

  assert.equal(onDisk(file.name), false);
  assert.equal(onDisk(avatar.name), false);
  assert.ok(onDisk(keep.name), "another user's file must stay");
  assert.equal((await query('SELECT count(*)::int AS n FROM storage_cleanup'))[0].n, 0); // the queue is empty again
});

test('it needs a token, and so does cancelling', async () => {
  assert.equal((await app.api('DELETE', '/api/me', { body: { currentPassword: PASSWORD } })).status, 401);
  assert.equal((await app.api('POST', '/api/me/cancel-deletion')).status, 401);
});
