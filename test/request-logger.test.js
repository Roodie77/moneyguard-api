// The one-line-per-request log: what it contains, and what it must never contain.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startApp } from './helpers.js';

let app;
let logger;
let requestLogger;
before(async () => {
  app = await startApp();
  ({ default: logger } = await import('../src/utils/logger.js'));
  ({ requestLogger } = await import('../src/middleware/requestLogger.js'));
});
after(() => app.stop());

// Runs one fake request through the middleware and returns the log line it wrote.
function logLine({ method = 'GET', url = '/api/bills', ip, status = 200 }) {
  const lines = [];
  const saved = { info: logger.info, warn: logger.warn, error: logger.error };
  for (const level of Object.keys(saved)) logger[level] = (message) => lines.push({ level, message });
  try {
    const res = Object.assign(new EventEmitter(), { statusCode: status, setHeader() {} });
    requestLogger({ method, originalUrl: url, ip }, res, () => {});
    res.emit('finish');
  } finally {
    Object.assign(logger, saved);
  }
  return lines[0];
}

test('the line ends with the client IP, after method, path, status, time and request id', () => {
  const { message } = logLine({ ip: '203.0.113.9' });
  assert.match(message, /^GET \/api\/bills 200 \d+ms [0-9a-f]{8} 203\.0\.113\.9$/);
});

test('an IPv4 address that arrives over IPv6 is shown as plain IPv4; real IPv6 is kept', () => {
  assert.ok(logLine({ ip: '::ffff:198.51.100.7' }).message.endsWith(' 198.51.100.7'));
  assert.ok(logLine({ ip: '2001:db8::1' }).message.endsWith(' 2001:db8::1'));
});

test('a request with no known address logs a dash instead of crashing', () => {
  assert.ok(logLine({ ip: undefined }).message.endsWith(' -'));
});

test('query strings are still left out, and the level still follows the status', () => {
  const ok = logLine({ url: '/api/expenses?category=food&token=secret', ip: '203.0.113.9' });
  assert.equal(ok.level, 'info');
  assert.ok(!ok.message.includes('secret') && !ok.message.includes('?'));
  assert.equal(logLine({ status: 404, ip: '203.0.113.9' }).level, 'warn');
  assert.equal(logLine({ status: 500, ip: '203.0.113.9' }).level, 'error');
});

test('on the real app, a request is logged with the caller\'s IP', async () => {
  const lines = [];
  const saved = logger.warn;
  logger.warn = (message) => lines.push(message);
  try {
    const res = await app.api('GET', '/api/me'); // no token: a 401, logged at warn level
    assert.equal(res.status, 401);
  } finally {
    logger.warn = saved;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^GET \/api\/me 401 \d+ms [0-9a-f]{8} (127\.0\.0\.1|::1)$/);
});
