// Contract checks for expense editing, analytics and alerts (a separate file so it has its own rate-limit budget).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { startApp, registerUser } from './helpers.js';

const SPEC_FILE = path.join(import.meta.dirname, '../src/docs/openapi.yaml');
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

let app;
let spec;
before(async () => {
  app = await startApp();
  spec = await SwaggerParser.dereference(SPEC_FILE);
});
after(() => app.stop());

// Asserts the response status is documented and its JSON body matches the documented schema.
function assertContract(res, specPath, method) {
  const documented = spec.paths[specPath]?.[method]?.responses?.[res.status];
  assert.ok(documented, `${method.toUpperCase()} ${specPath} returned ${res.status}, which is not documented`);
  const schema = documented.content?.['application/json']?.schema;
  if (!schema) return;
  const validate = ajv.compile(schema);
  assert.ok(validate(res.body), `${method.toUpperCase()} ${specPath} ${res.status} body does not match the spec:\n${ajv.errorsText(validate.errors)}\n${JSON.stringify(res.body)}`);
}

test('contract: account deletion', async () => {
  const fresh = await registerUser(app.api);
  const call = (method, p, body) => app.api(method, p, { token: fresh.token, body });
  assertContract(await call('GET', '/api/me'), '/api/me', 'get'); // active: status "active", null dates
  assertContract(await call('DELETE', '/api/me', { currentPassword: 'wrong-password' }), '/api/me', 'delete'); // 400
  assertContract(await call('DELETE', '/api/me', {}), '/api/me', 'delete'); // 400
  const pending = await call('DELETE', '/api/me', { currentPassword: 'password123' });
  assertContract(pending, '/api/me', 'delete'); // 202
  assert.equal(pending.status, 202);
  assertContract(await call('GET', '/api/me'), '/api/me', 'get'); // pending_deletion with dates
  assertContract(await call('GET', '/api/dashboard'), '/api/dashboard', 'get'); // accountDeletion filled in
  assertContract(await app.api('POST', '/api/auth/login', { body: { email: fresh.email, password: 'password123' } }), '/api/auth/login', 'post');
  assertContract(await call('POST', '/api/me/cancel-deletion'), '/api/me/cancel-deletion', 'post');
  assertContract(await call('GET', '/api/dashboard'), '/api/dashboard', 'get'); // accountDeletion null again
});

test('contract: forecast', async () => {
  const fresh = await registerUser(app.api);
  const call = (body) => app.api('POST', '/api/forecast', { token: fresh.token, body });
  await app.api('PUT', '/api/balance', { token: fresh.token, body: { balance: 5000 } });
  assertContract(await call(), '/api/forecast', 'post'); // no purchase: purchase is null
  assertContract(await call({ amount: 800, confidence: 0.9 }), '/api/forecast', 'post'); // with a purchase
  assertContract(await call({ amount: 9_000_000 }), '/api/forecast', 'post'); // NotRecommended
  assertContract(await call({ amount: 0 }), '/api/forecast', 'post'); // 400
  assertContract(await app.api('POST', '/api/forecast', { body: {} }), '/api/forecast', 'post'); // 401
});

test('contract: assistant', async () => {
  const { setAiDriver } = await import('../src/services/assistant.js');
  const fresh = await registerUser(app.api);
  const call = (message) => app.api('POST', '/api/assistant', { token: fresh.token, body: { message } });
  const tool = { type: 'tool_use', id: 'c1', name: 'forecast', input: { amount: 100 } };

  delete process.env.ANTHROPIC_API_KEY;
  setAiDriver(null); // back to the real driver, which has no key here
  assertContract(await call('hi'), '/api/assistant', 'post'); // 503
  let round = 0;
  setAiDriver({ async complete() { return round++ === 0 ? { stop_reason: 'tool_use', content: [tool] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'That looks fine.' }] }; } });
  const ok = await call('Can I afford 100?');
  assertContract(ok, '/api/assistant', 'post'); // 200 with facts
  assert.equal(ok.body.facts.length, 1);
  setAiDriver({ async complete() { throw new Error('down'); } });
  assertContract(await call('hi'), '/api/assistant', 'post'); // 502
  assertContract(await call(''), '/api/assistant', 'post'); // 400
});

test('contract: financial profile', async () => {
  const fresh = await registerUser(app.api);
  const call = (method, p, body) => app.api(method, p, { token: fresh.token, body });
  assertContract(await call('GET', '/api/financial-profile'), '/api/financial-profile', 'get'); // defaults, updatedAt null
  assertContract(await call('PUT', '/api/financial-profile', { monthlyIncome: 450000, annualInterestRate: 0.18 }), '/api/financial-profile', 'put');
  assertContract(await call('GET', '/api/financial-profile'), '/api/financial-profile', 'get'); // saved
  assertContract(await call('PUT', '/api/financial-profile', {}), '/api/financial-profile', 'put'); // 400
});

test('contract: expense edit/delete, analytics and alerts', async () => {
  const fresh = await registerUser(app.api);
  const call = (method, p, body) => app.api(method, p, { token: fresh.token, body });
  await call('PUT', '/api/balance', { balance: 1000 });

  const expense = await call('POST', '/api/expenses', { amount: 100, category: 'Food', date: new Date().toISOString() });
  const id = expense.body.id;
  assertContract(await call('PUT', `/api/expenses/${id}`, { amount: 120 }), '/api/expenses/{id}', 'put');
  assertContract(await call('PUT', `/api/expenses/${id}`, {}), '/api/expenses/{id}', 'put'); // 400
  assertContract(await call('PUT', `/api/expenses/${id}`, { amount: 1e9 }), '/api/expenses/{id}', 'put'); // 422
  assertContract(await call('PUT', `/api/expenses/${crypto.randomUUID()}`, { amount: 1 }), '/api/expenses/{id}', 'put'); // 404
  assertContract(await call('GET', '/api/expenses?category=food&limit=5'), '/api/expenses', 'get');
  assertContract(await call('GET', '/api/expenses?limit=0'), '/api/expenses', 'get'); // 400
  assertContract(await call('GET', '/api/analytics/summary'), '/api/analytics/summary', 'get');
  assertContract(await call('GET', '/api/analytics/summary?groupBy=month'), '/api/analytics/summary', 'get');
  assertContract(await call('GET', '/api/analytics/summary?from=2026-02-30'), '/api/analytics/summary', 'get'); // 400

  const rule = await call('PUT', '/api/alert-rules', { type: 'daily_spend_limit', threshold: 50 });
  assertContract(rule, '/api/alert-rules', 'put');
  assertContract(await call('PUT', '/api/alert-rules', { type: 'low_balance' }), '/api/alert-rules', 'put'); // 400
  assertContract(await call('GET', '/api/alert-rules'), '/api/alert-rules', 'get');
  const alerts = await call('GET', '/api/alerts');
  assertContract(alerts, '/api/alerts', 'get');
  assert.ok(alerts.body.alerts.length >= 1, 'the daily limit should have fired');
  assertContract(await call('GET', '/api/alerts?unread=maybe'), '/api/alerts', 'get'); // 400
  assertContract(await call('POST', `/api/alerts/${alerts.body.alerts[0].id}/read`), '/api/alerts/{id}/read', 'post');
  assertContract(await call('POST', `/api/alerts/${crypto.randomUUID()}/read`), '/api/alerts/{id}/read', 'post'); // 404
  assertContract(await call('POST', '/api/alerts/read-all'), '/api/alerts/read-all', 'post');
  assertContract(await call('DELETE', `/api/alert-rules/${rule.body.id}`), '/api/alert-rules/{id}', 'delete');
  assertContract(await call('DELETE', `/api/alert-rules/${rule.body.id}`), '/api/alert-rules/{id}', 'delete'); // 404
  assertContract(await call('DELETE', `/api/expenses/${id}`), '/api/expenses/{id}', 'delete');
  assertContract(await call('DELETE', `/api/expenses/${id}`), '/api/expenses/{id}', 'delete'); // 404
});

