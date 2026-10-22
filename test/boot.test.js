// The real entry point (src/server.js): boots, connects to the database, serves requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function waitFor(fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { return await fn(); } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

test('server.js starts, reports a healthy database, and serves the API docs', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), LOG_LEVEL: 'error' }, stdio: 'pipe' });
  try {
    const health = await waitFor(async () => (await fetch(`http://localhost:${port}/health`)).json());
    assert.equal(health.status, 'ok');
    assert.equal(health.database, 'connected');
    assert.equal((await fetch(`http://localhost:${port}/openapi.yaml`)).status, 200);
  } finally {
    child.kill();
  }
});

test('server.js exits with code 1 when the database is unreachable', async () => {
  const port = await freePort();
  const deadDb = `postgresql://postgres:x@localhost:${await freePort()}/none`; // nothing listens there
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATABASE_URL: deadDb, LOG_LEVEL: 'error' }, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 1);
  assert.match(output, /Database connection failed/);
});
