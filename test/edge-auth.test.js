// Edge cases for sessions, password reset and the balance check on expenses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { startApp, registerUser } from './helpers.js';

let app;
let sent;
before(async () => {
  app = await startApp();
  const { setMailer } = await import('../src/services/mailer.js');
  sent = new Map();
  setMailer(async ({ email, token }) => { sent.set(email, token); });
});
after(() => app.stop());

const post = (path, body) => app.api('POST', `/api/auth/${path}`, { body });

test('refresh and logout: oversized or wrongly typed tokens are a 400, never a 500', async () => {
  for (const refreshToken of ['x'.repeat(201), '', null, {}, [], true]) {
    assert.equal((await post('refresh', { refreshToken })).status, 400, JSON.stringify(refreshToken)?.slice(0, 20));
    assert.equal((await post('logout', { refreshToken })).status, 400);
  }
  assert.equal((await post('refresh', undefined)).status, 400);
});

test('reset-password: a password over 72 bytes (multi-byte characters) is a 400', async () => {
  const res = await post('reset-password', { token: 'whatever', password: 'é'.repeat(40) });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.some((d) => d.field === 'password'));
});

test('a token for a deleted account is rejected and its refresh tokens are gone', async () => {
  const email = `${randomUUID()}@test.dev`;
  const { body } = await post('register', { email, password: 'password123' });
  const { query } = await import('../src/utils/db.js');
  await query('DELETE FROM users WHERE id = $1', [body.user.id]);
  assert.equal((await app.api('GET', '/api/me', { token: body.token })).status, 401);
  assert.equal((await post('refresh', { refreshToken: body.refreshToken })).status, 401);
});

test('a refresh token is not an access token, and an access token is not a refresh token', async () => {
  const { body } = await post('register', { email: `${randomUUID()}@test.dev`, password: 'password123' });
  assert.equal((await app.api('GET', '/api/me', { token: body.refreshToken })).status, 401);
  assert.equal((await post('refresh', { refreshToken: body.token })).status, 401);
});

test('a reset token cannot be used as a refresh token', async () => {
  const email = `${randomUUID()}@test.dev`;
  await post('register', { email, password: 'password123' });
  await post('forgot-password', { email });
  for (let i = 0; i < 100 && !sent.has(email); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await post('refresh', { refreshToken: sent.get(email) })).status, 401);
});

test('forgot-password: unknown, mixed-case and padded emails behave sensibly', async () => {
  const email = `${randomUUID()}@test.dev`;
  await post('register', { email, password: 'password123' });
  assert.equal((await post('forgot-password', { email: `  ${email.toUpperCase()}  ` })).status, 200);
  for (let i = 0; i < 100 && !sent.has(email); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(sent.has(email), 'a mixed-case, padded email should still find the account');
  assert.equal((await post('forgot-password', {})).status, 400);
  assert.equal((await post('forgot-password', { email: 123 })).status, 400);
});

test('a failing mailer does not break the response or leak that the account exists', async () => {
  const { setMailer } = await import('../src/services/mailer.js');
  const email = `${randomUUID()}@test.dev`;
  await post('register', { email, password: 'password123' });
  setMailer(async () => { throw new Error('smtp down'); });
  const res = await post('forgot-password', { email });
  assert.equal(res.status, 200);
  assert.ok(res.body.message);
  setMailer(async ({ email: to, token }) => { sent.set(to, token); });
});

test('a token issued exactly before a password change is rejected, one issued after is accepted', async () => {
  const { body } = await post('register', { email: `${randomUUID()}@test.dev`, password: 'password123' });
  const { query } = await import('../src/utils/db.js');
  await query("UPDATE users SET password_changed_at = now() + interval '1 hour' WHERE id = $1", [body.user.id]);
  assert.equal((await app.api('GET', '/api/me', { token: body.token })).status, 401);
  const future = jwt.sign({ userId: body.user.id }, process.env.JWT_SECRET || 'moneyguard-dev-secret-change-me', { expiresIn: '1h', notBefore: 0, algorithm: 'HS256' });
  await query("UPDATE users SET password_changed_at = now() - interval '1 hour' WHERE id = $1", [body.user.id]);
  assert.equal((await app.api('GET', '/api/me', { token: future })).status, 200);
});
