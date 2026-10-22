// A disposable PostgreSQL for tests and load runs. Set TEST_DATABASE_URL to use an existing one instead.
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// Returns { url, stop }.
export async function startTestDatabase() {
  if (process.env.TEST_DATABASE_URL) return { url: process.env.TEST_DATABASE_URL, stop: async () => {} };

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'moneyguard-pg-'));
  // Windows would otherwise create the cluster in the system code page (WIN1252), which cannot store most non-Latin text.
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'test', port,
    persistent: true, // the library's own delete-on-stop has no retries and crashes on Windows; we delete below
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {}, // Postgres's startup chatter would drown the output
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('moneyguard_test');

  return {
    url: `postgresql://postgres:test@localhost:${port}/moneyguard_test`,
    async stop() {
      await pg.stop();
      try {
        // Windows keeps Postgres's files locked for a moment after it stops, so retry before giving up.
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch (err) {
        console.warn(`Could not remove ${dataDir}: ${err.code}. Safe to delete by hand.`); // never turns a passing run red
      }
    },
  };
}
