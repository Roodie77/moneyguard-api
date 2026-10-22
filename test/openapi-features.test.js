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

