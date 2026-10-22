// Which thresholds and fields are accepted for each alert rule type.
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

const put = (body) => app.api('PUT', '/api/alert-rules', { token: user.token, body });

test('thresholds that do not fit the type, and missing or extra fields, are a 400 naming the field', async () => {
  const bad = [
    [{}, 'type'],
    [{ type: 'weekly_limit', threshold: 5 }, 'type'],
    [{ type: 'low_balance' }, 'threshold'],
    [{ type: 'low_balance', threshold: 0 }, 'threshold'],
    [{ type: 'low_balance', threshold: -5 }, 'threshold'],
    [{ type: 'low_balance', threshold: 'lots' }, 'threshold'],
    [{ type: 'daily_spend_limit', threshold: 1e13 }, 'threshold'],
    [{ type: 'bill_due_soon', threshold: 0 }, 'threshold'],
    [{ type: 'bill_due_soon', threshold: 61 }, 'threshold'],
    [{ type: 'bill_due_soon', threshold: 2.5 }, 'threshold'],
    [{ type: 'over_safe_to_spend', threshold: 10 }, 'threshold'],
    [{ type: 'category_monthly_budget', threshold: 100 }, 'category'],
    [{ type: 'category_monthly_budget', threshold: 100, category: '' }, 'category'],
    [{ type: 'daily_spend_limit', threshold: 100, category: 'Food' }, 'category'],
    [{ type: 'low_balance', threshold: 100, enabled: 'yes please' }, 'enabled'],
  ];
  for (const [body, field] of bad) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.details.some((d) => d.field === field), `${JSON.stringify(body)}: expected an error on "${field}"`);
  }
});
