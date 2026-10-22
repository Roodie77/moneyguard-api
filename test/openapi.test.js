// Keeps src/docs/openapi.yaml honest: the frontend team builds against it, so it must match the code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { startApp, registerUser } from './helpers.js';

const SPEC_FILE = path.join(import.meta.dirname, '../src/docs/openapi.yaml');
const UPLOAD_DIR = path.join(import.meta.dirname, '../src/uploads');
const METHODS = ['get', 'put', 'post', 'delete'];

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

let app;
let spec;
let user;
const uploaded = [];

before(async () => {
  app = await startApp();
  spec = await SwaggerParser.dereference(SPEC_FILE); // $refs resolved, so schemas can be used directly
  user = await registerUser(app.api);
});
after(async () => {
  for (const name of uploaded) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
  await app.stop();
});

// Asserts the response status is documented and its JSON body matches the documented schema.
function assertContract(res, specPath, method) {
  const documented = spec.paths[specPath]?.[method]?.responses?.[res.status];
  assert.ok(documented, `${method.toUpperCase()} ${specPath} returned ${res.status}, which is not documented`);
  const schema = documented.content?.['application/json']?.schema;
  if (!schema) return;
  const validate = ajv.compile(schema);
  assert.ok(validate(res.body), `${method.toUpperCase()} ${specPath} ${res.status} body does not match the spec:\n${ajv.errorsText(validate.errors)}\n${JSON.stringify(res.body)}`);
}

test('the spec is valid OpenAPI 3', async () => {
  await SwaggerParser.validate(SPEC_FILE);
});

test('every route in the code is documented, and every documented route exists', async () => {
  const { default: apiRouter } = await import('../src/routes/api.js');
  const { default: authRouter } = await import('../src/routes/auth.js');

  const routesOf = (router, prefix) =>
    router.stack
      .flatMap((layer) => {
        if (layer.route) return Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${prefix}${layer.route.path}`);
        if (layer.name === 'router') return routesOf(layer.handle, prefix); // a sub-router mounted without a path
        return [];
      })
      .map((r) => r.replace(/:(\w+)/g, '{$1}'));

  const inCode = new Set([...routesOf(apiRouter, '/api'), ...routesOf(authRouter, '/api/auth'), 'GET /health']);
  const inSpec = new Set(
    Object.entries(spec.paths).flatMap(([p, ops]) => METHODS.filter((m) => ops[m]).map((m) => `${m.toUpperCase()} ${p}`)),
  );
  inSpec.delete('GET /uploads/{filename}'); // served by express.static, not a router

  assert.deepEqual([...inCode].filter((r) => !inSpec.has(r)), [], 'routes missing from openapi.yaml');
  assert.deepEqual([...inSpec].filter((r) => !inCode.has(r)), [], 'openapi.yaml documents routes that do not exist');
});

test('contract: /health, auth and error responses', async () => {
  assertContract(await app.api('GET', '/health'), '/health', 'get');

  const email = `${crypto.randomUUID()}@test.dev`;
  const body = { email, password: 'password123' };
  assertContract(await app.api('POST', '/api/auth/register', { body }), '/api/auth/register', 'post');
  assertContract(await app.api('POST', '/api/auth/register', { body }), '/api/auth/register', 'post'); // 409
  assertContract(await app.api('POST', '/api/auth/register', { body: { email: 'bad' } }), '/api/auth/register', 'post'); // 400
  assertContract(await app.api('POST', '/api/auth/login', { body }), '/api/auth/login', 'post');
  assertContract(await app.api('POST', '/api/auth/login', { body: { email, password: 'wrong-password' } }), '/api/auth/login', 'post'); // 401
  assertContract(await app.api('GET', '/api/me'), '/api/me', 'get'); // 401
});

test('contract: refresh, logout and password reset', async () => {
  const { setMailer } = await import('../src/services/mailer.js');
  let resetToken;
  setMailer(async ({ token }) => { resetToken = token; });
  const post = (p, body) => app.api('POST', `/api/auth/${p}`, { body });

  const { email } = await registerUser(app.api);
  const { refreshToken } = (await post('login', { email, password: 'password123' })).body;
  const refreshed = await post('refresh', { refreshToken });
  assertContract(refreshed, '/api/auth/refresh', 'post');
  assertContract(await post('refresh', { refreshToken }), '/api/auth/refresh', 'post'); // 401
  assertContract(await post('refresh', {}), '/api/auth/refresh', 'post'); // 400
  assertContract(await post('logout', { refreshToken: refreshed.body.refreshToken }), '/api/auth/logout', 'post');
  assertContract(await post('logout', {}), '/api/auth/logout', 'post'); // 400

  assertContract(await post('forgot-password', { email }), '/api/auth/forgot-password', 'post');
  assertContract(await post('forgot-password', { email: 'bad' }), '/api/auth/forgot-password', 'post'); // 400
  for (let i = 0; i < 100 && !resetToken; i++) await new Promise((r) => setTimeout(r, 10));
  assertContract(await post('reset-password', { token: 'nope', password: 'brand-new-pass' }), '/api/auth/reset-password', 'post'); // 400
  assertContract(await post('reset-password', { token: resetToken, password: 'brand-new-pass' }), '/api/auth/reset-password', 'post');
});

test('contract: profile, bills and expenses', async () => {
  const { token } = user;
  const call = (method, p, body) => app.api(method, p, { token, body });

  assertContract(await call('GET', '/api/me'), '/api/me', 'get');
  assertContract(await call('PUT', '/api/balance', { balance: 1000 }), '/api/balance', 'put');
  assertContract(await call('PUT', '/api/balance', { balance: -1 }), '/api/balance', 'put'); // 400
  assertContract(await call('PUT', '/api/next-income', { amount: 500, date: '2026-12-01' }), '/api/next-income', 'put');
  assertContract(await call('PUT', '/api/next-income', { amount: 500 }), '/api/next-income', 'put'); // null date
  assertContract(await call('PUT', '/api/savings-goal', { amount: 200 }), '/api/savings-goal', 'put');

  const bill = await call('POST', '/api/bills', { name: 'Rent', amount: 250.75, dueDate: '2026-11-01' });
  assertContract(bill, '/api/bills', 'post');
  assertContract(await call('POST', '/api/bills', { name: 'Gym', amount: 20 }), '/api/bills', 'post'); // null dueDate
  assertContract(await call('GET', '/api/bills'), '/api/bills', 'get');
  assertContract(await call('DELETE', `/api/bills/${bill.body.id}`), '/api/bills/{id}', 'delete');
  assertContract(await call('DELETE', `/api/bills/${bill.body.id}`), '/api/bills/{id}', 'delete'); // 404

  assertContract(await call('POST', '/api/expenses', { amount: 12.5, category: 'Food' }), '/api/expenses', 'post');
  assertContract(await call('POST', '/api/expenses', { amount: 0 }), '/api/expenses', 'post'); // 400
  assertContract(await call('POST', '/api/expenses', { amount: 1e9 }), '/api/expenses', 'post'); // 422
  assertContract(await call('GET', '/api/expenses'), '/api/expenses', 'get');
});

test('contract: dashboard and calculators', async () => {
  const call = (p, body) => app.api('POST', p, { token: user.token, body });

  assertContract(await app.api('GET', '/api/dashboard', { token: user.token }), '/api/dashboard', 'get');
  assertContract(await call('/api/can-i-afford', { amount: 30 }), '/api/can-i-afford', 'post');

  const ok = { monthlyIncome: 450000, ordinaryExpenses: 180000, existingEMI: 35000, proposedEMI: 50000 };
  assertContract(await call('/api/projected-balance', ok), '/api/projected-balance', 'post');
  assertContract(await call('/api/projected-balance', { monthlyIncome: 100, proposedEMI: 500 }), '/api/projected-balance', 'post'); // warning set
  assertContract(await call('/api/projected-balance', {}), '/api/projected-balance', 'post'); // 400

  assertContract(await call('/api/cash-flow', { monthlyGrossIncome: 1000, months: 3 }), '/api/cash-flow', 'post');
  assertContract(await call('/api/affordability', { monthlyGrossIncome: 10000, annualInterestRate: 0.12 }), '/api/affordability', 'post');
});

test('contract: file upload and listing', async () => {
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'a.pdf');
  const res = await fetch(`${app.base}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${user.token}` }, body: form });
  const body = await res.json();
  uploaded.push(body.filename);
  assertContract({ status: res.status, body }, '/api/files', 'post');
  assertContract(await app.api('GET', '/api/files', { token: user.token }), '/api/files', 'get');
});

test('docs are served: /openapi.yaml and the /docs page', async () => {
  const yaml = await fetch(`${app.base}/openapi.yaml`);
  assert.equal(yaml.status, 200);
  assert.match(await yaml.text(), /^openapi: 3\.0\.3/);

  const page = await fetch(`${app.base}/docs`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SwaggerUIBundle/);
});
