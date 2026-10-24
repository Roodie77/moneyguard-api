import express from 'express';
import bcrypt from 'bcrypt';
import { query } from '../utils/db.js';
import { signToken, ACCESS_TOKEN_SECONDS } from '../middleware/auth.js';
import { authLimiter, resetLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import * as schemas from '../validation/schemas.js';
import {
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshFamily,
  issueResetToken,
  resetPassword,
} from '../services/tokens.js';
import { sendPasswordReset } from '../services/mailer.js';
import logger from '../utils/logger.js';

const router = express.Router();

const UNIQUE_VIOLATION = '23505';

// Same answer whether or not the email has an account, so the endpoint cannot be used to find out who is registered.
const RESET_REQUESTED = { message: 'If that email has an account, a password reset link is on its way.' };

async function session(user) {
  return {
    token: signToken(user.id),
    expiresIn: ACCESS_TOKEN_SECONDS,
    refreshToken: await issueRefreshToken(user.id),
    user: sanitize(user),
  };
}

router.post('/register', authLimiter, validate(schemas.register), h(async (req, res) => {
  const { email, password, phone, name } = req.body;
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const [user] = await query(
      'INSERT INTO users (email, phone, password_hash, name) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, phone || null, passwordHash, name || null],
    );
    logger.info(`User registered: ${user.email}`);
    res.status(201).json(await session(user));
  } catch (err) {
    // The UNIQUE constraint is the real guard: it also holds when two sign-ups race.
    if (err.code === UNIQUE_VIOLATION) return res.status(409).json({ error: 'Email already registered' });
    throw err;
  }
}));

router.post('/login', authLimiter, validate(schemas.login), h(async (req, res) => {
  const { email, password } = req.body;
  const [user] = await query('SELECT * FROM users WHERE email = $1', [email]);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  logger.info(`User logged in: ${user.email}`);
  res.json(await session(user));
}));

// Each refresh token works once: it is swapped for a new access token and a new refresh token.
router.post('/refresh', authLimiter, validate(schemas.refresh), h(async (req, res) => {
  const spent = await consumeRefreshToken(req.body.refreshToken);
  if (!spent) return res.status(401).json({ error: 'Invalid or expired refresh token' });
  res.json({
    token: signToken(spent.userId),
    expiresIn: ACCESS_TOKEN_SECONDS,
    refreshToken: await issueRefreshToken(spent.userId, spent.familyId),
  });
}));

// Ends this login on every device that shares the refresh token's family. Always succeeds, so a client can call it blindly.
router.post('/logout', authLimiter, validate(schemas.refresh), h(async (req, res) => {
  await revokeRefreshFamily(req.body.refreshToken);
  res.json({ ok: true });
}));

router.post('/forgot-password', resetLimiter, validate(schemas.forgotPassword), h(async (req, res) => {
  const [user] = await query('SELECT id, email FROM users WHERE email = $1', [req.body.email]);
  const token = user && await issueResetToken(user.id);
  res.json(RESET_REQUESTED);
  // After the response, so a slow mail server doesn't reveal which emails exist.
  if (token) {
    try {
      await sendPasswordReset(user.email, token);
    } catch (err) {
      logger.error(`Could not send password reset: ${err.message}`);
    }
  }
}));

router.post('/reset-password', authLimiter, validate(schemas.resetPassword), h(async (req, res) => {
  const passwordHash = await bcrypt.hash(req.body.password, 10);
  if (!await resetPassword(req.body.token, passwordHash)) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }
  res.json({ ok: true });
}));

function sanitize(user) {
  const { passwordHash, passwordChangedAt, avatarPublicId, ...rest } = user;
  return rest;
}

export default router;
