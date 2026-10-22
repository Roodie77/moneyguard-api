import pg from 'pg';
import logger from './logger.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example)');

// pg returns NUMERIC as a string. Money is capped at 1e12 with 2 decimals, which a JS number holds exactly.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, parseFloat);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  // Max wait for a free connection, including opening a new one. Raise it for a distant database
  // (e.g. a hosted free tier can take 2-8s to accept a secure connection).
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 5000,
  idleTimeoutMillis: 60_000, // keep connections warm: reconnecting to a remote database is slow
  keepAlive: true, // stops proxies and NATs from silently dropping idle connections
  statement_timeout: 10_000, // a runaway query is cancelled instead of holding a connection forever
});

// An idle connection dropped by the server must not crash the process.
pool.on('error', (err) => logger.error(`Idle database client error: ${err.message}`));

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const camelRows = (rows) => rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v])));

// Runs a query and returns the rows with camelCase keys (user_id -> userId), the shape the API exposes.
export async function query(text, params) {
  const { rows } = await pool.query(text, params);
  return camelRows(rows);
}

// Runs fn(tx) on one connection inside BEGIN/COMMIT; any error rolls everything back. tx.query works like query().
// Lock the users row first (SELECT ... FOR UPDATE) when changing a balance, so every code path takes locks in the same order.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({ query: async (text, params) => camelRows((await client.query(text, params)).rows) });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function connectDb() {
  const started = Date.now();
  const [{ name, encoding }] = await query("SELECT current_database() AS name, current_setting('server_encoding') AS encoding");
  // A non-UTF8 database cannot store most non-Latin text (Hindi, Japanese, ...): users would get 500s at random.
  if (encoding !== 'UTF8') throw new Error(`database "${name}" uses ${encoding} encoding; UTF8 is required`);
  logger.info(`Database connected (${name}) in ${Date.now() - started}ms`);
}

export const pingDb = () => pool.query('SELECT 1').then(() => true, () => false);
export const closeDb = () => pool.end();
