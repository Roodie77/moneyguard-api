// Guessing the password on the delete endpoint is limited like login: 8 failures per 15 minutes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

process.env.AUTH_LIMIT_MAX = '8'; // the production default; must be set before the app is imported

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

test('the 9th wrong password in a window is a 429, and the account is still active', async () => {
  const u = await registerUser(app.api);
  const attempt = () => app.api('DELETE', '/api/me', { token: u.token, body: { currentPassword: 'wrong-guess' } });
  for (let i = 0; i < 8; i++) assert.equal((await attempt()).status, 400);
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /Too many attempts/);
  assert.equal((await app.api('GET', '/api/me', { token: u.token })).body.accountStatus, 'active');
});
