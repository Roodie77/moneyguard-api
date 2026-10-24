// Wrong passwords on the account-editing endpoints count towards the real login limit (8 failures per 15 minutes).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp } from './helpers.js';

process.env.AUTH_LIMIT_MAX = '8'; // the production default; must be set before the app is imported

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

test('guessing the current password is limited: the 9th wrong try in a window is a 429', async () => {
  const reg = await app.api('POST', '/api/auth/register', { body: { email: `${randomUUID()}@test.dev`, password: 'password123' } });
  assert.equal(reg.status, 201); // a successful sign-up does not count
  const attempt = () => app.api('PUT', '/api/me/password', { token: reg.body.token, body: { currentPassword: 'wrong-guess', newPassword: 'brand-new-pass' } });
  for (let i = 0; i < 8; i++) assert.equal((await attempt()).status, 400);
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /Too many attempts/);
  // the email-change route shares the same limit, so switching endpoints does not give more guesses
  const other = await app.api('PUT', '/api/me', { token: reg.body.token, body: { email: `${randomUUID()}@test.dev`, currentPassword: 'wrong-guess' } });
  assert.equal(other.status, 429);
});
