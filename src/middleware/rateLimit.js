import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redisClient } from '../utils/redis.js';

function redisStore(name) {
  const store = new RedisStore({ sendCommand: (...args) => redisClient.call(...args), prefix: `rl:${name}:` });
  // The store loads its Lua scripts at construction. If Redis is down at boot that rejection
  // is unhandled; the store reloads the scripts itself on the first request, so ignore it here.
  store.incrementScriptSha.catch(() => {});
  store.getScriptSha.catch(() => {});
  return store;
}

// Shared across instances when Redis is configured, per-process memory otherwise.
// passOnStoreError: if Redis goes down, requests are let through instead of failing.
function limiter(name, windowMs, max, message, options = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    message: { error: message },
    store: redisClient ? redisStore(name) : undefined,
    ...options,
  });
}

const MIN = 60 * 1000;

export const globalLimiter = limiter('global', 15 * MIN, 300, 'Too many requests. Try again later.');
export const authLimiter = limiter('auth', 15 * MIN, Number(process.env.AUTH_LIMIT_MAX) || 8, 'Too many attempts. Try again in 15 minutes.', {
  skipSuccessfulRequests: true, // only failed logins and duplicate registrations count
});
// Counts every request (not just failures): each forgot-password call can trigger an email.
export const resetLimiter = limiter('reset', 15 * MIN, Number(process.env.AUTH_LIMIT_MAX) || 8, 'Too many attempts. Try again in 15 minutes.');
export const writeLimiter = limiter('write', MIN, 30, 'Too many requests. Slow down.');
export const calcLimiter = limiter('calc', MIN, 20, 'Too many calculation requests.');
// Each assistant call goes to an outside AI service and costs money, so it is limited more tightly.
export const aiLimiter = limiter('ai', MIN, 10, 'Too many assistant requests. Try again in a minute.');
export const readLimiter = limiter('read', MIN, 60, 'Too many requests.');
