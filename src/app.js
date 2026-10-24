import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { idempotency } from './middleware/idempotency.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { isRedisAvailable } from './utils/redis.js';
import { pingDb } from './utils/db.js';
import logger from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Number of reverse proxies in front of the app (e.g. 1 behind a load balancer),
// so req.ip is the real client and not the proxy shared by every user.
if (process.env.TRUST_PROXY) {
  const proxies = Number(process.env.TRUST_PROXY);
  if (!Number.isInteger(proxies) || proxies < 0) throw new Error('TRUST_PROXY must be a whole number of proxies, e.g. 1');
  app.set('trust proxy', proxies);
}

// Before the limiters, so load-balancer probes are never rate limited.
app.get('/health', async (req, res) => {
  const database = await pingDb();
  res.status(database ? 200 : 503).json({
    status: database ? 'ok' : 'degraded',
    database: database ? 'connected' : 'down',
    redis: isRedisAvailable() ? 'connected' : 'memory',
  });
});

app.use(requestLogger); // after /health so probes don't flood the logs

// API documentation for the frontend team: Swagger UI at /docs, reading the spec below.
app.get('/openapi.yaml', (req, res) => res.sendFile(path.join(__dirname, 'docs/openapi.yaml')));
app.get('/docs', (req, res) => res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>MoneyGuard API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.34.0/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.34.0/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/openapi.yaml', dom_id: '#ui' })</script></body></html>`));

// Which websites may call the API from a browser. Set CORS_ORIGINS to a comma-separated list.
// Until the frontend exists, only this placeholder is allowed. Replace it via CORS_ORIGINS.
const PLACEHOLDER_ORIGIN = 'https://frontend-placeholder.example.com';

function corsOrigin(origin, callback) {
  // No Origin header: mobile app, Postman, curl. CORS only applies to browsers.
  if (!origin) return callback(null, true);

  const configured = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const allowed = configured.length > 0 ? configured : [PLACEHOLDER_ORIGIN];
  return callback(null, allowed.includes(origin));
}

// Browsers only let scripts read these response headers if they are listed here.
app.use(cors({
  origin: corsOrigin,
  exposedHeaders: ['X-Request-Id', 'X-Total-Count', 'Retry-After', 'Idempotent-Replayed', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  maxAge: 600,
}));
app.use(express.json({ limit: '10kb' }));
app.use(globalLimiter);
app.use(idempotency);

app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

app.use('/api/auth', authRoutes);
app.use('/api', apiRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use(errorHandler);

export default app;