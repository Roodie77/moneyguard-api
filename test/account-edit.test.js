// Editing the details entered at sign-up: name, phone, email, and the password.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

const PASSWORD = 'password123';
async function newUser(extra = {}) {
  const email = `${randomUUID()}@test.dev`;
  const res = await app.api('POST', '/api/auth/register', { body: { email, password: PASSWORD, ...extra } });
  assert.equal(res.status, 201);
  return { email, ...res.body };
}
const put = (path, body, token) => app.api('PUT', path, { token, body });
const me = async (token) => (await app.api('GET', '/api/me', { token })).body;
const login = (email, password) => app.api('POST', '/api/auth/login', { body: { email, password } });

test('a name can be given at sign-up and comes back on register, login and /api/me', async () => {
  const u = await newUser({ name: '  Jonathan Adewale  ', phone: '+234 801 234 5678' });
  assert.equal(u.user.name, 'Jonathan Adewale'); // trimmed
  assert.equal((await login(u.email, PASSWORD)).body.user.name, 'Jonathan Adewale');
  assert.equal((await me(u.token)).name, 'Jonathan Adewale');
  const without = await newUser();
  assert.equal(without.user.name, null);
});

test('name and phone can be changed or cleared, and only what is sent changes', async () => {
  const u = await newUser({ name: 'Ada', phone: '+234 801 234 5678' });
  const first = await put('/api/me', { name: 'Ada Obi' }, u.token);
  assert.equal(first.status, 200);
  assert.equal(first.body.name, 'Ada Obi');
  assert.equal(first.body.phone, '+234 801 234 5678'); // untouched

  const second = await put('/api/me', { phone: '08012345678' }, u.token);
  assert.equal(second.body.phone, '08012345678');
  assert.equal(second.body.name, 'Ada Obi');

  const cleared = await put('/api/me', { name: '', phone: null }, u.token);
  assert.equal(cleared.body.name, null);
  assert.equal(cleared.body.phone, null);
  assert.deepEqual(await me(u.token), cleared.body);
});

test('the answer never contains the password hash or other internal fields', async () => {
  const u = await newUser();
  const res = await put('/api/me', { name: 'X' }, u.token);
  for (const field of ['passwordHash', 'passwordChangedAt', 'avatarPublicId']) assert.equal(field in res.body, false, field);
});

test('only name, phone and email can be changed here: nothing else, and an empty request is refused', async () => {
  const u = await newUser();
  const sneaky = await put('/api/me', { name: 'Y', balance: 999999, id: randomUUID() }, u.token);
  assert.equal(sneaky.status, 200);
  assert.equal(sneaky.body.balance, 0);
  assert.equal(sneaky.body.id, u.user.id);
  assert.equal((await put('/api/me', { balance: 5 }, u.token)).status, 400); // nothing editable was sent
  assert.equal((await put('/api/me', {}, u.token)).status, 400);
});

test('bad values are a 400 naming the field', async () => {
  const u = await newUser();
  const bad = [[{ phone: 'abc' }, 'phone'], [{ name: 'x'.repeat(101) }, 'name'], [{ name: 'a\u0000b' }, 'name'], [{ email: 'nope', currentPassword: PASSWORD }, 'email']];
  for (const [body, field] of bad) {
    const res = await put('/api/me', body, u.token);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.details.some((d) => d.field === field), `${JSON.stringify(body)}: expected an error on "${field}"`);
  }
});

test('changing the email needs the current password; a wrong one is a 400 (never a 401) and changes nothing', async () => {
  const u = await newUser();
  const newEmail = `${randomUUID()}@Test.dev`;

  const missing = await put('/api/me', { email: newEmail }, u.token);
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.details, [{ field: 'currentPassword', message: 'currentPassword is required to change the email' }]);

  const wrong = await put('/api/me', { email: newEmail, currentPassword: 'wrong-password' }, u.token);
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body.details, [{ field: 'currentPassword', message: 'Current password is incorrect' }]);
  assert.equal((await me(u.token)).email, u.email);

  const ok = await put('/api/me', { email: newEmail, currentPassword: PASSWORD }, u.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, newEmail.toLowerCase());
  assert.equal((await login(newEmail, PASSWORD)).status, 200); // the new email logs in (any letter case)
  assert.equal((await login(u.email, PASSWORD)).status, 401); // the old one no longer does
  assert.equal((await me(u.token)).email, newEmail.toLowerCase()); // the current session keeps working
});

test('an email that another account already uses is a 409; sending your own email again is fine', async () => {
  const a = await newUser();
  const b = await newUser();
  const taken = await put('/api/me', { email: a.email.toUpperCase(), currentPassword: PASSWORD }, b.token);
  assert.equal(taken.status, 409);
  const same = await put('/api/me', { email: b.email, currentPassword: PASSWORD }, b.token);
  assert.equal(same.status, 200);
  assert.equal(same.body.email, b.email);
});

test('changing the password: the right current password is required, and the new one follows the password rules', async () => {
  const u = await newUser();
  const wrong = await put('/api/me/password', { currentPassword: 'nope-nope', newPassword: 'brand-new-pass' }, u.token);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.details[0].field, 'currentPassword');

  const short = await put('/api/me/password', { currentPassword: PASSWORD, newPassword: 'short' }, u.token);
  assert.equal(short.status, 400);
  assert.ok(short.body.details.some((d) => d.field === 'newPassword'));

  const same = await put('/api/me/password', { currentPassword: PASSWORD, newPassword: PASSWORD }, u.token);
  assert.equal(same.status, 400);
  assert.equal(same.body.details[0].field, 'newPassword');

  assert.equal((await login(u.email, PASSWORD)).status, 200); // still the old password
});

test('a password change gives this device a fresh session, and ends every other login', async () => {
  const u = await newUser();
  const otherDevice = (await login(u.email, PASSWORD)).body;
  await new Promise((r) => setTimeout(r, 1100)); // tokens have 1 second resolution; make sure older ones predate the change

  const res = await put('/api/me/password', { currentPassword: PASSWORD, newPassword: 'brand-new-pass' }, u.token);
  assert.equal(res.status, 200);
  assert.ok(res.body.token && res.body.refreshToken);
  assert.equal(res.body.expiresIn, 3600);

  assert.equal((await app.api('GET', '/api/me', { token: res.body.token })).status, 200); // the new session works
  assert.equal((await app.api('POST', '/api/auth/refresh', { body: { refreshToken: res.body.refreshToken } })).status, 200);

  assert.equal((await app.api('GET', '/api/me', { token: u.token })).status, 401); // the old access token
  assert.equal((await app.api('GET', '/api/me', { token: otherDevice.token })).status, 401); // another device
  assert.equal((await app.api('POST', '/api/auth/refresh', { body: { refreshToken: otherDevice.refreshToken } })).status, 401);
  assert.equal((await app.api('POST', '/api/auth/refresh', { body: { refreshToken: u.refreshToken } })).status, 401);

  assert.equal((await login(u.email, PASSWORD)).status, 401); // the old password is gone
  assert.equal((await login(u.email, 'brand-new-pass')).status, 200);
});

test('both endpoints need a token', async () => {
  assert.equal((await put('/api/me', { name: 'x' })).status, 401);
  assert.equal((await put('/api/me/password', { currentPassword: PASSWORD, newPassword: 'brand-new-pass' })).status, 401);
});
