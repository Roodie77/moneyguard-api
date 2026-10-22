import crypto from 'crypto';
import logger from '../utils/logger.js';

// One log line per request: "GET /api/bills 200 12ms 3f2a9c1e". The id is also sent back in the
// X-Request-Id header so a client report can be matched to a log line.
// Only the path is logged (no query string, no body) to keep tokens and personal data out of logs.
export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  const id = crypto.randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', id);

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Math.round(ms)}ms ${id}`);
  });

  next();
}
