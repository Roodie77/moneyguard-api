// `npm run load`: hammers the REAL server process (src/server.js, NODE_ENV=production) over real HTTP.
// Clients carry their own X-Forwarded-For, the way traffic arrives from a gateway / load balancer.
// While each scenario runs, /health is probed every 100ms: if the server stays responsive, the probe stays fast.
//
// DURATION=10 CONNECTIONS_SCALE=1 ONLY=dashboard npm run load      (numbers are indicative: the test database,
// the server and the load generator all share this one machine)
import { execFileSync, fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import autocannon from 'autocannon';
import { freePort, startTestDatabase } from '../test/pg.js';

const ROOT = path.join(import.meta.dirname, '..');
const DURATION = Number(process.env.DURATION) || 10;
const SCALE = Number(process.env.CONNECTIONS_SCALE) || 1;
const USERS = 20;

const db = await startTestDatabase();
const port = await freePort();
const base = `http://localhost:${port}`;
const cwd = mkdtempSync(path.join(tmpdir(), 'moneyguard-load-')); // the server writes its logs/ folder here
const env = {
  ...process.env, DATABASE_URL: db.url, PORT: String(port), NODE_ENV: 'production', TRUST_PROXY: '1',
  JWT_SECRET: 'load-test-secret-load-test-secret-load-test', LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

execFileSync(process.execPath, [path.join(ROOT, 'src/db/migrate.js')], { env, stdio: 'ignore' });
const server = fork(path.join(ROOT, 'load/server.js'), { env, cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
server.stdout.resume(); // drain like a container runtime would
server.stderr.resume();
let stats = [];
server.on('message', (m) => stats.push(m));
server.on('exit', (code) => { if (!done) console.error(`\nSERVER PROCESS DIED (exit ${code})`); });
let done = false;

const octet = () => 1 + Math.floor(Math.random() * 254);
const randomIp = () => `10.${octet()}.${octet()}.${octet()}`;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const json = { 'content-type': 'application/json' };
const call = (method, p, { body, token, ip = randomIp() } = {}) =>
  fetch(base + p, { method, headers: { ...json, 'x-forwarded-for': ip, ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });

async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become healthy');
}

// Pre-register the users the scenarios will act as.
async function createUsers() {
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const email = `load${i}-${Date.now()}@test.dev`;
    const res = await (await call('POST', '/api/auth/register', { body: { email, password: 'password123' } })).json();
    await call('PUT', '/api/balance', { token: res.token, body: { balance: 1e9 } });
    await call('PUT', '/api/next-income', { token: res.token, body: { amount: 1000, date: '2030-01-01' } });
    users.push({ email, token: res.token });
  }
  return users;
}

// Probes /health every 100ms while a load scenario runs.
function startProbe() {
  const times = [];
  let failed = 0;
  const timer = setInterval(async () => {
    const t = performance.now();
    try { (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })).ok ? times.push(performance.now() - t) : failed++; } catch { failed++; }
  }, 100);
  return () => {
    clearInterval(timer);
    times.sort((a, b) => a - b);
    return { p99: times[Math.floor(times.length * 0.99)] ?? NaN, max: times.at(-1) ?? NaN, failed };
  };
}

const results = [];
async function scenario(name, connections, options) {
  if (process.env.ONLY && !name.toLowerCase().includes(process.env.ONLY.toLowerCase())) return;
  console.log(`\n> ${name} (${connections * SCALE} connections)`);
  stats = [];
  const stopProbe = startProbe();
  const run = { url: base, connections: Math.round(connections * SCALE), timeout: 30, ...(options.amount ? {} : { duration: DURATION }), ...options };
  const r = await autocannon(run);
  const probe = stopProbe();
  const codes = Object.entries(r.statusCodeStats).map(([c, v]) => `${c}:${v.count}`).join(' ');
  const row = {
    scenario: name,
    'req/s': Math.round(r.requests.average),
    'p50 ms': r.latency.p50,
    'p99 ms': r.latency.p99,
    statuses: codes || '-',
    'errors': r.errors,
    'health p99 ms': Math.round(probe.p99),
    'health max ms': Math.round(probe.max),
    'health failed': probe.failed,
    'rss MB': Math.round(Math.max(0, ...stats.map((s) => s.rss)) / 1048576),
    'loop lag p99 ms': Math.round(Math.max(0, ...stats.map((s) => s.lagP99))),
  };
  results.push(row);
  console.table([row]);
}

try {
  await waitHealthy();
  const users = await createUsers();
  const baseline = stats.at(-1);
  const authed = (p, extra = {}) => ({ method: 'GET', path: p, setupRequest: (req) => { req.headers = { ...json, 'x-forwarded-for': randomIp(), authorization: `Bearer ${pick(users).token}` }; return req; }, ...extra });

  await scenario('health flood', 1000, { requests: [{ method: 'GET', path: '/health' }] });
  await scenario('dashboard, many clients', 500, { requests: [authed('/api/dashboard')] });
  await scenario('expenses, unique idempotency keys', 300, {
    requests: [{
      method: 'POST', path: '/api/expenses',
      setupRequest: (req) => {
        req.headers = { ...json, 'x-forwarded-for': randomIp(), authorization: `Bearer ${pick(users).token}`, 'idempotency-key': crypto.randomUUID() };
        req.body = JSON.stringify({ amount: 1, category: 'Load', description: 'x'.repeat(100) });
        return req;
      },
    }],
  });
  await scenario('OVERLOAD: 3000 connections', 3000, { requests: [authed('/api/dashboard')] });
  await scenario('login storm (bcrypt)', 100, {
    requests: [{
      method: 'POST', path: '/api/auth/login',
      setupRequest: (req) => {
        req.headers = { ...json, 'x-forwarded-for': randomIp() };
        req.body = JSON.stringify({ email: pick(users).email, password: 'password123' });
        return req;
      },
    }],
  });
  await scenario('ONE abusive IP, 20,000 requests', 500, {
    amount: 20_000,
    requests: [{ method: 'GET', path: '/api/dashboard', headers: { ...json, 'x-forwarded-for': '203.0.113.7', authorization: `Bearer ${users[0].token}` } }],
  });

  const final = await fetch(`${base}/health`);
  console.log(`\nAfter all scenarios: /health -> ${final.status} ${JSON.stringify(await final.json())}`);
  console.log(`Server memory at start: ${Math.round((baseline?.rss ?? 0) / 1048576)} MB`);
} finally {
  done = true;
  server.kill();
  await db.stop();
  try { rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch { /* temp logs, harmless */ }
}
