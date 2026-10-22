import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { startApp, registerUser } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

const register = (body) => app.api('POST', '/api/auth/register', { body });

test('register: returns a token and a user without the password hash; email is trimmed and lowercased', async () => {
  const email = `${randomUUID()}@Test.dev`;
  const res = await register({ email: `  ${email}  `, password: 'password123', phone: '+91 98765 43210' });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, email.toLowerCase());
  assert.equal(res.body.user.balance, 0);
  assert.equal('passwordHash' in res.body.user, false);
});

test('register: same email twice is a 409, regardless of letter case', async () => {
  const { email } = await registerUser(app.api);
  const res = await register({ email: email.toUpperCase(), password: 'password123' });
  assert.equal(res.status, 409);
});

test('register: simultaneous sign-ups with one email create exactly one account', async () => {
  const email = `${randomUUID()}@test.dev`;
  const results = await Promise.all(Array.from({ length: 4 }, () => register({ email, password: 'password123' })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409]);
});

test('register: bad input is a 400 with per-field details, never a 500', async () => {
  const cases = [
    [{ email: 123, password: 'password123' }, 'email'],
    [{ email: 'not-an-email', password: 'password123' }, 'email'],
    [{ email: 'a@test.dev', password: 'short' }, 'password'],
    [{ email: 'a@test.dev', password: 'x'.repeat(73) }, 'password'],
    [{ email: 'a@test.dev' }, 'password'],
    [{ email: 'a@test.dev', password: 'password123', phone: 'abc' }, 'phone'],
  ];
  for (const [body, field] of cases) {
    const res = await register(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.details.some((d) => d.field === field), `expected an error on "${field}"`);
  }
});

test('login: correct password works (any email casing); wrong password and unknown email look identical', async () => {
  const { email } = await registerUser(app.api);

  const ok = await app.api('POST', '/api/auth/login', { body: { email: email.toUpperCase(), password: 'password123' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);

  const wrong = await app.api('POST', '/api/auth/login', { body: { email, password: 'wrong-password' } });
  const unknown = await app.api('POST', '/api/auth/login', { body: { email: 'nobody@test.dev', password: 'password123' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('login: missing or non-string fields are a 400', async () => {
  assert.equal((await app.api('POST', '/api/auth/login', { body: {} })).status, 400);
  assert.equal((await app.api('POST', '/api/auth/login', { body: { email: 'a@test.dev', password: 42 } })).status, 400);
});

test('protected routes: no token, garbage token, wrong secret and alg:none are all rejected', async () => {
  const { user } = await registerUser(app.api);
  const forged = jwt.sign({ userId: user.id }, 'some-other-secret', { expiresIn: '1h' });
  const secret = process.env.JWT_SECRET || 'moneyguard-dev-secret-change-me';
  const expired = jwt.sign({ userId: user.id }, secret, { expiresIn: -10 });
  const otherAlgorithm = jwt.sign({ userId: user.id }, secret, { algorithm: 'HS512' }); // right secret, algorithm not pinned by us
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const algNone = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ userId: user.id })}.`;

  for (const token of [undefined, 'garbage', forged, expired, otherAlgorithm, algNone]) {
    const res = await app.api('GET', '/api/me', { token });
    assert.equal(res.status, 401, `token: ${token}`);
  }
});

test('a valid token for a deleted account is rejected', async () => {
  const { token, user } = await registerUser(app.api);
  const { query } = await import('../src/utils/db.js');
  await query('DELETE FROM users WHERE id = $1', [user.id]);
  assert.equal((await app.api('GET', '/api/me', { token })).status, 401);
});
