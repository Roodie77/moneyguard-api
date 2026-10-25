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
| Profile | `PUT /api/me` | yes | auth | edit name, phone, email (email needs the current password); wrong passwords count towards the failed-attempts limit |
| Profile | `PUT /api/me/password` | yes | auth | needs the current password; ends every other session and returns a fresh one for this device |
| Profile | `DELETE /api/me` | yes | auth | schedules deletion 24 hours ahead (202, `pending_deletion`); needs the current password |
| Profile | `POST /api/me/cancel-deletion` | yes | write | cancels a pending deletion; idempotent |
| Profile | `PUT`, `DELETE /api/me/avatar` | yes | write | profile picture (image, max 5 MB) kept on Cloudinary or on disk; the old one is deleted |
| Profile | `GET`, `PUT /api/financial-profile` | yes | read / write | the numbers typed into the calculators, saved per user (partial saves; defaults when nothing is saved) |
| Bills | `GET/POST /api/bills`, `PUT`, `DELETE /api/bills/:id` | yes | read / write | PUT edits only the fields sent; `dueDate: null` clears it |
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
| Calculators | `POST /api/assistant` | yes | ai (10/min) | AI assistant over the forecast; 503 without `ANTHROPIC_API_KEY`, 502 if the AI service fails |
| Calculators | `POST /api/forecast` | yes | calc | survival forecast (Monte Carlo); read-only, writes nothing |
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
| `name` | text | nullable (007); the display name, optional at sign-up and editable |
| `deletion_requested_at`, `deletes_at` | timestamptz | nullable (008); both set while the account is pending deletion, both null when active (a CHECK keeps them together). `deletes_at` is 24 hours after the request. Partial index on `deletes_at` |

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

### Survival forecast (`POST /api/forecast`)

"Safe to spend" divides the money left by the days left, an average that ignores how lumpy spending is. The forecast simulates the days until the next income and answers from the simulated futures. Code: `services/forecast.js` (pure maths, no database or clock) and `forecastFor()` in `services/budget.js` (loads the data).

1. **Learn the user's spending** (`fitSpendModel`): daily totals for up to 60 days (zero days included, from the first day we have any trace of the user until yesterday). A day is "no spending" with probability `p0`, otherwise log-normal (`mu`, `sigma`). The estimates are shrunk towards starting assumptions (a new user is assumed to spend 60% of their budget), with the assumptions worth a few pseudo-days, so a new user still gets a model and the user's own data takes over as days accumulate. `model.source` says which: `default`, `blended` (under 28 days), `history`.
2. **Simulate** (`simulateSurvival`): 10,000 paths over the days to the next income (capped at 90). Each day subtracts a random spend; each bill is subtracted on its due day (a bill with no or a past date is counted today, like safe-to-spend); bills on the income day itself still count. "Ruin" is the balance going under the savings reserve. Random numbers come from a seeded generator (seed = user id + UTC date), so the same call on the same day returns identical numbers.
3. **Read the answers off the futures:** `ruinProbability` is the share of paths that go under the reserve. `maxPurchaseNow` is the (1 - confidence) quantile of each path's slack (lowest balance minus reserve): the largest one-off purchase that keeps ruin at or under the chosen risk. With an `amount`, the purchase's own ruin probability, the worst-case shortfall (the mean shortfall in the worst 1 - confidence share, i.e. CVaR) and a verdict (Safe / ThinkTwice / NotRecommended). `ruinByDay` is the cumulative chance of having run out by each day.

Tests: `forecast-engine` checks the maths against hand-worked answers (a log-normal case with a known 50% and a known quantile), `forecast` and `forecast-scenarios` go through the API.

**Where it appears:** `GET /api/dashboard` returns `survival` and `POST /api/can-i-afford` returns `forecast` (the short form, `forecastBrief()`), alongside the older average-based numbers, which are unchanged. A simulation takes about 15 ms for a typical 10-day horizon (up to about 100 ms for the 90-day cap).

**Limits:** it only knows past behaviour, so it cannot foresee emergencies, and income is assumed to arrive at the next income date. Money outflows persist until then, so buying a few days later within the same period changes the risk very little; the useful alternatives are a smaller amount or waiting for the next income, which the summary says. The answer is an estimate and carries a disclaimer. Planned next: use it in the dashboard and `can-i-afford`, and a language-model layer that only explains and calls this engine (it never does the arithmetic).

### AI assistant (`POST /api/assistant`)

`services/assistant.js`. The rule is **the model talks, the code calculates**: language models make confident arithmetic mistakes, are not repeatable and cannot be unit-tested, so none of the maths is left to one.

1. The model (Anthropic Messages API through plain `fetch`; model from `ANTHROPIC_MODEL`, default `claude-haiku-5-5`) gets the user's question, a system prompt with the rules, and one tool, `forecast`. Up to 3 rounds: it calls the tool, `forecastFor()` runs the engine, the result goes back to it, it writes the answer.
2. **The tool result is the only source of numbers.** It contains the percentages already rounded for quoting, the largest safe purchase, the verdict, and the engine's own plain-language `summary`.
3. **The answer is checked** (`unverifiedNumbers`): every number in the reply must be in the tool results or in the user's own message (within rounding). If not, the reply is discarded and replaced with the engine's summary, and `replacedUnverifiedReply` is `true`. If the model never produced an answer, a fixed fallback is used.
4. **Privacy:** only the question and the forecast numbers leave the server; the model never sees the name, email, password hash or raw transactions. The only tool is read-only and works on the caller's own data, so an instruction hidden in a message cannot reach anyone else's data or change anything.
5. **Cost and failure:** a stricter limiter (10/min); 20 s timeout; any upstream failure becomes a 502 with a generic message (details only in the log); no key means 503. The driver sits behind `setAiDriver`, so the tests use a fake model and need no key or network.

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

### Account deletion

`DELETE /api/me` does not delete: `requestDeletion` sets `deletion_requested_at = now()` and `deletes_at = now() + 24h` (`COALESCE`, so asking again never moves the deadline) and the answer is a 202 with `accountStatus: pending_deletion`. The account keeps working; `publicUser()` adds `accountStatus` to every user object and `deletionInfo()` builds the notice (`requestedAt`, `deletesAt`, `message`) returned as `accountDeletion` by login, register and the dashboard. `POST /api/me/cancel-deletion` clears both columns.

Permanent deletion (`services/account.js`):

1. **`purgeAccount(id)`** runs in one transaction: `SELECT ... WHERE deletes_at <= now() FOR UPDATE` (so a cancel and a delete can never both win), then inserts the user's files and avatar into `storage_cleanup`, then `DELETE FROM users`. Every other table references `users(id) ON DELETE CASCADE`, so bills, expenses, files, alerts, rules, tokens, affordability checks, reset tokens and the financial profile go with it.
2. **`storage_cleanup`** (008) holds one row per uploaded file (Cloudinary `public_id` + `resource_type`, or the `local_name` on disk). It exists because the files are outside the database: they are queued in the same transaction as the account deletion, so they are never forgotten. `processStorageCleanup()` deletes them one by one (`storage.deleteAsset`, which throws on failure), removes the row on success, and on failure increments `attempts` and tries again on the next sweep, giving up (and logging an error) after 10 tries.
3. **`sweepDeletedAccounts()`** purges up to 100 due accounts and then runs the cleanup. `server.js` calls it once at start-up (anything that came due while the server was off or asleep) and every minute (`setInterval(...).unref()`). It is safe to run from several servers at once.
4. **Lazy enforcement:** the `/api` user loader and `/api/auth/login` check `isDue(user)` and call `purgeAccount` first, so an account past its deadline is refused (`401 Account not found`) immediately, even before the sweep runs. A cancel that arrives after the deadline therefore finds no account.

A wrong password on `DELETE /api/me` is a 400 naming `currentPassword` (never a 401) and shares the failed-attempts limiter with login.

**Limits to know:** the deletion happens inside the app process, so on a host that sleeps the process (Render's free plan) the data is removed when the server next starts; backups kept by the database host are not touched; during the grace period the account is fully usable and `/uploads` files remain reachable by link.

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
7. **Account deletion runs inside the server process** (see "Account deletion" above): on a sleeping host it happens at the next wake-up, and host-level backups are out of the app's control. Name, phone, email, password and deletion all take the current password; a wrong one is a 400 naming `currentPassword` (never a 401, which clients read as an expired token).
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
