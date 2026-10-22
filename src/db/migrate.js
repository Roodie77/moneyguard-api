import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, closeDb } from '../utils/db.js';
import logger from '../utils/logger.js';

// Applies every .sql file in ./migrations that has not run yet, in filename order.
// Each file runs in its own transaction: it is applied completely or not at all.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_ID = 727_274; // any constant; all migration runs must use the same one

const client = await pool.connect();
try {
  // Migrations may legitimately run longer than the 10s limit that protects normal requests.
  await client.query('SET statement_timeout = 0');
  // If several instances deploy at once, the others wait here, then find nothing left to apply.
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const pending = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && !applied.has(f)).sort();

  for (const file of pending) {
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info(`Applied migration ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }

  if (!pending.length) logger.info('Database is up to date');
} catch (err) {
  logger.error(err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await closeDb();
}
