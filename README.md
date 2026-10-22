# MoneyGuard Backend

REST API for MoneyGuard: track balance, bills and expenses, get a daily "safe to spend" figure, and
run affordability calculators (projected balance after a new EMI, loan affordability, cash-flow projection).

Node 20+, Express, PostgreSQL, JWT auth. Optional Redis for rate limits shared across instances.

**New to the API?** Start with [docs/API_GUIDE.md](docs/API_GUIDE.md), a plain-language walkthrough for frontend developers.

**Maintaining the backend?** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the API overview, database schema, and the authentication and security approach.

**API reference:** run the server and open [`/docs`](http://localhost:3000/docs) (Swagger UI), or read
[`src/docs/openapi.yaml`](src/docs/openapi.yaml). A test keeps that file in sync with the code.

## Quick start

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL and JWT_SECRET
npm run migrate             # creates the tables
npm run dev                 # http://localhost:3000
```

You need a PostgreSQL database. The easiest is a free one from [Neon](https://neon.tech) or
[Supabase](https://supabase.com): create a project and paste its connection string into `DATABASE_URL`.

A healthy start looks like this:

```
[INFO] Database connected (neondb)
[INFO] MoneyGuard running on port 3000
```

If the database is unreachable, or is not UTF8-encoded (required for non-Latin text such as Hindi), the server exits
with code 1 instead of starting half-working. Neon and Supabase databases are UTF8 by default.

## Configuration

Set in `.env` locally, as real environment variables in production.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | in production | Signs login tokens. The server refuses to start without it when `NODE_ENV=production`. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `PORT` | no | Default `3000` |
| `DB_CONNECT_TIMEOUT_MS` | no | Max wait for a database connection. Default `5000`; use `20000` when developing against a distant hosted database. |
| `NODE_ENV` | no | Set to `production` when deployed |
| `TRUST_PROXY` | behind a proxy | Number of reverse proxies in front of the app (usually `1`). Without it, every user appears to share the proxy's IP and one rate-limit bucket. |
| `REDIS_URL` | multiple instances | Shares rate limits and idempotency across instances. Without it they live in memory, per process. If Redis goes down, requests are let through. |
| `ACCESS_TOKEN_SECONDS` | no | Access token lifetime. Default `3600` (1 hour). |
| `REFRESH_TOKEN_DAYS` | no | Refresh token lifetime, renewed on every refresh. Default `7`. |
| `LOG_LEVEL` | no | Default `info` |
| `AUTH_LIMIT_MAX` | no | Failed login/sign-up attempts allowed per 15 min per IP. Default `8`; only the test suite changes it. |

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm start` | Start (production) |
| `npm run migrate` | Apply new database migrations (safe to run repeatedly) |
| `npm test` | Run all tests against a throwaway Postgres (about 20 seconds, no setup) |
| `npm run load` | Load test the real server (see below) |

## Project layout

```
src/
  server.js          boot: connect DB, listen, graceful shutdown
  app.js             middleware order and routes
  routes/            auth.js (register/login), api.js (everything behind a token)
  validation/        Joi schemas, one per endpoint
  middleware/        auth, validate, rateLimit, idempotency, upload, requestLogger, errorHandler
  services/          calculator.js: pure money maths, no I/O; budget.js: safe-to-spend; alerts.js: rule engine;
                     notifier.js: alert delivery hook; tokens.js: refresh + reset tokens; mailer.js: reset email hook
  db/                migrate.js and migrations/*.sql
  utils/             db, redis, logger
  docs/openapi.yaml  the API contract
test/                node:test suites + run.js (starts the test database)
```

## How it behaves

- **Validation:** every write is validated; bad input is a `400` with `details` per field.
- **Money:** `NUMERIC(15,2)` in the database, rounded to cents on input.
- **Dates:** real calendar dates, 1900-2200. `2026-12-01` means UTC midnight; a date-time must include a zone (`...Z` or `+05:30`). All "today" and "days until income" maths use UTC days, so results do not depend on the server's time zone.
- **Passwords:** 8 to 72 bytes (bcrypt ignores anything longer). **Emails:** ASCII only.
- **Sessions:** login and sign-up return a 1-hour access `token` (plus `expiresIn`, in seconds) and a 7-day `refreshToken`. Every refresh issues a new 7 days, so an active user stays signed in and an idle login ends after 7 days. `POST /api/auth/refresh` swaps a refresh token for a new pair; each refresh token works once, and presenting a used one revokes that whole login. `POST /api/auth/logout` revokes it. Refresh tokens are stored hashed.
- **Password reset:** `POST /api/auth/forgot-password` (always the same answer, so it can't reveal who has an account) then `POST /api/auth/reset-password` with the emailed token (valid 60 minutes, once). A reset signs the user out everywhere. **Emails are not wired up yet**: see `src/services/mailer.js`. Outside production the token is logged; in production nothing is sent until you plug in a provider.
- **Spending:** an expense larger than the balance is refused with `422` and nothing changes. The check and the deduction are one atomic statement, so simultaneous requests cannot overspend.
- **Transactions:** `GET /api/expenses` filters by day range, category and amount and is paged (`limit`, `offset`, `X-Total-Count`). Expenses can be edited (`PUT`) and deleted (`DELETE`); both move the balance atomically (a delete refunds it, a raise above the balance is a `422`).
- **Analytics:** `GET /api/analytics/summary` gives totals, an average per day, spending per category and a per-day or per-month series for a range of UTC days.
- **Alerts:** users set their own thresholds (`PUT /api/alert-rules`): low balance, daily limit, monthly limit, category budget, bill due soon, over today's safe-to-spend. There are no default rules. Rules are checked after every change that affects them and when the list is read; each fires once per day, month or bill. `GET /api/alerts` lists them (kept 90 days). **Nothing is pushed yet**: plug a sender into `src/services/notifier.js`.
- **Idempotency:** send an `Idempotency-Key` header on POST/PUT; a retry returns the first result instead of repeating the action.
- **Rate limits (per IP):** 8 failed logins or sign-ups per 15 min, 30 writes / 20 calculations / 60 reads per minute, 300 requests per 15 min overall. `/health` is exempt.
- **Logging:** one line per request (`GET /api/bills 200 12ms 3f2a9c1e`); the id is also returned as `X-Request-Id`. Query strings and bodies are never logged.
- **Shutdown:** on SIGTERM the server stops accepting connections, finishes in-flight requests, then closes the database and Redis.

Building the mobile app? See [docs/CLIENT_AUTH.md](docs/CLIENT_AUTH.md) for how it should store tokens, lock on launch and background, and react to each auth response.

## Load testing

`npm run load` boots the real `src/server.js` (`NODE_ENV=production`, `TRUST_PROXY=1`) against a throwaway Postgres and
hits it over real HTTP with [autocannon](https://github.com/mcollina/autocannon), each simulated client carrying its own
`X-Forwarded-For` the way traffic arrives from a gateway. It runs five scenarios (health flood, dashboard reads, writes with
unique idempotency keys, login storm, one abusive IP) and, while each runs, probes `/health` every 100 ms to show whether the
server stays responsive. Options: `DURATION=10` (seconds), `CONNECTIONS_SCALE=1`, `ONLY=login` (scenario name filter),
`LOG_LEVEL`. Set `TEST_DATABASE_URL` to test against another database (never your production one).

Reference run on a laptop with the server, database and load generator all on the same machine (so a floor, not a capacity plan):

| Scenario | req/s | Notes |
|---|---|---|
| `/health`, 1000 connections | ~4,000-6,000 | 0 errors |
| Dashboard reads, 500 connections | ~1,000-1,400 | 0 errors |
| Expense writes, 300 connections | ~900-1,500 | 0 errors, memory steady |
| Login storm, 100 connections | ~56 | bcrypt is CPU-bound by design; `/health` stayed under 100 ms |
| 3,000 simultaneous connections | ~870 | 0 errors, p99 about 5 s: it queues instead of crashing |
| One IP sending 20,000 requests | n/a | 19,940 answered `429`, 60 served, no errors |

When the database is saturated (no free connection within 5 s, or a query over 10 s) clients get `503` with `Retry-After`.
Throughput scales with more instances behind a load balancer plus `REDIS_URL`; that multi-instance setup is not covered by `npm run load`.

## Migrations

Add a new file `src/db/migrations/002_what_it_does.sql` and run `npm run migrate`. Files run once, in name order,
each in its own transaction. Never edit a migration that has already been applied; add a new one.

## Deploying to Render

Create a **Web Service** from the GitHub repo using the **Node** runtime (Node 20 or newer).

| Setting | Value |
|---|---|
| Build command | `npm ci --omit=dev` |
| Start command | `npm run migrate && npm start` |
| Health check path | `/health` |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | your Neon / Supabase / Render Postgres connection string |
| `JWT_SECRET` | a long random value (see Configuration). The server refuses to start without it in production |
| `TRUST_PROXY` | `1` (Render puts one proxy in front of the app) |
| `DB_CONNECT_TIMEOUT_MS` | `20000` if the database is hosted far away or sleeps when idle |

`PORT` is set by Render and read by the app.

**Migrations:** the start command above applies new migrations every time the service starts. That is safe to repeat, and instances starting together wait for each other. On a paid plan you can instead run `npm run migrate` as Render's *Pre-Deploy Command* and keep the start command as `npm start`.

**Things to know on Render:**
- The disk is wiped on every deploy and restart, so **uploaded files disappear** unless you attach a persistent disk mounted on the `src/uploads` folder (paid). See the limitations below.
- Free web services go to sleep when idle, and the first request after that is slow.
- Rate limits and idempotency are kept in memory, which is fine for one instance. Set `REDIS_URL` before running more than one.
- Password-reset emails and alert notifications are not sent until a sender is plugged into `src/services/mailer.js` and `src/services/notifier.js`.
- Never commit `.env`. It is already in `.gitignore`; set the same values in Render's *Environment* tab instead.

## Deploy checklist

- [ ] `NODE_ENV=production` and a long random `JWT_SECRET`
- [ ] `DATABASE_URL` points at the production database; `npm run migrate` ran
- [ ] `TRUST_PROXY` matches the number of proxies in front of the app
- [ ] `REDIS_URL` set if running more than one instance
- [ ] Uploads directory is on a persistent volume (see limitations)
- [ ] A real email sender is plugged into `src/services/mailer.js`, and a push/email sender into `src/services/notifier.js` if you want alerts delivered
- [ ] Load balancer health check hits `/health` (200 = ok, 503 = database down)
- [ ] HTTPS terminated in front of the app

## Known limitations

- **Uploads are stored on local disk** (`src/uploads`) and served publicly at `/uploads/<random-name>`. This does not
  scale past one instance and the links are unguessable, not private. Moving to object storage (S3, R2) with signed
  URLs is the planned fix.
- **CORS is open to every origin.** Restrict it to the real frontend origins before launch.
- **Password-reset emails need a provider.** The reset flow works end to end, but `src/services/mailer.js` only logs the token (outside production) until you connect an email service.
- **Access tokens last 1 hour** and cannot be revoked individually: logout ends the refresh token, and a password reset invalidates earlier access tokens, but a stolen access token otherwise works until it expires.
