import crypto from 'crypto';
import { getRedis } from '../utils/redis.js';

const TTL_SEC = 300;
const memory = new Map(); // cacheKey -> { value, expires }

setInterval(() => {
  const now = Date.now();
  for (const [key, { expires }] of memory) if (expires < now) memory.delete(key);
}, 60_000).unref();

async function get(key) {
  const redis = getRedis();
  if (redis) return JSON.parse((await redis.get(key)) ?? 'null');
  const hit = memory.get(key);
  return hit && hit.expires > Date.now() ? hit.value : null;
}

async function save(key, value) {
  const redis = getRedis();
  if (redis) return redis.set(key, JSON.stringify(value), 'EX', TTL_SEC);
  memory.set(key, { value, expires: Date.now() + TTL_SEC * 1000 });
}

// Atomically marks the key as "in progress". Returns false if someone else already did.
async function claim(key) {
  const redis = getRedis();
  if (redis) return (await redis.set(key, JSON.stringify({ pending: true }), 'EX', TTL_SEC, 'NX')) === 'OK';
  if (await get(key)) return false;
  await save(key, { pending: true });
  return true;
}

async function remove(key) {
  const redis = getRedis();
  if (redis) return redis.del(key);
  memory.delete(key);
}

// Server errors and rate-limit rejections are not cached, so the client can retry them.
const isCacheable = (status) => status < 500 && status !== 429;

export async function idempotency(req, res, next) {
  // Only for requests that change something. Replaying a GET would serve stale data.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !key || key.length > 128) return next();

  // Runs before auth, so scope by token (or IP) and body. Otherwise two users sharing
  // an IP and a key would be served each other's cached response.
  const caller = `${req.headers.authorization || req.ip}|${JSON.stringify(req.body ?? {})}`;
  const fingerprint = crypto.createHash('sha256').update(caller).digest('hex');
  const cacheKey = `idem:${fingerprint}:${req.method}:${req.path}:${key}`;

  try {
    const existing = await get(cacheKey);
    if (existing && !existing.pending) {
      res.set('Idempotent-Replayed', 'true');
      return res.status(existing.status).json(existing.body);
    }
    if (existing || !(await claim(cacheKey))) {
      return res.status(409).json({ error: 'Request still processing' });
    }
  } catch {
    return next(); // storage trouble must never block the request
  }

  let stored = false;
  const json = res.json.bind(res);
  res.json = (body) => {
    if (isCacheable(res.statusCode)) {
      stored = true;
      save(cacheKey, { status: res.statusCode, body }).catch(() => {});
    }
    return json(body);
  };

  // Release the lock if no cacheable response was produced (error, aborted client).
  res.on('close', () => {
    if (!stored) remove(cacheKey).catch(() => {});
  });

  next();
}
