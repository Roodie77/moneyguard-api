import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp } from './helpers.js';

let app;
let sent; // reset tokens "emailed" so far, by address
before(async () => {
  app = await startApp();
  const { setMailer } = await import('../src/services/mailer.js');
  sent = new Map();
  setMailer(async ({ email, token }) => { sent.set(email, token); });
});
after(() => app.stop());

const post = (path, body) => app.api('POST', `/api/auth/${path}`, { body });
const login = (email, password = 'password123') => post('login', { email, password });
const me = (token) => app.api('GET', '/api/me', { token });
const newUser = async () => {
  const email = `${randomUUID()}@test.dev`;
  const res = await post('register', { email, password: 'password123' });
  return { email, ...res.body };
};
const sentTo = async (email) => { // the mail is sent just after the response
  for (let i = 0; i < 100 && !sent.has(email); i++) await new Promise((r) => setTimeout(r, 10));
  return sent.get(email);
};
const requestReset = async (email) => {
  sent.delete(email);
  await post('forgot-password', { email });
  return sentTo(email);
};

test('register and login return a refresh token alongside the access token', async () => {
  const { email, refreshToken } = await newUser();
  assert.ok(refreshToken);
  const res = await login(email);
  assert.ok(res.body.refreshToken);
  assert.notEqual(res.body.refreshToken, refreshToken);
  assert.equal('passwordChangedAt' in res.body.user, false);
});

test('access tokens last 1 hour; refresh tokens last 7 days', async () => {
  const { default: jwt } = await import('jsonwebtoken');
  const user = await newUser();
  const claims = jwt.decode(user.token);
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(user.expiresIn, 3600);

  const { query } = await import('../src/utils/db.js');
  const [{ days }] = await query('SELECT round(extract(epoch FROM expires_at - now()) / 86400) AS days FROM refresh_tokens WHERE user_id = $1', [user.user.id]);
  assert.equal(Number(days), 7);
});

test('an expired access token is a 401, and a refresh gets the user back in', async () => {
  const { default: jwt } = await import('jsonwebtoken');
  const user = await newUser();
  const expired = jwt.sign({ userId: user.user.id }, process.env.JWT_SECRET || 'moneyguard-dev-secret-change-me', { expiresIn: -10 });
  assert.equal((await me(expired)).status, 401);

  const renewed = await post('refresh', { refreshToken: user.refreshToken });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.expiresIn, 3600);
  assert.equal((await me(renewed.body.token)).status, 200);
});

test('refresh: trades a refresh token for a working access token and a new refresh token', async () => {
  const user = await newUser();
  const res = await post('refresh', { refreshToken: user.refreshToken });
  assert.equal(res.status, 200);
  assert.equal((await me(res.body.token)).status, 200);
  assert.ok(res.body.refreshToken && res.body.refreshToken !== user.refreshToken);

  assert.equal((await post('refresh', { refreshToken: res.body.refreshToken })).status, 200); // the chain keeps going
});

test('refresh: junk, missing and unknown tokens are rejected', async () => {
  assert.equal((await post('refresh', {})).status, 400);
  assert.equal((await post('refresh', { refreshToken: 123 })).status, 400);
  assert.equal((await post('refresh', { refreshToken: 'nope' })).status, 401);
});

test('refresh: a used token is rejected, and reusing it revokes the whole login', async () => {
  const user = await newUser();
  const next = await post('refresh', { refreshToken: user.refreshToken });
  assert.equal((await post('refresh', { refreshToken: user.refreshToken })).status, 401); // replay
  assert.equal((await post('refresh', { refreshToken: next.body.refreshToken })).status, 401); // family is gone
});

test('refresh: two simultaneous uses of one token let exactly one through', async () => {
  const user = await newUser();
  const results = await Promise.all(Array.from({ length: 5 }, () => post('refresh', { refreshToken: user.refreshToken })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
});

test('refresh: separate logins are independent', async () => {
  const user = await newUser();
  const second = await login(user.email);
  await post('refresh', { refreshToken: user.refreshToken });
  await post('refresh', { refreshToken: user.refreshToken }); // replay kills the first login only
  assert.equal((await post('refresh', { refreshToken: second.body.refreshToken })).status, 200);
});

test('refresh: expired tokens are rejected', async () => {
  const user = await newUser();
  const { query } = await import('../src/utils/db.js');
  await query("UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1", [user.user.id]);
  assert.equal((await post('refresh', { refreshToken: user.refreshToken })).status, 401);
});

test('logout: revokes the refresh token; it is safe to call twice or with a junk token', async () => {
  const user = await newUser();
  assert.equal((await post('logout', { refreshToken: user.refreshToken })).status, 200);
  assert.equal((await post('refresh', { refreshToken: user.refreshToken })).status, 401);
  assert.equal((await post('logout', { refreshToken: user.refreshToken })).status, 200);
  assert.equal((await post('logout', { refreshToken: 'junk' })).status, 200);
});

test('forgot-password: same answer for known and unknown emails; only a known one gets a token', async () => {
  const user = await newUser();
  const unknown = `${randomUUID()}@test.dev`;
  const known = await post('forgot-password', { email: user.email.toUpperCase() });
  const missing = await post('forgot-password', { email: unknown });
  assert.equal(known.status, 200);
  assert.deepEqual(known.body, missing.body);
  assert.ok(await sentTo(user.email));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.has(unknown), false);
  assert.equal((await post('forgot-password', { email: 'not-an-email' })).status, 400);
});

test('reset-password: sets the new password, ends every session, and the token works once', async () => {
  const user = await newUser();
  const otherLogin = await login(user.email);
  const token = await requestReset(user.email);

  await new Promise((r) => setTimeout(r, 1100)); // token iat has 1s resolution; make sure old tokens predate the reset
  assert.equal((await post('reset-password', { token, password: 'brand-new-pass' })).status, 200);

  assert.equal((await login(user.email)).status, 401); // old password
  const again = await login(user.email, 'brand-new-pass');
  assert.equal(again.status, 200);
  assert.equal((await me(again.body.token)).status, 200);

  assert.equal((await me(user.token)).status, 401); // old access tokens
  assert.equal((await me(otherLogin.body.token)).status, 401);
  assert.equal((await post('refresh', { refreshToken: user.refreshToken })).status, 401); // old refresh tokens
  assert.equal((await post('refresh', { refreshToken: otherLogin.body.refreshToken })).status, 401);

  assert.equal((await post('reset-password', { token, password: 'another-pass-1' })).status, 400); // already used
});

test('reset-password: bad token, bad password, replaced token and expired token are all rejected', async () => {
  const user = await newUser();
  assert.equal((await post('reset-password', { token: 'nope', password: 'brand-new-pass' })).status, 400);

  const first = await requestReset(user.email);
  assert.equal((await post('reset-password', { token: first, password: 'short' })).status, 400);

  const second = await requestReset(user.email);
  assert.equal((await post('reset-password', { token: first, password: 'brand-new-pass' })).status, 400); // replaced

  const { query } = await import('../src/utils/db.js');
  await query("UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1", [user.user.id]);
  assert.equal((await post('reset-password', { token: second, password: 'brand-new-pass' })).status, 400); // expired
  assert.equal((await login(user.email)).status, 200); // password unchanged
});

test('reset-password: simultaneous uses of one token change the password once', async () => {
  const user = await newUser();
  const token = await requestReset(user.email);
  const results = await Promise.all(['pass-number-one', 'pass-number-two', 'pass-number-three'].map((password) =>
    post('reset-password', { token, password })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
});
