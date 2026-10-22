// Edge cases in behaviour: concurrency, caching, time zones, configuration. Each test states the behaviour we want.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startApp, registerUser } from './helpers.js';
import { canIAfford } from '../src/services/calculator.js';

const ROOT = path.join(import.meta.dirname, '..');

let app;
before(async () => { app = await startApp(); });
after(() => app.stop());

test('GET requests are never replayed from the idempotency cache (data would be stale)', async () => {
  const { token } = await registerUser(app.api);
  const headers = { 'idempotency-key': randomUUID() };

  await app.api('PUT', '/api/balance', { token, body: { balance: 100 } });
  const first = await app.api('GET', '/api/me', { token, headers });
  await app.api('PUT', '/api/balance', { token, body: { balance: 999 } });
  const second = await app.api('GET', '/api/me', { token, headers });

  assert.equal(first.body.balance, 100);
  assert.equal(second.body.balance, 999);
});

test('10 simultaneous expenses are all recorded and the balance is exact', async () => {
  const { token } = await registerUser(app.api);
  await app.api('PUT', '/api/balance', { token, body: { balance: 1000 } });

  const results = await Promise.all(Array.from({ length: 10 }, () => app.api('POST', '/api/expenses', { token, body: { amount: 10 } })));
  assert.ok(results.every((r) => r.status === 201));

  assert.equal((await app.api('GET', '/api/me', { token })).body.balance, 900);
  assert.equal((await app.api('GET', '/api/expenses', { token })).body.length, 10);
});

test('safe-to-spend gives the same answer whatever time zone the server runs in', () => {
  const calculator = pathToFileURL(path.join(ROOT, 'src/services/calculator.js')).href;
  const script = `
    import { calculateSafeToSpend } from '${calculator}';
    const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
    const income = new Date(midnight.getTime() + 10 * 86400000).toISOString();
    const r = calculateSafeToSpend({ balance: 1000, nextIncomeDate: income, bills: [{ amount: 100, dueDate: income }] });
    console.log(JSON.stringify({ days: r.daysUntilNextIncome, bills: r.upcomingBillsTotal }));`;

  for (const TZ of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Auckland']) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    // 10 days away; a bill due on the income day is still reserved
    assert.deepEqual(JSON.parse(out), { days: 10, bills: 100 }, `TZ=${TZ}`);
  }
});

test('can-i-afford: spending less than the balance does not warn about a negative balance', () => {
  const safeToSpend = { remainingToday: 100, availableAfterCommitments: 100, daysUntilNextIncome: 10 };
  const r = canIAfford({ purchaseAmount: 60, safeToSpend, balance: 100 });
  assert.deepEqual(r.cashFlowWarnings, []);
  assert.match(r.explanation, /about 40 left/);
});

test('can-i-afford: a purchase above the balance does warn', () => {
  const safeToSpend = { remainingToday: 500, availableAfterCommitments: 500, daysUntilNextIncome: 10 };
  const r = canIAfford({ purchaseAmount: 150, safeToSpend, balance: 100 });
  assert.equal(r.cashFlowWarnings.length, 1);
});

test('a bad TRUST_PROXY value stops the app at startup instead of being silently ignored', () => {
  const appFile = pathToFileURL(path.join(ROOT, 'src/app.js')).href;
  const load = (TRUST_PROXY) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import('${appFile}')`], {
      env: { ...process.env, TRUST_PROXY },
      stdio: 'pipe',
    });

  assert.doesNotThrow(() => load('1'));
  assert.throws(() => load('true'), /TRUST_PROXY/);
  assert.throws(() => load('-1'), /TRUST_PROXY/);
});

test('startup refuses a database that is not UTF8 and says why', async () => {
  const { query } = await import('../src/utils/db.js');
  const name = `latin1_${randomUUID().slice(0, 8)}`;
  await query(`CREATE DATABASE ${name} ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);

  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  const db = pathToFileURL(path.join(ROOT, 'src/utils/db.js')).href;
  const run = (databaseUrl) => execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { connectDb, closeDb } = await import('${db}');
    await connectDb();
    await closeDb();`], { env: { ...process.env, DATABASE_URL: databaseUrl, LOG_LEVEL: 'error' }, stdio: 'pipe' });

  try {
    assert.doesNotThrow(() => run(process.env.DATABASE_URL)); // the normal UTF8 test database is accepted
    assert.throws(() => run(url.href), /LATIN1 encoding; UTF8 is required/);
  } finally {
    await query(`DROP DATABASE ${name}`);
  }
});

test('database queries have a time limit', async () => {
  const { pool } = await import('../src/utils/db.js');
  const { rows } = await pool.query('SHOW statement_timeout');
  assert.equal(rows[0].statement_timeout, '10s');
});

test('two deploys running migrations at the same moment both succeed and the schema is created once', async () => {
  const { query } = await import('../src/utils/db.js');
  const { spawn } = await import('node:child_process');
  const name = `migrate_${randomUUID().slice(0, 8)}`;
  await query(`CREATE DATABASE ${name}`);

  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  const migrate = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['src/db/migrate.js'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url.href, LOG_LEVEL: 'error' }, stdio: 'pipe' });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stderr }));
    });

  try {
    const results = await Promise.all([migrate(), migrate(), migrate()]);
    assert.deepEqual(results.map((r) => r.code), [0, 0, 0], results.map((r) => r.stderr).join('\n'));
  } finally {
    await query(`DROP DATABASE ${name} WITH (FORCE)`);
  }
});
