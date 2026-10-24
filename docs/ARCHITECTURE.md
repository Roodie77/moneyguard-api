# MoneyGuard backend: architecture

For developers maintaining the backend. Frontend developers want [API_GUIDE.md](API_GUIDE.md); the exact contract is
[`src/docs/openapi.yaml`](../src/docs/openapi.yaml) (served at `/docs`).

1. [API overview](#1-api-overview)
2. [Database schema](#2-database-schema)
3. [Authentication and security approach](#3-authentication-and-security-approach)

---

## 1. API overview

### Shape

REST over HTTP, JSON bodies, one process. Node 20+, Express 4, PostgreSQL (`pg`), optional Redis (`ioredis`).

```
request
  -> /health                      (before everything: never logged, never rate limited)
  -> requestLogger                (request id, one line per request with the client IP, no bodies or query strings)
  -> /openapi.yaml, /docs         (Swagger UI)
  -> cors -> express.json(10kb) -> globalLimiter -> idempotency
  -> /uploads/*                   (static files)
  -> /api/auth/*                  (routes/auth.js, public)
  -> /api/*                       (routes/api.js: authMiddleware, then loads the user row)
  -> 404 JSON -> errorHandler
```

Order matters: the idempotency middleware runs before auth, which is why its cache key includes the caller's
`Authorization` header (or IP) and the body. See [idempotency](#idempotency).

### Endpoints

| Area | Method and path | Auth | Limiter | Notes |
|---|---|---|---|---|
| Platform | `GET /health` | no | none | 200 / 503 (database down) |
| Auth | `POST /api/auth/register` | no | auth | returns tokens + user |
| Auth | `POST /api/auth/login` | no | auth | same 401 for unknown email and wrong password |
| Auth | `POST /api/auth/refresh` | refresh token | auth | rotates the refresh token |
| Auth | `POST /api/auth/logout` | refresh token | auth | always 200 |
| Auth | `POST /api/auth/forgot-password` | no | reset | always 200 |
| Auth | `POST /api/auth/reset-password` | reset token | auth | signs the user out everywhere |
| Profile | `GET /api/me` | yes | read | |
| Profile | `PUT /api/balance` | yes | write | replaces the balance |
| Profile | `PUT /api/next-income` | yes | write | |
| Profile | `PUT /api/savings-goal` | yes | write | |
| Profile | `PUT`, `DELETE /api/me/avatar` | yes | write | profile picture (image, max 5 MB) kept on Cloudinary or on disk; the old one is deleted |
| Profile | `GET`, `PUT /api/financial-profile` | yes | read / write | the numbers typed into the calculators, saved per user (partial saves; defaults when nothing is saved) |
| Bills | `GET/POST /api/bills`, `DELETE /api/bills/:id` | yes | read / write | |
| Expenses | `GET /api/expenses` | yes | read | filters (`from`, `to`, `category`, `minAmount`, `maxAmount`), `limit`/`offset`, `X-Total-Count` |
| Expenses | `POST /api/expenses` | yes | write | atomic; refuses overspend (422) |
| Expenses | `PUT`, `DELETE /api/expenses/:id` | yes | write | move the balance by the difference / refund, atomically |
| Analytics | `GET /api/analytics/summary` | yes | read | totals, per category, per day or month, for a UTC date range |
| Alerts | `GET`, `PUT /api/alert-rules`, `DELETE /api/alert-rules/:id` | yes | read / write | the user's own thresholds |
| Alerts | `GET /api/alerts`, `POST /api/alerts/read-all`, `POST /api/alerts/:id/read` | yes | read / write | GET checks the rules first |
| Files | `GET/POST /api/files` | yes | read / write | multipart, 20 MB, type allow-list |
| Files | `GET /uploads/:filename` | no | global | public, unguessable name |
| Dashboard | `GET /api/dashboard` | yes | read | balance, safe-to-spend, 5 latest expenses, unread alert count |
| Calculators | `POST /api/can-i-afford` | yes | calc | records an `affordability_checks` row |
| Calculators | `POST /api/projected-balance`, `/cash-flow`, `/affordability` | yes | calc | pure maths, no database access |

### Code map

```
src/server.js         boot: connect DB (exit 1 on failure), hourly token purge, listen, graceful shutdown
src/app.js            middleware order and routes
src/routes/auth.js    public auth endpoints
src/routes/api.js     everything behind an access token
src/validation/       Joi schemas, one per endpoint; unknown fields are stripped
src/middleware/       auth, validate, rateLimit, idempotency, upload, requestLogger, errorHandler
src/services/         calculator.js (pure maths), budget.js (safe-to-spend for a user), alerts.js (rule engine),
                      notifier.js (alert delivery hook), tokens.js (refresh/reset tokens), mailer.js (reset email hook)
src/db/               migrate.js + migrations/*.sql
src/utils/            db.js (pool, camelCase rows), redis.js, logger.js, asyncHandler.js
```

### Conventions

- **Validation:** every write goes through `validate(schema)`. Bad input is a `400` with `details: [{field, message}]`.
  Rounding to cents happens in the schema (`precision(2)`), before the database sees the value.
- **Errors:** `{ "error": "..." }`. Unhandled errors are logged with a stack and returned as a generic 500.
  A database that is saturated (no connection within 5 s) or a query over 10 s becomes `503` with `Retry-After`.
- **Naming:** columns are `snake_case`; `db.query()` converts rows to `camelCase`, which is what the API returns.
- **Money:** `NUMERIC(15,2)` in Postgres. `pg` returns NUMERIC as strings; `db.js` parses them to numbers, which is exact
  here because amounts are capped at 1e12 with 2 decimals.
- **Dates:** `timestamptz`. Inputs must be real calendar dates between 1900 and 2200; date-times need a zone. All "today"
  and "days until income" maths use UTC days.
- **Contract test:** `test/openapi.test.js` fails if a route exists in code but not in the spec (or the reverse), and checks
  real responses against the documented schemas.

### Behaviour worth knowing

**Expenses are one atomic statement.** The balance is reduced only if it covers the amount, and the expense row is inserted
only if that happened:

```sql
WITH reduced AS (
  UPDATE users SET balance = balance - $2 WHERE id = $1 AND balance >= $2 RETURNING id
), new_expense AS (
  INSERT INTO expenses (user_id, amount, category, description, date)
  SELECT id, $2::numeric, $3::text, $4::text, $5::timestamptz FROM reduced RETURNING *
)
SELECT * FROM new_expense
```

No row back means insufficient balance (`422`, nothing written). The `UPDATE` locks the user's row, so simultaneous
expenses are checked one after another against the real balance. The `CHECK (balance >= 0)` constraint is a second guard.
`PUT /api/balance` still sets any non-negative value directly.

**Rate limits** (per client IP; Redis-backed when `REDIS_URL` is set, in-process memory otherwise; a Redis outage lets
requests through rather than failing them):

| Limiter | Limit | Applied to |
|---|---|---|
| global | 300 / 15 min | everything except `/health` |
| auth | 8 / 15 min, **failed requests only** | register, login, refresh, logout, reset-password |
| reset | 8 / 15 min, **every request** | forgot-password |
| write | 30 / min | state-changing `/api` calls |
| calc | 20 / min | calculators |
| read | 60 / min | reads |

`TRUST_PROXY` must match the number of proxies in front of the app, or all users share one IP and one bucket.

<a id="idempotency"></a>
**Idempotency.** `POST/PUT/DELETE` with an `Idempotency-Key` header (max 128 chars) replay the first response for 5 minutes.
The cache key is a hash of caller (`Authorization` header or IP) + body, plus method, path and key, so users cannot see each
other's responses. A concurrent duplicate gets `409 Request still processing`. Responses with status 500+ or 429 are not
stored. A stored `422` is replayed too, so a client must use a new key for a new attempt. Responses are cached **as sent**,
which for login/register/refresh includes tokens; clients should not send the header there.

**Shutdown.** SIGTERM/SIGINT stop accepting connections, finish in-flight requests, close Redis and the pool; a hard exit
follows after 10 s.

---

## 2. Database schema

PostgreSQL. Migrations are plain `.sql` files in `src/db/migrations`, run in name order by `npm run migrate`, each in its
own transaction, tracked in `schema_migrations`. A Postgres advisory lock makes concurrent deploys safe. Never edit an
applied migration; add a new one. The database must be UTF8 (checked at boot).

### Entity relationships

```
users 1 ──< bills
      1 ──< expenses
      1 ──< files
      1 ──< affordability_checks
      1 ──< refresh_tokens
      1 ──< alert_rules ──< alerts   (alerts also hang off users; rule_id becomes NULL if the rule is deleted)
      1 ──1 financial_profiles       (at most one row per user, created on the first save)
      1 ──< password_reset_tokens

(every child row: user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE)
```

Deleting a user removes all of their rows.

### Tables

**`users`** (001, 002)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `email` | text, unique | `CHECK (email = lower(email))`; the app also lowercases and restricts to ASCII |
| `phone` | text | optional |
| `password_hash` | text | bcrypt, cost 10 |
| `balance` | numeric(15,2) | default 0, `CHECK (>= 0)` |
| `next_income_amount` | numeric(15,2) | default 0, `CHECK (>= 0)` |
| `next_income_date` | timestamptz | nullable |
| `savings_goal_amount` | numeric(15,2) | default 0, `CHECK (>= 0)` |
| `savings_goal_deadline` | timestamptz | nullable |
| `created_at` | timestamptz | default `now()` |
| `password_changed_at` | timestamptz | nullable; set on password reset. Access tokens issued before it are rejected |
| `avatar_url` | text | nullable (006); the picture to show: a Cloudinary https link, or `/uploads/<name>` for a file on disk |
| `avatar_public_id` | text | nullable (006); the Cloudinary id, used to delete the old picture; never returned by the API |

**`bills`**: `id`, `user_id`, `name` text, `amount` numeric(15,2) `CHECK (> 0)`, `due_date` timestamptz (nullable),
`created_at`. Index `bills_user_idx (user_id)`.

**`expenses`**: `id`, `user_id`, `amount` numeric(15,2) `CHECK (> 0)`, `category` text (default `Other`),
`description` text (default empty), `date` timestamptz (default `now()`), `created_at`.
Index `expenses_user_date_idx (user_id, date DESC)`.

**`files`**: `id`, `user_id`, `filename` (server-side name, a random UUID plus an extension chosen from the allowed type),
`original_name`, `mimetype`, `size` integer, `created_at`, and (migration 004) `url`, `public_id`, `resource_type`. Index
`files_user_idx (user_id)`. The bytes are never in the database: with `CLOUDINARY_URL` set they are on Cloudinary (`url` is the
https link, `public_id` and `resource_type` identify the asset for deletion), otherwise on local disk in `src/uploads` (those
three columns are empty and the link is `/uploads/<filename>`). `services/storage.js` hides the difference.

**`affordability_checks`**: `id`, `user_id`, `amount` numeric(15,2), `recommendation` text, `created_at`.
Index `affordability_checks_user_idx (user_id)`. Append-only history written by `/can-i-afford`; nothing reads it yet.

**`refresh_tokens`** (002)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | FK, cascade |
| `family_id` | uuid | all tokens descended from one login share it |
| `token_hash` | text, unique | SHA-256 of the token; the token itself is never stored |
| `expires_at` | timestamptz | issue time + `REFRESH_TOKEN_DAYS` (default 7) |
| `used_at` | timestamptz | set when rotated; a used token seen again means theft |
| `created_at` | timestamptz | |

Indexes on `user_id`, `family_id`, `expires_at`.

**`password_reset_tokens`** (002): `id`, `user_id`, `token_hash` (unique, SHA-256), `expires_at` (60 minutes),
`used_at`, `created_at`. Index on `user_id`.

**`alert_rules`** (003): `id`, `user_id`, `type` (one of six, enforced by a CHECK), `threshold` numeric(15,2) `CHECK (> 0)`
(null only for `over_safe_to_spend`), `category` (required only for `category_monthly_budget`), `category_key` (generated:
`coalesce(lower(category), '')`), `enabled`, `created_at`, `updated_at`. `UNIQUE (user_id, type, category_key)` gives one
rule per type, and one per category (any letter case) for category budgets. CHECK constraints keep `threshold` and
`category` consistent with `type`.

**`alerts`** (003): `id`, `user_id`, `rule_id` (FK, `ON DELETE SET NULL`), `type`, `message`, `data` jsonb (the numbers behind
the message), `period_key`, `created_at`, `read_at`. `UNIQUE (rule_id, period_key)` is what makes a rule fire once per period
(see the alerts section below). Indexes: `(user_id, created_at DESC)` and a partial index on unread rows.

`expenses` also gets `expenses_user_category_idx (user_id, lower(category), date DESC)` for category filters and grouping.

**`financial_profiles`** (005): `user_id` (primary key and FK, cascade), `monthly_income`, `monthly_expenses`,
`existing_debt_payments`, `proposed_payment` (all numeric(15,2), `CHECK (>= 0)`), `target_dti_ratio` numeric(5,4) (0 to 1, default
0.4), `annual_interest_rate` numeric(7,6) (0 to 1, a fraction), `loan_term_months` (1 to 480, default 12), `updated_at`. The
calculators are stateless: they only compute from what a request sends. This table is what lets the app remember those inputs
between logins. `GET` returns defaults when there is no row; `PUT` is an upsert that changes only the fields sent.

### Housekeeping

- An hourly job (`purgeExpiredTokens` and `purgeOldAlerts`, started in `server.js`) deletes expired refresh tokens, reset tokens
  older than a day past expiry, and alerts older than 90 days. Used refresh tokens are kept until they expire on purpose, so reuse can be detected.
- `affordability_checks` and `expenses` grow without bound; there is no retention policy for them yet.

---

## 3. Authentication and security approach

### Two token types

| | Access token | Refresh token |
|---|---|---|
| Format | JWT, HS256, payload `{ userId, iat, exp }` | 32 random bytes, base64url, opaque |
| Lifetime | 1 hour (`ACCESS_TOKEN_SECONDS`) | 7 days (`REFRESH_TOKEN_DAYS`), renewed on every refresh |
| Sent as | `Authorization: Bearer ...` on every `/api` call | JSON body to `/api/auth/refresh` and `/logout` only |
| Stored server-side | no (stateless) | yes, as a SHA-256 hash |
| Revocable | no, expires on its own (or is invalidated by a password reset) | yes |

Why a fast SHA-256 and not bcrypt for refresh and reset tokens: they carry 256 random bits, so there is nothing to brute-force;
slow hashing is for low-entropy passwords.

### Passwords

- bcrypt, cost 10. Length 8 to **72 bytes** (bcrypt ignores everything after 72 bytes, so a longer multi-byte password
  would silently match another; the schema rejects it).
- Login does not distinguish an unknown email from a wrong password (same `401`, same message).
- The password hash is never returned: `sanitize()` in `routes/auth.js` and the `/me` handler strip it (and
  `password_changed_at`).
- Brute force: 8 failed login/register attempts per 15 minutes per IP. Passwords are never logged.

### Access tokens

- `jwt.verify` pins `algorithms: ['HS256']`, so `alg: none` and other algorithms are rejected (covered by tests).
- `JWT_SECRET` is **required when `NODE_ENV=production`**: the process throws at import time without it. Outside production
  an empty `JWT_SECRET` falls back to a built-in development secret, so a local `.env` with `JWT_SECRET=` (as in
  `.env.example`) works but its tokens are forgeable by anyone who has this source. Never deploy that way.
  Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Changing the secret
  invalidates every access token (users refresh to recover).
- After verifying the token, `routes/api.js` loads the user row. A token for a deleted account is a `401`. If
  `password_changed_at` is later than the token's `iat`, it is a `401` too.

### Refresh tokens: rotation and reuse detection

1. Login or register creates a new **family** and its first token.
2. `POST /refresh` runs one statement: `UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND
   expires_at > now() RETURNING ...`. Only one of several simultaneous requests can match, so the others get `401`.
   The winner is issued a new token in the same family.
3. If the token is unknown or expired: `401`. If it was **already used**, its whole family is deleted (assume it was stolen)
   and the answer is `401`.
4. `POST /logout` deletes the family. It always returns 200.
5. A client that loses a refresh response in transit has spent its token and must log in again. Accepted trade-off.

### Password reset

1. `POST /forgot-password` always returns the same `200` message, whether or not the email exists. The token is created and
   the email sent *after* the response, so a slow mail server does not reveal which addresses exist. Any earlier unused
   reset token for that user is deleted, so only the latest works. Rate-limited on every request (8 per 15 min per IP).
2. `POST /reset-password` is one SQL statement with three data-modifying CTEs: mark the token used (only if unused and
   unexpired), set the new password hash and `password_changed_at`, delete all of the user's refresh tokens.
   Either all of it happens or none of it; two simultaneous uses of one token change the password once.
3. Wrong tokens count as failed attempts against the auth limiter, so tokens cannot be guessed.
4. Result: the user is signed out everywhere. Old refresh tokens are gone and old access tokens fail the
   `password_changed_at` check (second resolution: a token issued in the same second as the reset is not rejected).

**Not finished:** `services/mailer.js` has no email provider. Outside production the reset token is logged; in production a
warning is logged and nothing is sent. Plug a provider in with `setMailer()` or by replacing `deliver`. Do not log reset
tokens in production, since a token in a log is an account takeover.

### Request-level protections

| Concern | Measure |
|---|---|
| SQL injection | parameterized queries everywhere; no string-built SQL with user input |
| Malformed input | Joi validation, unknown fields stripped, NUL characters rejected (Postgres cannot store them), body limited to 10 KB |
| Malformed ids | route-param UUID check returns 404 instead of a database error |
| Ownership | every query on user data filters by `user_id = req.userId`; other users' ids look like 404 |
| Overspending | atomic conditional `UPDATE` plus `CHECK (balance >= 0)` |
| Double submits | `Idempotency-Key` replay, scoped per caller |
| Abuse and overload | per-IP limits, DB pool of 10 with a 5 s wait cap, 10 s statement timeout, `503` + `Retry-After` when saturated |
| File uploads | allow-list of MIME types, extension chosen by the server (never from the client's name), random UUID filenames, 20 MB cap, `X-Content-Type-Options: nosniff` on `/uploads` |
| Logs | one line per request with a request id and the client IP (the real client only when `TRUST_PROXY` is set correctly); query strings, bodies, passwords and tokens are not logged |

### Alerts, analytics and transactions

**Alerts are rules the user sets; there are no defaults.** Six types: `low_balance`, `daily_spend_limit`, `monthly_spend_limit`,
`category_monthly_budget`, `bill_due_soon`, `over_safe_to_spend`. `over_safe_to_spend` compares today's spending with the
safe-to-spend figure the calculator produces, which is how "the app does the calculation" feeds the alerts.

- **When rules run.** `evaluateAlerts(userId)` (`services/alerts.js`) runs inside the request after anything the rules depend on
  changed (balance, next income, savings goal, bills, expenses, and saving a rule), and at the start of `GET /api/alerts`.
  The latter is what makes calendar-driven alerts (a bill coming due) appear with no background scheduler. It never throws:
  a failure is logged and the user's real action still succeeds. A user with no enabled rules costs one query.
- **Once per period.** Each alert has a `period_key`: the UTC day (low balance, daily limit, safe-to-spend), the UTC month
  (monthly limit, category budget) or the bill (`bill:<id>`). `INSERT ... ON CONFLICT (rule_id, period_key) DO NOTHING` makes
  that race-safe, so simultaneous requests create one alert. Consequence: changing a threshold after a rule fired does not fire
  it again the same day or month, and an alert is not withdrawn if the condition later clears (it is history).
- **Delivery.** New alerts are handed to `notifier.js` (`setNotifier`) once each. Nothing is wired in, so alerts are only
  visible by polling `GET /api/alerts` or the `unreadAlerts` count on the dashboard. Push or email goes in that hook.
- **Limits.** 50 rules per user; alerts are kept for 90 days.

**Editing and deleting expenses** use a transaction that locks the user's row first (`SELECT ... FOR UPDATE`) and then the
expense, the same order every balance-changing path uses, so concurrent edits, deletes and new expenses cannot deadlock,
overspend or refund twice. The balance is changed in SQL (`balance + old - new`), never computed in JavaScript, so there is
no floating-point drift.

**Analytics** is plain SQL aggregation over `expenses` for a range of UTC days (default last 30, at most 731), grouped by
`lower(category)` and by UTC day or month. Spending is not income-aware: it only covers recorded expenses.

### Known gaps (read before launch)

1. **Reset emails and alert notifications are not sent** (see above and the alerts section). Alerts are pull-only for now.
2. **CORS is a placeholder until `CORS_ORIGINS` is set.** Browsers may call the API only from the listed origins (default: a
   placeholder that matches nothing real). Requests with no `Origin` header (mobile apps, Postman, curl) are unaffected. Set it to
   the real frontend address before a web client launches.
3. **Security headers come from Helmet 8** (global, in `app.js`), with `Cross-Origin-Resource-Policy: cross-origin` so other sites
   can show uploaded files, and a separate, looser Content-Security-Policy on `/docs` only (Swagger UI loads from a CDN).
4. **Uploads are public by link.** On Cloudinary the address is hard to guess but not private; on local disk they also do not
   scale past one instance. Private files need Cloudinary authenticated delivery with signed links (not set up).
5. **Access tokens cannot be revoked** individually; the exposure window is `ACCESS_TOKEN_SECONDS`. Logout ends the refresh
   token only.
6. **HTTPS is not terminated by the app.** Put it behind a TLS-terminating proxy and set `TRUST_PROXY` correctly. Tokens
   travel in headers and bodies, so plain HTTP is not acceptable in production.
7. **No account deletion, email change or password change (while logged in) endpoints yet.** Password reset is the only way
   to change a password.
8. **Idempotency caches responses verbatim**, including tokens from login/register if a client sends the header there.
   Clients are told not to; the server does not enforce it.

### Deployment checklist (security-relevant)

- [ ] `NODE_ENV=production` and a long random `JWT_SECRET`
- [ ] `TRUST_PROXY` equals the number of proxies; HTTPS terminated in front
- [ ] `REDIS_URL` set when running more than one instance (otherwise rate limits and idempotency are per-process)
- [ ] `CORS_ORIGINS` set to the real frontend address (Helmet is already on)
- [ ] Email provider wired into `mailer.js`
- [ ] `npm run migrate` run for each release
- [ ] `CLOUDINARY_URL` set (or uploads directory on a persistent volume); migration 004 applied
