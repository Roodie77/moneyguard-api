import 'dotenv/config';
import app from './app.js';
import logger from './utils/logger.js';
import { closeRedis } from './utils/redis.js';
import { connectDb, closeDb } from './utils/db.js';
import { purgeExpiredTokens } from './services/tokens.js';
import { purgeOldAlerts } from './services/alerts.js';

const PORT = process.env.PORT || 3000;

// Refuse to start without a working database instead of failing on the first request.
try {
  await connectDb();
} catch (err) {
  logger.error(`Database connection failed: ${err.message || err.code}`); // refused connections have an empty message
  process.exit(1);
}

// Used refresh tokens are kept until they expire (to detect reuse); alerts are kept for 90 days. This removes the dead rows.
const purge = setInterval(() => {
  Promise.all([purgeExpiredTokens(), purgeOldAlerts()]).catch((err) => logger.warn(`Cleanup failed: ${err.message}`));
}, 3_600_000);
purge.unref();

const server = app.listen(PORT, () => {
  logger.info(`MoneyGuard running on port ${PORT}`);
});

// Load balancers (AWS ALB: 60s) keep idle connections longer than Node's 5s default. If Node closes first,
// the balancer reuses a dead connection and the user gets a random 502. Stay above the balancer's idle timeout.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000; // must be larger than keepAliveTimeout

// Stop taking new connections, let in-flight requests finish, then exit.
function shutdown(reason, code = 0) {
  logger.info(`Shutting down (${reason})`);
  setTimeout(() => process.exit(1), 10_000).unref(); // hard stop if something hangs
  server.close(async () => {
    await Promise.allSettled([closeRedis(), closeDb()]);
    process.exit(code);
  });
}

server.on('error', (err) => {
  logger.error(`Server error: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', err);
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err);
  shutdown('uncaughtException', 1);
});
