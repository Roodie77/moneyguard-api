// `npm test`: starts a throwaway Postgres, applies the migrations, runs every *.test.js, cleans up.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { startTestDatabase } from './pg.js';

const db = await startTestDatabase();

// AUTH_LIMIT_MAX: tests create many failed sign-ups; only platform.test.js uses the real limit.
const env = { ...process.env, DATABASE_URL: db.url, LOG_LEVEL: 'error', NODE_ENV: 'test', AUTH_LIMIT_MAX: '1000' };
const files = readdirSync('test').filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f));
let exitCode = 1;

try {
  execFileSync(process.execPath, ['src/db/migrate.js'], { env, stdio: 'inherit' });
  exitCode = spawnSync(process.execPath, ['--test', ...files], { env, stdio: 'inherit' }).status ?? 1;
} finally {
  await db.stop();
}

process.exit(exitCode);
