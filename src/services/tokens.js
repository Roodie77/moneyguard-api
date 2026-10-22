import crypto from 'crypto';
import { query } from '../utils/db.js';

export const REFRESH_TOKEN_DAYS = Number(process.env.REFRESH_TOKEN_DAYS) || 7;
export const RESET_TOKEN_MINUTES = 60;

// Tokens are 256 random bits, so a fast hash is enough: only the hash is stored.
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Starts a new refresh-token family (login, register) or continues one (refresh). Returns the raw token.
export async function issueRefreshToken(userId, familyId = crypto.randomUUID()) {
  const token = newToken();
  await query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, familyId, hash(token), REFRESH_TOKEN_DAYS],
  );
  return token;
}

// Trades a refresh token for the user and family it belonged to, marking it used in the same statement so
// two simultaneous requests cannot both succeed. Returns null for an unknown, expired or already used token;
// a token that was already used revokes its whole family (it was probably stolen).
export async function consumeRefreshToken(token) {
  const [row] = await query(
    `UPDATE refresh_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id, family_id`,
    [hash(token)],
  );
  if (row) return row;
  await query(
    `DELETE FROM refresh_tokens WHERE family_id IN (
       SELECT family_id FROM refresh_tokens WHERE token_hash = $1 AND used_at IS NOT NULL)`,
    [hash(token)],
  );
  return null;
}

export async function revokeRefreshFamily(token) {
  await query(
    'DELETE FROM refresh_tokens WHERE family_id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)',
    [hash(token)],
  );
}

// Replaces any earlier unused reset link, so only the latest one works.
export async function issueResetToken(userId) {
  const token = newToken();
  await query(
    `WITH cleared AS (DELETE FROM password_reset_tokens WHERE user_id = $1)
     INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [userId, hash(token), RESET_TOKEN_MINUTES],
  );
  return token;
}

// One statement: the token is spent, the password changed and every session ended together or not at all.
// Returns false for an unknown, expired or already used token.
export async function resetPassword(token, passwordHash) {
  const rows = await query(
    `WITH spent AS (
       UPDATE password_reset_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id
     ), changed AS (
       UPDATE users SET password_hash = $2, password_changed_at = now()
       WHERE id IN (SELECT user_id FROM spent) RETURNING id
     ), signed_out AS (
       DELETE FROM refresh_tokens WHERE user_id IN (SELECT user_id FROM spent)
     )
     SELECT id FROM changed`,
    [hash(token), passwordHash],
  );
  return rows.length > 0;
}

export const purgeExpiredTokens = () => Promise.all([
  query('DELETE FROM refresh_tokens WHERE expires_at < now()'),
  query('DELETE FROM password_reset_tokens WHERE expires_at < now() - interval \'1 day\''),
]);
