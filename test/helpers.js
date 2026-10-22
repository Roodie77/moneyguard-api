import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import assert from 'node:assert/strict';

// Starts the real app on a random port. Import it lazily so DATABASE_URL (set by run.js) is already in place.
export async function startApp() {
  const { default: app } = await import('../src/app.js');
  const { closeDb } = await import('../src/utils/db.js');
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://localhost:${server.address().port}`;

  // api('POST', '/api/bills', { body, token, headers, rawBody }) -> { status, body, headers }
  async function api(method, path, { body, rawBody, token, headers } = {}) {
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(payload !== undefined && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: payload,
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  }

  async function stop() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
  }

  return { api, base, stop };
}

// Registers a brand-new user (random email, so tests never collide) and returns their token.
export async function registerUser(api, overrides = {}) {
  const email = `${randomUUID()}@test.dev`;
  const res = await api('POST', '/api/auth/register', { body: { email, password: 'password123', ...overrides } });
  assert.equal(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, user: res.body.user, email };
}
