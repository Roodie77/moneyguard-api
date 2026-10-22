// The real (production) rate limits on the password-reset endpoints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp } from './helpers.js';

process.env.AUTH_LIMIT_MAX = '8'; // the production default; must be set before the app is imported

let app;
before(async () => {
  app = await startApp();
  const { setMailer } = await import('../src/services/mailer.js');
  setMailer(async () => {});
});
after(() => app.stop());

const post = (path, body) => app.api('POST', `/api/auth/${path}`, { body });

test('forgot-password: the 9th request from one IP in a window gets 429', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await post('forgot-password', { email: `${randomUUID()}@test.dev` })).status, 200);
  const blocked = await post('forgot-password', { email: `${randomUUID()}@test.dev` });
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /Too many attempts/);
});



test('reset-password: wrong tokens count against the failed-attempt limit, so tokens cannot be guessed', async () => {
  const statuses = [];
  for (let i = 0; i < 9; i++) statuses.push((await post('reset-password', { token: randomUUID(), password: 'brand-new-pass' })).status);
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 400, 400, 400, 429]);
});
