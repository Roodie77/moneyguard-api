import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

test('simultaneous expenses can never overspend: 10 x 30 against a balance of 100 lets exactly 3 through', async () => {
  const fresh = await registerUser(app.api);
  await app.api('PUT', '/api/balance', { token: fresh.token, body: { balance: 100 } });
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    app.api('POST', '/api/expenses', { token: fresh.token, body: { amount: 30 } })));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.equal(results.filter((r) => r.status === 422).length, 7);
  assert.equal((await app.api('GET', '/api/me', { token: fresh.token })).body.balance, 10);
  assert.equal((await app.api('GET', '/api/expenses', { token: fresh.token })).body.length, 3);
});
