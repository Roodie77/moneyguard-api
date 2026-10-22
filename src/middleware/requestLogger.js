import crypto from 'crypto';
import logger from '../utils/logger.js';

// One log line per request: "GET /api/bills 200 12ms 3f2a9c1e 203.0.113.9". The id is also sent back in the
// X-Request-Id header so a client report can be matched to a log line.
// Only the path is logged (no query string, no body) to keep tokens and personal data out of logs.
// The last field is the client IP. Behind a proxy or load balancer it is only the real client when TRUST_PROXY
// is set to the number of proxies; otherwise it is the proxy's address.
export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  const id = crypto.randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', id);

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    const ip = (req.ip || '-').replace(/^::ffff:/, ''); // an IPv4 address arriving over IPv6 reads as ::ffff:1.2.3.4
    logger[level](`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Math.round(ms)}ms ${id} ${ip}`);
  });

  next();
}
