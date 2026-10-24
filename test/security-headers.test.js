// Helmet's security headers and the CORS allow-list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

const PLACEHOLDER = 'https://frontend-placeholder.example.com';
const get = (path, headers = {}) => app.api('GET', path, { headers });

test('every response carries the security headers, and none reveals the framework', async () => {
  for (const path of ['/health', '/api/me', '/nope']) {
    const { headers } = await get(path);
    assert.equal(headers.get('x-content-type-options'), 'nosniff', path);
    assert.match(headers.get('strict-transport-security'), /max-age=\d+/, path);
    assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN', path);
    assert.ok(headers.get('referrer-policy'), path);
    assert.match(headers.get('content-security-policy'), /default-src 'self'/, path);
    assert.equal(headers.get('x-powered-by'), null, path);
  }
});

test('uploaded files can be embedded by other websites (cross-origin resource policy)', async () => {
  assert.equal((await get('/health')).headers.get('cross-origin-resource-policy'), 'cross-origin');
});

test('the /docs page keeps working: its policy allows the Swagger UI CDN, and the rest of the API stays strict', async () => {
  const res = await fetch(`${app.base}/docs`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(await res.text(), /SwaggerUIBundle/);
  const api = (await get('/health')).headers.get('content-security-policy');
  assert.ok(!api.includes('cdn.jsdelivr.net'), 'the relaxed policy must not apply to the API');
});

test('CORS: a request with no Origin (mobile app, Postman, curl) is never affected', async () => {
  const res = await get('/health'); // /health is answered before the CORS middleware, so it has no CORS headers at all
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('CORS: until CORS_ORIGINS is set only the placeholder website is allowed', async () => {
  delete process.env.CORS_ORIGINS;
  const allowed = await get('/api/me', { origin: PLACEHOLDER });
  assert.equal(allowed.headers.get('access-control-allow-origin'), PLACEHOLDER);
  const blocked = await get('/api/me', { origin: 'https://evil.example.org' });
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
});

test('CORS: CORS_ORIGINS replaces the placeholder; several origins, spaces and a trailing comma are fine', async () => {
  process.env.CORS_ORIGINS = ' https://app.example.com , https://admin.example.com, ';
  try {
    for (const origin of ['https://app.example.com', 'https://admin.example.com']) {
      assert.equal((await get('/api/me', { origin })).headers.get('access-control-allow-origin'), origin);
    }
    assert.equal((await get('/api/me', { origin: PLACEHOLDER })).headers.get('access-control-allow-origin'), null);
    assert.equal((await get('/api/me', { origin: 'https://app.example.com.evil.org' })).headers.get('access-control-allow-origin'), null);
  } finally {
    delete process.env.CORS_ORIGINS;
  }
});

test('CORS: a preflight from an allowed website is answered and cached for 10 minutes; from another website it is not allowed', async () => {
  process.env.CORS_ORIGINS = 'https://app.example.com';
  try {
    const ok = await app.api('OPTIONS', '/api/expenses', {
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example.com');
    assert.equal(ok.headers.get('access-control-max-age'), '600');

    const no = await app.api('OPTIONS', '/api/expenses', {
      headers: { origin: 'https://evil.example.org', 'access-control-request-method': 'POST' },
    });
    assert.equal(no.headers.get('access-control-allow-origin'), null);
  } finally {
    delete process.env.CORS_ORIGINS;
  }
});
