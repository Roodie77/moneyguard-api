// What clients see when the database is saturated or slow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerUser } from './helpers.js';

let app;
let user;
before(async () => {
  app = await startApp();
  user = await registerUser(app.api);
});
after(() => app.stop());

test('when every database connection is busy, clients get 503 + Retry-After (not a 500), and the API recovers', async () => {
  const { pool } = await import('../src/utils/db.js');

  // Occupy all 10 pooled connections for 7s; a request must wait for one and give up after 5s.
  const hogs = Array.from({ length: pool.options.max }, () => pool.query('SELECT pg_sleep(7)'));
  await new Promise((r) => setTimeout(r, 200)); // let them all check out their connections

  const overloaded = await app.api('GET', '/api/me', { token: user.token });
  assert.equal(overloaded.status, 503);
  assert.ok(overloaded.headers.get('retry-after'));
  assert.match(overloaded.body.error, /busy/i);

  await Promise.all(hogs);
  assert.equal((await app.api('GET', '/api/me', { token: user.token })).status, 200); // recovered
});

test('a query cancelled by the statement time limit is a 503, not a 500', async () => {
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { pool } = await import('../src/utils/db.js');

  // A real timeout raised by Postgres (200ms limit, 1s query), inside a transaction so the pool is left untouched.
  const client = await pool.connect();
  let err;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 200');
    err = await client.query('SELECT pg_sleep(1)').catch((e) => e);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal(err.code, '57014');

  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  errorHandler(err, { path: '/x', method: 'GET' }, res, () => {});
  assert.equal(res.code, 503);
  assert.ok(res.headers['Retry-After']);
});
