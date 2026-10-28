# MoneyGuard Backend

**Author:** Jonathan Adewale

**Co-author:** Jonluis Paa Kojo Classpeter

**Collaborator:** Chioma Ikeh

**collaborator:** Festus Asembo

REST API for MoneyGuard: track balance, bills and expenses, get a daily "safe to spend" figure, see where the money goes (analytics),
set your own spending and balance alerts, and run affordability calculators (projected balance after a new EMI, loan affordability, cash-flow projection).

Node 20+, Express, PostgreSQL, JWT auth. Optional Redis for rate limits shared across instances.

**New to the API?** Start with [docs/API_GUIDE.md](docs/API_GUIDE.md), a plain-language walkthrough for frontend developers.

**Maintaining the backend?** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the API overview, database schema, and the authentication and security approach.

**API reference:** run the server and open [`/docs`](http://localhost:3000/docs) (Swagger UI), or read
[`src/docs/openapi.yaml`](src/docs/openapi.yaml). A test keeps that file in sync with the code.

## Features

- **Accounts and sessions:** register, log in, short-lived access tokens (1 hour) with rotating refresh tokens (7 days), log out, and password reset by emailed single-use token. Passwords are stored as bcrypt hashes.
- **Profile:** name, email, phone and password (all editable in the app; changing the email or password needs the current password), current balance, next expected income, savings goal, a profile picture, and the **calculator numbers** (monthly income, expenses, loan payments, interest rate, term), saved per user so the app can pre-fill its calculator screens again after logout and login.
- **Bills:** add, list and remove upcoming bills (they feed the safe-to-spend figure but do not change the balance).
- **Expenses (transactions):** record, list with filters and paging (date range, category, amount), edit and delete. Every change moves the balance atomically, and spending more than the balance is refused.
- **Safe to spend:** a daily figure worked out from the balance, upcoming bills, the savings goal and the days until the next income (`GET /api/dashboard`).
- **Analytics:** totals, average per day, spending per category and a per-day or per-month series for any range of up to 731 days.
- **Alerts:** rules the user sets themselves (low balance, daily limit, monthly limit, category budget, bill due soon, over today's safe-to-spend). Alerts are listed, marked read, and kept for 90 days.
- **Account deletion with a grace period:** `DELETE /api/me` (with the password) does not delete at once: it schedules deletion for **24 hours later** and says so (`accountStatus: pending_deletion`, `deletesAt`, a message to show). The account keeps working and can be cancelled. After the day the server deletes the profile, all its data and its uploaded files for good, automatically.
- **Calculators:** "can I afford this?", projected balance after a new EMI, month-by-month cash flow, and loan affordability.
- **Media uploads:** upload and list receipts, photos, PDFs and videos (up to 20 MB). They are kept on Cloudinary when `CLOUDINARY_URL` is set (so they survive redeploys), otherwise on the server's disk. Every file comes back with a `url` to open it.
- **Safety and reliability:** input validation on every write, per-IP rate limits, idempotency keys for safe retries, request ids in every response and log line, and a `/health` check. See [How it behaves](#how-it-behaves).
- **Security headers and CORS:** every response carries [Helmet](https://helmetjs.github.io/) 8's headers (Content-Security-Policy, Strict-Transport-Security, `X-Content-Type-Options`, `X-Frame-Options`, Referrer-Policy, and no `X-Powered-By`). Browsers may call the API only from the websites listed in `CORS_ORIGINS`. The `/docs` page has its own, looser policy so Swagger UI can load. Covered by `test/security-headers.test.js`.

Every endpoint is listed in [API endpoints](#api-endpoints), with a request and response example for each.

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
| `CORS_ORIGINS` | no | Websites allowed to call the API from a browser, separated by commas. Defaults to the placeholder `https://frontend-placeholder.example.com` until the frontend is ready. |

| `CLOUDINARY_URL` | no | Turns on Cloudinary storage for uploads: `cloudinary://API_KEY:API_SECRET@CLOUD_NAME`, copied from your Cloudinary dashboard. Keep it secret. Empty means files stay on the server's disk. |
| `OLLAMA_MODEL` | no | Turns on the AI assistant (`POST /api/assistant`): the name of an [Ollama](https://ollama.com) model that supports tool calling, such as `llama3.1`. Without it that endpoint answers 503 and everything else works. Only the user's question and the forecast numbers are sent to Ollama, never names, emails or passwords. |
| `OLLAMA_BASE_URL` | no | Where Ollama runs. Default `http://localhost:11434`. On a hosted API it must be a server the API can reach (a VPS or Ollama's cloud), not your own laptop. |
| `OLLAMA_API_KEY` | no | Only if that Ollama server needs a key (Ollama's cloud or a protected server). Keep it secret. |
| `OLLAMA_TIMEOUT_MS` | no | How long to wait for the model. Default 60000. |
| `CLOUDINARY_FOLDER` | no | Top-level Cloudinary folder. Default `moneyguard`; each user's files go in `<folder>/<userId>`. |
| `UPLOADS_DIR` | no | Where uploaded files are kept when Cloudinary is not used. Default `src/uploads`. Point it at a mounted disk that survives deploys. (The tests give each test its own folder with it.) |

**Setting the frontend origin (CORS):** the API only accepts browser requests from the origins listed in `CORS_ORIGINS`. Until the frontend exists this is a placeholder, so every real website is blocked. To allow the real frontend, put its address in `CORS_ORIGINS` in your `.env` file when running locally, or in your host's environment variables in production (on Render, the service's *Environment* tab), then restart the server. Write the full address with `https://` and no trailing slash, and separate several addresses with commas. Mobile apps, Postman and curl are not affected by CORS.

**Setting up Cloudinary (media uploads):** by default uploaded images, PDFs and videos are saved on the server's disk, which Render wipes on every deploy. To keep them on [Cloudinary](https://cloudinary.com) instead:

1. Create a free Cloudinary account and copy your API credentials from its dashboard.
2. Put them in `.env` (locally) or in the host's environment variables (on Render), as one line with no quotes and no spaces around the `=`: `CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME`. Never commit it.
3. Run `npm run migrate` once (migration 004 adds the columns that remember each file's link), then restart the server. A restart is needed because `.env` is only read at start-up.
4. Upload with `POST /api/files` (see the Files examples below). The answer has a `url`: open it in a browser or use it as an image or video source. The file also appears in your Cloudinary Media Library under `moneyguard/<userId>/`; change the top folder with `CLOUDINARY_FOLDER`.

Without `CLOUDINARY_URL` nothing changes: files stay on disk. Cloudinary links are hard to guess but not private, and Cloudinary may block opening PDFs until you allow it in its security settings.

## API endpoints

Base URL (local): `http://localhost:3000`. Every endpoint below except the ones marked **Public** needs the header `Authorization: Bearer <access token>`.
The interactive reference is at `/docs` (Swagger UI) and the contract is [`src/docs/openapi.yaml`](src/docs/openapi.yaml).

| Area | Method and path | Auth | What it does |
|---|---|---|---|
| Platform | `GET /health` | Public | Liveness and database check |
| Auth | `POST /api/auth/register` | Public | Create an account; returns an access token and a refresh token |
| Auth | `POST /api/auth/login` | Public | Log in |
| Auth | `POST /api/auth/refresh` | Public | Swap a refresh token for a new access token and a new refresh token |
| Auth | `POST /api/auth/logout` | Public | Revoke a refresh token |
| Auth | `POST /api/auth/forgot-password` | Public | Email a single-use password reset token |
| Auth | `POST /api/auth/reset-password` | Public | Set a new password with the emailed token |
| Profile | `GET /api/me` | Yes | The signed-in user |
| Profile | `PUT /api/me` | Yes | Edit name, phone or email (changing the email needs the current password) |
| Profile | `PUT /api/me/password` | Yes | Change the password (needs the current password). Ends every other login and returns a fresh session for this device |
| Profile | `DELETE /api/me` | Yes | Delete the account **after a 24-hour grace period** (needs the current password). Answers 202 "pending" with the deadline |
| Profile | `POST /api/me/cancel-deletion` | Yes | Cancel a pending deletion during the grace period |
| Profile | `PUT /api/balance` | Yes | Set the current balance |
| Profile | `PUT /api/next-income` | Yes | Set the next expected income and date |
| Profile | `PUT /api/savings-goal` | Yes | Set a savings goal and deadline |
| Profile | `GET /api/financial-profile`, `PUT /api/financial-profile` | Yes | Load and save the numbers typed into the calculators, so they are not asked for again after login |
| Profile | `PUT /api/me/avatar`, `DELETE /api/me/avatar` | Yes | Set, replace or remove the profile picture (an image, at most 5 MB). The link is `avatarUrl` on `/api/me` |
| Bills | `GET /api/bills`, `POST /api/bills`, `PUT /api/bills/:id`, `DELETE /api/bills/:id` | Yes | List, add, edit, remove bills |
| Expenses | `GET /api/expenses` | Yes | List with filters and paging |
| Expenses | `POST /api/expenses` | Yes | Record an expense (refused with 422 if it exceeds the balance) |
| Expenses | `PUT /api/expenses/:id`, `DELETE /api/expenses/:id` | Yes | Edit or delete; the balance moves with it |
| Files | `POST /api/files`, `GET /api/files`, `GET /uploads/:filename` | Yes / Yes / Public link | Upload and list files. Each file comes back with a `url` to open it (a Cloudinary link, or `/uploads/...` when kept on the server's disk). `/uploads/:filename` exists only for disk-kept files |
| Dashboard | `GET /api/dashboard` | Yes | Balance, safe-to-spend, recent expenses, unread alert count |
| Calculators | `POST /api/can-i-afford` | Yes | Can I afford this purchase today? |
| Calculators | `POST /api/assistant` | Yes | **AI assistant:** ask in plain words ("Can I afford a 40000 phone?"). It calls the survival forecast for the numbers (it never calculates) and every number in its reply is checked against the forecast. 10 calls a minute |
| Calculators | `POST /api/forecast` | Yes | **Survival forecast:** the chance your money lasts until the next income, the largest purchase that keeps that chance under your chosen risk, and the chance for a specific purchase. Simulated from your own spending history |
| Calculators | `POST /api/projected-balance`, `/api/cash-flow`, `/api/affordability` | Yes | EMI, cash-flow and loan affordability maths |
| Analytics | `GET /api/analytics/summary` | Yes | Totals, per category, per day or month |
| Alerts | `GET /api/alert-rules`, `PUT /api/alert-rules`, `DELETE /api/alert-rules/:id` | Yes | The user's own thresholds |
| Alerts | `GET /api/alerts`, `POST /api/alerts/:id/read`, `POST /api/alerts/read-all` | Yes | See and clear alerts |

### Testing with Postman

1. Start the server (`npm run dev`) and create a Postman **environment** with three variables:

   | Variable | Value |
   |---|---|
   | `baseUrl` | `http://localhost:3000` |
   | `token` | _(leave empty; the script below fills it in)_ |
   | `refreshToken` | _(leave empty)_ |

2. On the **Register**, **Log in** and **Refresh** requests, add this to the **Scripts → Post-response** tab so the tokens are saved automatically:

   ```js
   const res = pm.response.json();
   if (res.token) pm.environment.set("token", res.token);
   if (res.refreshToken) pm.environment.set("refreshToken", res.refreshToken);
   ```

3. For every protected request, set **Authorization → Bearer Token** to `{{token}}` (or set it once on the collection and inherit it).
4. Access tokens last 1 hour. When a request returns `401`, run **Refresh** (which sends `{ "refreshToken": "{{refreshToken}}" }`) and retry. A refresh token works once, so always keep the newest one.
5. Send `Idempotency-Key: <any unique string>` on POST/PUT/DELETE if you want a retry to be safe from duplicates. Do not send it on login, register or refresh.

### Examples

Everything below was produced by running the real server against an empty database and calling each endpoint in order, so the
responses are exactly what the API returns. Your ids, timestamps and tokens will differ, and long tokens are shortened here.
Money values are plain numbers; days and months are UTC. Each group is collapsed: click it to open.

### Platform

<details>
<summary>Show 1 example</summary>

#### P1. Health check

```http
GET {{baseUrl}}/health
```

**Response: `200 OK`**

```json
{
  "status": "ok",
  "database": "connected",
  "redis": "memory"
}
```

</details>

### Auth

<details>
<summary>Show 11 examples</summary>

#### A1. Register a new user

```http
POST {{baseUrl}}/api/auth/register
```

**Headers / body type:** `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "email": "jonathan@example.com",
  "password": "StrongPass123",
  "phone": "+234 801 234 5678"
}
```

**Response: `201 Created`**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ...",
  "expiresIn": 3600,
  "refreshToken": "vQrTa5TCI-LvX90hBjUhUxNF8XwKzecMWqaOxINBlB0",
  "user": {
    "id": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "email": "jonathan@example.com",
    "phone": "+234 801 234 5678",
    "balance": 0,
    "nextIncomeAmount": 0,
    "nextIncomeDate": null,
    "savingsGoalAmount": 0,
    "savingsGoalDeadline": null,
    "createdAt": "2026-10-22T21:54:24.649Z"
  }
}
```

> Save `token` as the Postman variable `{{token}}` and `refreshToken` as `{{refreshToken}}`. The password is never returned.

#### A2. Register with an email that already exists

```http
POST {{baseUrl}}/api/auth/register
```

**Headers / body type:** `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "email": "jonathan@example.com",
  "password": "StrongPass123"
}
```

**Response: `409 Conflict`**

```json
{
  "error": "Email already registered"
}
```

#### A3. Register with invalid input

```http
POST {{baseUrl}}/api/auth/register
```

**Headers / body type:** `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "email": "not-an-email",
  "password": "short"
}
```

**Response: `400 Bad Request`**

```json
{
  "error": "Validation failed",
  "details": [
    {
      "field": "email",
      "message": "email must be a valid email"
    },
    {
      "field": "password",
      "message": "password length must be at least 8 characters long"
    }
  ]
}
```

> Every validation error names the field, so the app can show it under the right input.

#### A4. Log in

```http
POST {{baseUrl}}/api/auth/login
```

**Headers / body type:** `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "email": "jonathan@example.com",
  "password": "StrongPass123"
}
```

**Response: `200 OK`**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ...",
  "expiresIn": 3600,
  "refreshToken": "B18HsISMEMNXOfEZ3SvnRCuJfwxby9P2hkfgIn6LtNw",
  "user": {
    "id": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "email": "jonathan@example.com",
    "phone": "+234 801 234 5678",
    "balance": 0,
    "nextIncomeAmount": 0,
    "nextIncomeDate": null,
    "savingsGoalAmount": 0,
    "savingsGoalDeadline": null,
    "createdAt": "2026-10-22T21:54:24.649Z"
  }
}
```

#### A5. Log in with the wrong password

```http
POST {{baseUrl}}/api/auth/login
```

**Headers / body type:** `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "email": "jonathan@example.com",
  "password": "WrongPass999"
}
```

**Response: `401 Unauthorized`**

```json
{
  "error": "Invalid credentials"
}
```

> An unknown email gives the same response, so the endpoint cannot be used to find out who has an account.

#### A6. Refresh the access token

```http
POST {{baseUrl}}/api/auth/refresh
```

**Headers / body type:** `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "refreshToken": "B18HsISMEMNXOfEZ3SvnRCuJfwxby9P2hkfgIn6LtNw"
}
```

**Response: `200 OK`**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ...",
  "expiresIn": 3600,
  "refreshToken": "eMNfgSVlKxKSjN2Cgmxq2kMfSIR14WC-GaRxf_fbP-U"
}
```

> A refresh token works **once**. Always store the new `refreshToken` from this response and discard the old one.

#### A7. Refresh with a refresh token that was already used

```http
POST {{baseUrl}}/api/auth/refresh
```

**Headers / body type:** `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "refreshToken": "B18HsISMEMNXOfEZ3SvnRCuJfwxby9P2hkfgIn6LtNw"
}
```

**Response: `401 Unauthorized`**

```json
{
  "error": "Invalid or expired refresh token"
}
```

> Reusing a spent token is treated as theft: the whole login (every token from it) is revoked.

#### A8. Request a password reset

```http
POST {{baseUrl}}/api/auth/forgot-password
```

**Headers / body type:** `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "email": "ada@example.com"
}
```

**Response: `200 OK`**

```json
{
  "message": "If that email has an account, a password reset link is on its way."
}
```

> The answer is the same whether or not the email has an account. The reset token is sent by email (not returned here) and works once for 60 minutes.

#### A9. Reset the password with the emailed token

```http
POST {{baseUrl}}/api/auth/reset-password
```

**Headers / body type:** `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "token": "77nWe2-GY7S2AIZvPcsiYNZCAFUMt-H7L5rwmYd5VXA",
  "password": "NewPassword456"
}
```

**Response: `200 OK`**

```json
{
  "ok": true
}
```

> This signs the user out everywhere: all refresh tokens are revoked and older access tokens stop working.

#### A10. Reset with a token that was already used

```http
POST {{baseUrl}}/api/auth/reset-password
```

**Headers / body type:** `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "token": "77nWe2-GY7S2AIZvPcsiYNZCAFUMt-H7L5rwmYd5VXA",
  "password": "AnotherPass789"
}
```

**Response: `400 Bad Request`**

```json
{
  "error": "Invalid or expired reset token"
}
```

#### A11. Log out

```http
POST {{baseUrl}}/api/auth/logout
```

**Headers / body type:** `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "refreshToken": "vE24mRYNf1p61oIJdi2NLIV5GpJmp37DB7IOshENSDE"
}
```

**Response: `200 OK`**

```json
{
  "ok": true
}
```

> Revokes the refresh token and everything issued from the same login. Delete the stored tokens on the device afterwards.

</details>

### Profile

<details>
<summary>Show 17 examples</summary>

#### P1. Call a protected endpoint without a token

```http
GET {{baseUrl}}/api/me
```

**Response: `401 Unauthorized`**

```json
{
  "error": "Missing or invalid token"
}
```

#### P2. Get my profile

```http
GET {{baseUrl}}/api/me
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "id": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "email": "jonathan@example.com",
  "phone": "+234 801 234 5678",
  "balance": 0,
  "nextIncomeAmount": 0,
  "nextIncomeDate": null,
  "savingsGoalAmount": 0,
  "savingsGoalDeadline": null,
  "createdAt": "2026-10-22T21:54:24.649Z"
}
```

#### P3. Set the current balance

```http
PUT {{baseUrl}}/api/balance
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "balance": 150000
}
```

**Response: `200 OK`**

```json
{
  "balance": 150000
}
```

> This **replaces** the balance; it does not add to it.

#### P4. Set the next expected income

```http
PUT {{baseUrl}}/api/next-income
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "amount": 250000,
  "date": "2026-11-30"
}
```

**Response: `200 OK`**

```json
{
  "nextIncomeAmount": 250000,
  "nextIncomeDate": "2026-11-30T00:00:00.000Z"
}
```

#### P5. Set a savings goal

```http
PUT {{baseUrl}}/api/savings-goal
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "amount": 100000,
  "deadline": "2027-03-31"
}
```

**Response: `200 OK`**

```json
{
  "savingsGoalAmount": 100000,
  "savingsGoalDeadline": "2027-03-31T00:00:00.000Z"
}
```

#### P6. Set a balance that is not allowed

```http
PUT {{baseUrl}}/api/balance
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "balance": -50
}
```

**Response: `400 Bad Request`**

```json
{
  "error": "Validation failed",
  "details": [
    {
      "field": "balance",
      "message": "balance must be greater than or equal to 0"
    }
  ]
}
```

#### P7. Get the saved calculator numbers

```http
GET {{baseUrl}}/api/financial-profile
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`** (nothing saved yet: the defaults come back and `updatedAt` is `null`)

```json
{
  "monthlyIncome": 0,
  "monthlyExpenses": 0,
  "existingDebtPayments": 0,
  "proposedPayment": 0,
  "targetDtiRatio": 0.4,
  "annualInterestRate": 0,
  "loanTermMonths": 12,
  "updatedAt": null
}
```

> Call this right after login and pre-fill the calculator screens with it. It is never a 404.

#### P8. Save the calculator numbers

```http
PUT {{baseUrl}}/api/financial-profile
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "monthlyIncome": 400000,
  "monthlyExpenses": 150000,
  "existingDebtPayments": 30000,
  "proposedPayment": 50000,
  "targetDtiRatio": 0.4,
  "annualInterestRate": 0.18,
  "loanTermMonths": 24
}
```

**Response: `200 OK`**

```json
{
  "monthlyIncome": 400000,
  "monthlyExpenses": 150000,
  "existingDebtPayments": 30000,
  "proposedPayment": 50000,
  "targetDtiRatio": 0.4,
  "annualInterestRate": 0.18,
  "loanTermMonths": 24,
  "updatedAt": "2026-10-24T22:21:56.672Z"
}
```

> Send only the fields that changed (at least one); the others keep their saved value. After a logout and login, **P7** returns exactly these numbers. How the fields map onto the calculators: `monthlyIncome` = `monthlyIncome` / `monthlyGrossIncome`, `monthlyExpenses` = `ordinaryExpenses` / `otherMonthlyExpenses`, `existingDebtPayments` = `existingEMI` / `existingMonthlyDebtPayments`, `proposedPayment` = `proposedEMI` / `monthlyPayment` / `proposedMonthlyPayment`. The other three keep their names.

#### P9. Save an invalid number

```http
PUT {{baseUrl}}/api/financial-profile
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "annualInterestRate": 18
}
```

**Response: `400 Bad Request`**

```json
{
  "error": "Validation failed",
  "details": [
    {
      "field": "annualInterestRate",
      "message": "annualInterestRate is a fraction, e.g. 0.12 for 12%"
    }
  ]
}
```

#### P10. Set or replace the profile picture

```http
PUT {{baseUrl}}/api/me/avatar
```

**Headers / body type:** `Authorization: Bearer {{token}}` · Body type `form-data`: key `avatar` (type File) = `me.png`

**Response: `200 OK`**

```json
{
  "avatarUrl": "https://res.cloudinary.com/your-cloud/image/upload/v1/moneyguard/10133380-4bf5-4cf3-b93f-2146b1e6113e/avatar/abc123.png"
}
```

> The form field must be named `avatar` (not `file`). JPEG, PNG, WebP or GIF, at most 5 MB. Without `CLOUDINARY_URL` the link is a path on the server instead (`/uploads/....png`), so put the server's address in front. The old picture is deleted. The same link is `avatarUrl` on `GET /api/me` and in the login answer. Wrong type or too big gives a `400` with a clear message.

#### P11. Remove the profile picture

```http
DELETE {{baseUrl}}/api/me/avatar
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "avatarUrl": null
}
```

#### P12. Edit my name and phone

```http
PUT {{baseUrl}}/api/me
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "name": "Jonathan A. Adewale",
  "phone": "08012345678"
}
```

**Response: `200 OK`** (the updated user)

```json
{
  "id": "f1682885-5981-4810-8d0e-588c00bcca2f",
  "email": "jonathan@example.com",
  "phone": "08012345678",
  "balance": 0,
  "nextIncomeAmount": 0,
  "nextIncomeDate": null,
  "savingsGoalAmount": 0,
  "savingsGoalDeadline": null,
  "createdAt": "2026-10-24T22:49:52.536Z",
  "avatarUrl": null,
  "name": "Jonathan A. Adewale"
}
```

> Send only what changed (at least one field). `null` or an empty text clears the name or phone. Nothing else on the account can be changed here. `name` can also be sent when registering (optional).

#### P13. Change my email (needs the current password)

```http
PUT {{baseUrl}}/api/me
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "email": "new@example.com",
  "currentPassword": "WrongPass999"
}
```

**Response: `400 Bad Request`**

```json
{
  "error": "Validation failed",
  "details": [
    {
      "field": "currentPassword",
      "message": "Current password is incorrect"
    }
  ]
}
```

> With the right password the answer is `200` and the updated user. Leaving `currentPassword` out gives a `400` on the same field, and an email another account already uses gives `409`. A wrong password is a **400, not a 401**, so apps do not mistake it for an expired login. Wrong guesses count towards the limit of 8 failed attempts per 15 minutes.

#### P14. Change my password

```http
PUT {{baseUrl}}/api/me/password
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "currentPassword": "StrongPass123",
  "newPassword": "EvenStronger456"
}
```

**Response: `200 OK`**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ...",
  "expiresIn": 3600,
  "refreshToken": "8VM8zrCm5Qecy_cDkb9KbDB02SRcIjaV6et7zJ6__48"
}
```

> **Replace the stored tokens with these.** The password change ends every other login (all refresh tokens and older access tokens), including the one used for this request, so the old tokens stop working. The new password follows the usual rules (8 characters or more, at most 72 bytes) and must differ from the current one.

#### P15. Delete my account: wrong password

```http
DELETE {{baseUrl}}/api/me
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "currentPassword": "WrongPass999"
}
```

**Response: `400 Bad Request`**

```json
{
  "error": "Validation failed",
  "details": [
    {
      "field": "currentPassword",
      "message": "Current password is incorrect"
    }
  ]
}
```

> The password goes in the JSON body (fetch, axios `{ data }` and Thunder Client all support a body on DELETE). A wrong password is a **400, not a 401**, and counts towards the limit of 8 failed attempts per 15 minutes.

#### P16. Delete my account (pending for 24 hours)

```http
DELETE {{baseUrl}}/api/me
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "currentPassword": "StrongPass123"
}
```

**Response: `202 Accepted`**

```json
{
  "accountStatus": "pending_deletion",
  "graceHours": 24,
  "requestedAt": "2026-10-25T14:04:40.795Z",
  "deletesAt": "2026-10-26T14:04:40.795Z",
  "message": "This account is scheduled for permanent deletion at 2026-10-26T14:04:40.795Z (UTC). Until then you can cancel and nothing is lost. After that, your profile and all your data are removed and cannot be recovered."
}
```

> **Nothing is deleted yet.** The account keeps working for 24 hours. While pending, `GET /api/me` returns `"accountStatus": "pending_deletion"` with `deletionRequestedAt` and `deletesAt`, `GET /api/dashboard` returns `accountDeletion` (`requestedAt`, `deletesAt`, `message`, or `null` when active), and the login and register answers carry the same `accountDeletion` notice, so every screen can show a banner. Asking again does not move the deadline. When the day is over the profile, all its data and its uploaded files are deleted permanently and automatically; after that the old token gets `401 Account not found` and the email can be registered again.

#### P17. Cancel the deletion

```http
POST {{baseUrl}}/api/me/cancel-deletion
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "accountStatus": "active",
  "requestedAt": null,
  "deletesAt": null,
  "message": "Account deletion cancelled. Your account and all your data are unchanged.",
  "user": { "id": "9d8dcef0-7f2b-460f-b3fa-115770f23a74", "email": "jonathan@example.com", "accountStatus": "active", "deletesAt": null, "...": "the rest of the user" }
}
```

> Safe to repeat. Nothing is lost by cancelling. Once the 24 hours are over the account is already gone and this answers `401`.

</details>

### Bills

<details>
<summary>Show 4 examples</summary>

#### B1. Add a bill

```http
POST {{baseUrl}}/api/bills
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "name": "Rent",
  "amount": 80000,
  "dueDate": "2026-11-01"
}
```

**Response: `201 Created`**

```json
{
  "id": "605d2165-6568-4253-a388-cb0965715acd",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "name": "Rent",
  "amount": 80000,
  "dueDate": "2026-11-01T00:00:00.000Z",
  "createdAt": "2026-10-22T21:54:25.163Z"
}
```

#### B2. List my bills

```http
GET {{baseUrl}}/api/bills
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
[
  {
    "id": "605d2165-6568-4253-a388-cb0965715acd",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "name": "Rent",
    "amount": 80000,
    "dueDate": "2026-11-01T00:00:00.000Z",
    "createdAt": "2026-10-22T21:54:25.163Z"
  },
  {
    "id": "5733818a-cc97-4849-a7a6-89d7342aac31",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "name": "Internet",
    "amount": 15000,
    "dueDate": "2026-10-28T00:00:00.000Z",
    "createdAt": "2026-10-22T21:54:25.166Z"
  },
  {
    "id": "73e63991-30be-4587-a613-33bb5e733ba1",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "name": "Gym",
    "amount": 10000,
    "dueDate": null,
    "createdAt": "2026-10-22T21:54:25.169Z"
  }
]
```

> Bills do **not** reduce the balance. They are only counted when working out what is safe to spend.

#### B3. Delete a bill

```http
DELETE {{baseUrl}}/api/bills/73e63991-30be-4587-a613-33bb5e733ba1
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "ok": true
}
```

#### B4. Delete a bill that does not exist

```http
DELETE {{baseUrl}}/api/bills/73e63991-30be-4587-a613-33bb5e733ba1
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `404 Not Found`**

```json
{
  "error": "Bill not found"
}
```

</details>

### Expenses

<details>
<summary>Show 9 examples</summary>

#### E1. Record an expense

```http
POST {{baseUrl}}/api/expenses
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "amount": 4500,
  "category": "Food",
  "description": "Lunch at Mama Put"
}
```

**Response: `201 Created`**

```json
{
  "id": "bedf30f7-8635-4c2b-aef1-1099c3bf9848",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "amount": 4500,
  "category": "Food",
  "description": "Lunch at Mama Put",
  "date": "2026-10-22T21:54:25.177Z",
  "createdAt": "2026-10-22T21:54:25.179Z"
}
```

> Also reduces the balance by the amount, in one atomic step. `date` defaults to now.

#### E2. Record another expense

```http
POST {{baseUrl}}/api/expenses
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "amount": 2500,
  "category": "Transport",
  "description": "Bolt to work",
  "date": "2026-10-20T08:30:00Z"
}
```

**Response: `201 Created`**

```json
{
  "id": "d6d32d21-b77c-41cc-9053-c83ef9c576ad",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "amount": 2500,
  "category": "Transport",
  "description": "Bolt to work",
  "date": "2026-10-20T08:30:00.000Z",
  "createdAt": "2026-10-22T21:54:25.183Z"
}
```

#### E3. Record an expense larger than the balance

```http
POST {{baseUrl}}/api/expenses
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "amount": 9999999,
  "category": "Shopping"
}
```

**Response: `422 Unprocessable Entity`**

```json
{
  "error": "Insufficient balance"
}
```

> Nothing is recorded and the balance is unchanged, even if many requests arrive at once.

#### E4. Record an invalid expense

```http
POST {{baseUrl}}/api/expenses
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "amount": 0,
  "date": "yesterday"
}
```

**Response: `400 Bad Request`**

```json
{
  "error": "Validation failed",
  "details": [
    {
      "field": "amount",
      "message": "amount must be greater than or equal to 0.01"
    },
    {
      "field": "date",
      "message": "date must be an ISO 8601 date, e.g. 2026-12-01 or 2026-12-01T09:00:00Z"
    }
  ]
}
```

#### E5. List my expenses

```http
GET {{baseUrl}}/api/expenses
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`** (header `X-Total-Count: 3`)

```json
[
  {
    "id": "5ccb45c4-a29a-40dd-9d4b-fd134cb14789",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "amount": 18000,
    "category": "food",
    "description": "Groceries",
    "date": "2026-10-22T21:54:25.185Z",
    "createdAt": "2026-10-22T21:54:25.186Z"
  },
  {
    "id": "bedf30f7-8635-4c2b-aef1-1099c3bf9848",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "amount": 4500,
    "category": "Food",
    "description": "Lunch at Mama Put",
    "date": "2026-10-22T21:54:25.177Z",
    "createdAt": "2026-10-22T21:54:25.179Z"
  },
  {
    "id": "d6d32d21-b77c-41cc-9053-c83ef9c576ad",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "amount": 2500,
    "category": "Transport",
    "description": "Bolt to work",
    "date": "2026-10-20T08:30:00.000Z",
    "createdAt": "2026-10-22T21:54:25.183Z"
  }
]
```

> Newest first. The `X-Total-Count` response header is the number of matches across all pages (here shown below the response).

#### E6. Filter and page the expense list

```http
GET {{baseUrl}}/api/expenses?category=food&from=2026-10-01&to=2026-10-31&minAmount=1000&limit=10&offset=0
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`** (header `X-Total-Count: 2`)

```json
[
  {
    "id": "5ccb45c4-a29a-40dd-9d4b-fd134cb14789",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "amount": 18000,
    "category": "food",
    "description": "Groceries",
    "date": "2026-10-22T21:54:25.185Z",
    "createdAt": "2026-10-22T21:54:25.186Z"
  },
  {
    "id": "bedf30f7-8635-4c2b-aef1-1099c3bf9848",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "amount": 4500,
    "category": "Food",
    "description": "Lunch at Mama Put",
    "date": "2026-10-22T21:54:25.177Z",
    "createdAt": "2026-10-22T21:54:25.179Z"
  }
]
```

> Filters: `from`, `to` (whole UTC days), `category` (any letter case), `minAmount`, `maxAmount`. Paging: `limit` (default 100, max 500) and `offset`.

#### E7. Edit an expense

```http
PUT {{baseUrl}}/api/expenses/bedf30f7-8635-4c2b-aef1-1099c3bf9848
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "amount": 5000,
  "description": "Lunch and a drink"
}
```

**Response: `200 OK`**

```json
{
  "id": "bedf30f7-8635-4c2b-aef1-1099c3bf9848",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "amount": 5000,
  "category": "Food",
  "description": "Lunch and a drink",
  "date": "2026-10-22T21:54:25.177Z",
  "createdAt": "2026-10-22T21:54:25.179Z"
}
```

> Send only the fields to change. The balance moves by the difference (here 500 more is taken).

#### E8. Edit an expense to more than the balance allows

```http
PUT {{baseUrl}}/api/expenses/bedf30f7-8635-4c2b-aef1-1099c3bf9848
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "amount": 9999999
}
```

**Response: `422 Unprocessable Entity`**

```json
{
  "error": "Insufficient balance"
}
```

#### E9. Delete an expense

```http
DELETE {{baseUrl}}/api/expenses/d6d32d21-b77c-41cc-9053-c83ef9c576ad
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "ok": true,
  "balance": 127000
}
```

> The amount is added back to the balance; the response shows the new balance.

</details>

### Files

<details>
<summary>Show 3 examples</summary>

#### F1. Upload a file

```http
POST {{baseUrl}}/api/files
```

**Headers / body type:** `Authorization: Bearer {{token}}` · Body type `form-data`: key `file` (type File) = `receipt.png`

**Response: `201 Created`**

```json
{
  "id": "8a503c4b-245c-4c2d-ad05-0cd5154b976e",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "filename": "0922107c-f9c1-4217-8c43-e08c739ae12b.png",
  "originalName": "receipt.png",
  "mimetype": "image/png",
  "size": 70,
  "url": "/uploads/0922107c-f9c1-4217-8c43-e08c739ae12b.png",
  "publicId": null,
  "resourceType": null,
  "createdAt": "2026-10-22T21:54:25.378Z"
}
```

With `CLOUDINARY_URL` set, the same request returns a Cloudinary link instead (your cloud name replaces `your-cloud`):

```json
{
  "id": "8a503c4b-245c-4c2d-ad05-0cd5154b976e",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "filename": "x0utrce9vdoyllonl6fd",
  "originalName": "receipt.png",
  "mimetype": "image/png",
  "size": 70,
  "url": "https://res.cloudinary.com/your-cloud/image/upload/v1792870628/moneyguard/10133380-4bf5-4cf3-b93f-2146b1e6113e/x0utrce9vdoyllonl6fd.png",
  "publicId": "moneyguard/10133380-4bf5-4cf3-b93f-2146b1e6113e/x0utrce9vdoyllonl6fd",
  "resourceType": "image",
  "createdAt": "2026-10-22T21:54:25.378Z"
}
```

> Send `multipart/form-data` with a single field named `file`. Allowed: JPEG, PNG, WebP, GIF, PDF, MP4, MOV, WebM. Maximum 20 MB. Open the file by its `url`: if it starts with `http` use it as it is, otherwise put the server's address in front of it.

#### F2. List my files

```http
GET {{baseUrl}}/api/files
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
[
  {
    "id": "8a503c4b-245c-4c2d-ad05-0cd5154b976e",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "filename": "0922107c-f9c1-4217-8c43-e08c739ae12b.png",
    "originalName": "receipt.png",
    "mimetype": "image/png",
    "size": 70,
    "url": "/uploads/0922107c-f9c1-4217-8c43-e08c739ae12b.png",
    "publicId": null,
    "resourceType": null,
    "createdAt": "2026-10-22T21:54:25.378Z"
  }
]
```

#### F3. Open an uploaded file

```http
GET {{baseUrl}}/uploads/0922107c-f9c1-4217-8c43-e08c739ae12b.png
```

**Response: `200 OK`**

_The file contents (an image in this example)._

> Returns the file itself. Only used for files kept on the server's disk; files on Cloudinary are opened by their own `url`. The link is public to anyone who has it, so do not treat it as private storage.

</details>

### Dashboard

<details>
<summary>Show 1 example</summary>

#### D1. Home screen data

```http
GET {{baseUrl}}/api/dashboard
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "user": {
    "balance": 127000,
    "nextIncomeAmount": 250000,
    "nextIncomeDate": "2026-11-30T00:00:00.000Z",
    "savingsGoalAmount": 100000
  },
  "safeToSpend": {
    "dailySafeToSpend": 179.49,
    "remainingToday": -22820.51,
    "daysUntilNextIncome": 39,
    "upcomingBillsTotal": 95000,
    "savingsReserve": 25000,
    "availableAfterCommitments": 7000,
    "spentToday": 23000,
    "warnings": [
      "Already over today's safe amount."
    ]
  },
  "recentExpenses": [
    {
      "id": "5ccb45c4-a29a-40dd-9d4b-fd134cb14789",
      "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
      "amount": 18000,
      "category": "food",
      "description": "Groceries",
      "date": "2026-10-22T21:54:25.185Z",
      "createdAt": "2026-10-22T21:54:25.186Z"
    },
    {
      "id": "bedf30f7-8635-4c2b-aef1-1099c3bf9848",
      "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
      "amount": 5000,
      "category": "Food",
      "description": "Lunch and a drink",
      "date": "2026-10-22T21:54:25.177Z",
      "createdAt": "2026-10-22T21:54:25.179Z"
    }
  ],
  "unreadAlerts": 0
}
```

> `remainingToday` below zero means the user is over today's safe amount. `unreadAlerts` is the number for the notification badge.

</details>

### Calculators

<details>
<summary>Show 4 examples</summary>

#### C1. Can I afford this purchase?

```http
POST {{baseUrl}}/api/can-i-afford
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "amount": 20000
}
```

**Response: `200 OK`**

```json
{
  "recommendation": "NotRecommended",
  "reason": "This is well above your safe daily amount.",
  "explanation": "This is well above your safe daily amount. After this you would have about 107000 left.",
  "remainingAfterPurchase": -42820.51,
  "cashFlowWarnings": [],
  "safeToSpend": {
    "dailySafeToSpend": 179.49,
    "remainingToday": -22820.51,
    "daysUntilNextIncome": 39,
    "upcomingBillsTotal": 95000,
    "savingsReserve": 25000,
    "availableAfterCommitments": 7000,
    "spentToday": 23000,
    "warnings": [
      "Already over today's safe amount."
    ]
  }
}
```

> `recommendation` is `Safe`, `ThinkTwice` or `NotRecommended`. Nothing is spent.

#### C2. Projected balance after a new EMI

```http
POST {{baseUrl}}/api/projected-balance
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "monthlyIncome": 450000,
  "ordinaryExpenses": 180000,
  "existingEMI": 35000,
  "proposedEMI": 50000
}
```

**Response: `200 OK`**

```json
{
  "monthlyIncome": 450000,
  "ordinaryExpenses": 180000,
  "existingEMI": 35000,
  "proposedEMI": 50000,
  "projectedBalance": 185000,
  "shortfall": 0,
  "isNegative": false,
  "warning": null
}
```

#### C3. Cash-flow projection

```http
POST {{baseUrl}}/api/cash-flow
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "monthlyGrossIncome": 300000,
  "otherMonthlyExpenses": 150000,
  "existingMonthlyDebtPayments": 40000,
  "monthlyPayment": 60000,
  "startingCashBalance": 50000,
  "months": 4
}
```

**Response: `200 OK`**

```json
{
  "projection": [
    {
      "month": 1,
      "startingBalance": 50000,
      "income": 300000,
      "debtPayments": 100000,
      "otherExpenses": 150000,
      "endingBalance": 100000,
      "isNegative": false
    },
    {
      "month": 2,
      "startingBalance": 100000,
      "income": 300000,
      "debtPayments": 100000,
      "otherExpenses": 150000,
      "endingBalance": 150000,
      "isNegative": false
    },
    {
      "month": 3,
      "startingBalance": 150000,
      "income": 300000,
      "debtPayments": 100000,
      "otherExpenses": 150000,
      "endingBalance": 200000,
      "isNegative": false
    },
    {
      "month": 4,
      "startingBalance": 200000,
      "income": 300000,
      "debtPayments": 100000,
      "otherExpenses": 150000,
      "endingBalance": 250000,
      "isNegative": false
    }
  ],
  "summary": {
    "totalMonths": 4,
    "negativeMonths": [],
    "lowestEndingBalance": 100000,
    "warnings": []
  }
}
```

#### C4. Loan affordability

```http
POST {{baseUrl}}/api/affordability
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "monthlyGrossIncome": 400000,
  "otherMonthlyExpenses": 150000,
  "existingMonthlyDebtPayments": 30000,
  "proposedMonthlyPayment": 50000,
  "targetDtiRatio": 0.4,
  "annualInterestRate": 0.18,
  "loanTermMonths": 24
}
```

**Response: `200 OK`**

```json
{
  "monthlyIncome": 400000,
  "ordinaryExpenses": 150000,
  "existingEMI": 30000,
  "proposedEMI": 50000,
  "projectedBalance": 170000,
  "shortfall": 0,
  "isNegative": false,
  "warning": null,
  "maxAffordableMonthlyPayment": 130000,
  "maxAffordableLoanAmount": 2603952.7,
  "debtToIncomeRatio": 0.2,
  "isAffordable": true,
  "warnings": []
}
```

> `annualInterestRate` is a fraction: `0.18` means 18%.

</details>

### Analytics

<details>
<summary>Show 3 examples</summary>

#### A1. Spending summary

```http
GET {{baseUrl}}/api/analytics/summary?from=2026-10-01&to=2026-10-31&groupBy=day
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "from": "2026-10-01",
  "to": "2026-10-31",
  "groupBy": "day",
  "days": 31,
  "totalSpent": 23000,
  "transactionCount": 2,
  "averageDailySpend": 741.94,
  "topCategory": "Food",
  "byCategory": [
    {
      "category": "Food",
      "total": 23000,
      "count": 2,
      "percent": 100
    }
  ],
  "series": [
    {
      "period": "2026-10-22",
      "total": 23000,
      "count": 2
    }
  ]
}
```

> `byCategory` is largest first. Days with no spending are left out of `series`, so fill the gaps with zero when charting.

#### A2. Spending summary by month

```http
GET {{baseUrl}}/api/analytics/summary?from=2026-09-01&to=2026-10-31&groupBy=month
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "from": "2026-09-01",
  "to": "2026-10-31",
  "groupBy": "month",
  "days": 61,
  "totalSpent": 23000,
  "transactionCount": 2,
  "averageDailySpend": 377.05,
  "topCategory": "Food",
  "byCategory": [
    {
      "category": "Food",
      "total": 23000,
      "count": 2,
      "percent": 100
    }
  ],
  "series": [
    {
      "period": "2026-10",
      "total": 23000,
      "count": 2
    }
  ]
}
```

#### A3. Summary with an invalid date

```http
GET {{baseUrl}}/api/analytics/summary?from=2026-02-30
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `400 Bad Request`**

```json
{
  "error": "Validation failed",
  "details": [
    {
      "field": "from",
      "message": "from must be a real date like 2026-12-01"
    }
  ]
}
```

</details>

### Alerts

<details>
<summary>Show 11 examples</summary>

#### A1. Set a low-balance rule

```http
PUT {{baseUrl}}/api/alert-rules
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "type": "low_balance",
  "threshold": 100000
}
```

**Response: `200 OK`**

```json
{
  "id": "3949a4dd-b406-434d-826c-7e29034520d0",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "type": "low_balance",
  "threshold": 100000,
  "category": null,
  "enabled": true,
  "createdAt": "2026-10-22T21:54:25.467Z",
  "updatedAt": "2026-10-22T21:54:25.467Z"
}
```

> There are no default rules. Setting the same type again updates it instead of adding another.

#### A2. Set a daily spending limit

```http
PUT {{baseUrl}}/api/alert-rules
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "type": "daily_spend_limit",
  "threshold": 20000
}
```

**Response: `200 OK`**

```json
{
  "id": "5b976a9f-0e7d-44f2-aeb1-0869f5ea7ae9",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "type": "daily_spend_limit",
  "threshold": 20000,
  "category": null,
  "enabled": true,
  "createdAt": "2026-10-22T21:54:25.471Z",
  "updatedAt": "2026-10-22T21:54:25.471Z"
}
```

#### A3. Set a category budget

```http
PUT {{baseUrl}}/api/alert-rules
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "type": "category_monthly_budget",
  "threshold": 20000,
  "category": "Food"
}
```

**Response: `200 OK`**

```json
{
  "id": "7e18ec3e-18d7-49ea-a38d-a2929cce9572",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "type": "category_monthly_budget",
  "threshold": 20000,
  "category": "Food",
  "enabled": true,
  "createdAt": "2026-10-22T21:54:25.477Z",
  "updatedAt": "2026-10-22T21:54:25.477Z"
}
```

> `category` is required for this type, and is rejected for the others.

#### A4. Get warned before a bill is due

```http
PUT {{baseUrl}}/api/alert-rules
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "type": "bill_due_soon",
  "threshold": 7
}
```

**Response: `200 OK`**

```json
{
  "id": "c9d0f53a-5b70-48f7-9936-72f97cec80f9",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "type": "bill_due_soon",
  "threshold": 7,
  "category": null,
  "enabled": true,
  "createdAt": "2026-10-22T21:54:25.482Z",
  "updatedAt": "2026-10-22T21:54:25.482Z"
}
```

> `threshold` is a number of days (1 to 60), today included.

#### A5. Warn when over today's safe-to-spend amount

```http
PUT {{baseUrl}}/api/alert-rules
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "type": "over_safe_to_spend"
}
```

**Response: `200 OK`**

```json
{
  "id": "a96b02c4-d4db-401d-92aa-83dc0bbb8a87",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "type": "over_safe_to_spend",
  "threshold": null,
  "category": null,
  "enabled": true,
  "createdAt": "2026-10-22T21:54:25.488Z",
  "updatedAt": "2026-10-22T21:54:25.488Z"
}
```

> This type takes no threshold: it compares today's spending with the safe-to-spend figure.

#### A6. Set a rule with a threshold that does not fit

```http
PUT {{baseUrl}}/api/alert-rules
```

**Headers / body type:** `Authorization: Bearer {{token}}` · `Content-Type: application/json`

**Body (raw JSON)**

```json
{
  "type": "bill_due_soon",
  "threshold": 90
}
```

**Response: `400 Bad Request`**

```json
{
  "error": "Validation failed",
  "details": [
    {
      "field": "threshold",
      "message": "threshold must be less than or equal to 60"
    }
  ]
}
```

#### A7. List my alert rules

```http
GET {{baseUrl}}/api/alert-rules
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
[
  {
    "id": "3949a4dd-b406-434d-826c-7e29034520d0",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "type": "low_balance",
    "threshold": 100000,
    "category": null,
    "enabled": true,
    "createdAt": "2026-10-22T21:54:25.467Z",
    "updatedAt": "2026-10-22T21:54:25.467Z"
  },
  {
    "id": "5b976a9f-0e7d-44f2-aeb1-0869f5ea7ae9",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "type": "daily_spend_limit",
    "threshold": 20000,
    "category": null,
    "enabled": true,
    "createdAt": "2026-10-22T21:54:25.471Z",
    "updatedAt": "2026-10-22T21:54:25.471Z"
  },
  {
    "id": "7e18ec3e-18d7-49ea-a38d-a2929cce9572",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "type": "category_monthly_budget",
    "threshold": 20000,
    "category": "Food",
    "enabled": true,
    "createdAt": "2026-10-22T21:54:25.477Z",
    "updatedAt": "2026-10-22T21:54:25.477Z"
  },
  {
    "id": "c9d0f53a-5b70-48f7-9936-72f97cec80f9",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "type": "bill_due_soon",
    "threshold": 7,
    "category": null,
    "enabled": true,
    "createdAt": "2026-10-22T21:54:25.482Z",
    "updatedAt": "2026-10-22T21:54:25.482Z"
  },
  {
    "id": "a96b02c4-d4db-401d-92aa-83dc0bbb8a87",
    "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
    "type": "over_safe_to_spend",
    "threshold": null,
    "category": null,
    "enabled": true,
    "createdAt": "2026-10-22T21:54:25.488Z",
    "updatedAt": "2026-10-22T21:54:25.488Z"
  }
]
```

#### A8. List my alerts

```http
GET {{baseUrl}}/api/alerts?unread=true&limit=20
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "alerts": [
    {
      "id": "f6a90b2e-5b69-4be9-9ef0-e03e1b352722",
      "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
      "ruleId": "a96b02c4-d4db-401d-92aa-83dc0bbb8a87",
      "type": "over_safe_to_spend",
      "message": "You've spent 23000.00 today, more than your safe amount of 179.49.",
      "data": {
        "spent": 23000,
        "dailySafeToSpend": 179.49
      },
      "periodKey": "2026-10-22",
      "createdAt": "2026-10-22T21:54:25.492Z",
      "readAt": null
    },
    {
      "id": "68e2c500-0467-4a55-99b3-a6731aaa5682",
      "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
      "ruleId": "c9d0f53a-5b70-48f7-9936-72f97cec80f9",
      "type": "bill_due_soon",
      "message": "Internet (15000.00) is due in 6 days.",
      "data": {
        "name": "Internet",
        "amount": 15000,
        "billId": "5733818a-cc97-4849-a7a6-89d7342aac31",
        "dueDate": "2026-10-28T00:00:00.000Z",
        "daysAway": 6
      },
      "periodKey": "bill:5733818a-cc97-4849-a7a6-89d7342aac31",
      "createdAt": "2026-10-22T21:54:25.486Z",
      "readAt": null
    },
    {
      "id": "7b730c62-c3d3-47e8-972d-ce5b5bcb38f2",
      "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
      "ruleId": "7e18ec3e-18d7-49ea-a38d-a2929cce9572",
      "type": "category_monthly_budget",
      "message": "You've spent 23000.00 on Food this month, over your budget of 20000.00.",
      "data": {
        "spent": 23000,
        "category": "Food",
        "threshold": 20000
      },
      "periodKey": "2026-10",
      "createdAt": "2026-10-22T21:54:25.479Z",
      "readAt": null
    },
    {
      "id": "7ba0db79-8f55-411f-a6fd-6b90b20bce3b",
      "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
      "ruleId": "5b976a9f-0e7d-44f2-aeb1-0869f5ea7ae9",
      "type": "daily_spend_limit",
      "message": "You've spent 23000.00 today, over your daily limit of 20000.00.",
      "data": {
        "spent": 23000,
        "threshold": 20000
      },
      "periodKey": "2026-10-22",
      "createdAt": "2026-10-22T21:54:25.473Z",
      "readAt": null
    }
  ],
  "unreadCount": 4,
  "total": 4
}
```

> Newest first. Rules are checked when this is called, so alerts that depend on the calendar (a bill coming due) appear without any other action. Each rule fires once per day, month or bill.

#### A9. Mark one alert as read

```http
POST {{baseUrl}}/api/alerts/f6a90b2e-5b69-4be9-9ef0-e03e1b352722/read
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "id": "f6a90b2e-5b69-4be9-9ef0-e03e1b352722",
  "userId": "10133380-4bf5-4cf3-b93f-2146b1e6113e",
  "ruleId": "a96b02c4-d4db-401d-92aa-83dc0bbb8a87",
  "type": "over_safe_to_spend",
  "message": "You've spent 23000.00 today, more than your safe amount of 179.49.",
  "data": {
    "spent": 23000,
    "dailySafeToSpend": 179.49
  },
  "periodKey": "2026-10-22",
  "createdAt": "2026-10-22T21:54:25.492Z",
  "readAt": "2026-10-22T21:54:25.508Z"
}
```

#### A10. Mark all alerts as read

```http
POST {{baseUrl}}/api/alerts/read-all
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "updated": 3
}
```

#### A11. Delete an alert rule

```http
DELETE {{baseUrl}}/api/alert-rules/3949a4dd-b406-434d-826c-7e29034520d0
```

**Headers / body type:** `Authorization: Bearer {{token}}`

**Response: `200 OK`**

```json
{
  "ok": true
}
```

> Alerts the rule already produced stay in the history.

</details>

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm start` | Start (production) |
| `npm run migrate` | Apply new database migrations (safe to run repeatedly) |
| `npm test` | Run all tests against a throwaway Postgres (about 20 seconds, no setup) |
| `npm run load` | Load test the real server (see below) |

## Testing

`npm test` starts a throwaway PostgreSQL (no setup, deleted afterwards), applies the migrations, and runs every `*.test.js` file in `test/` with Node's built-in test runner. There are over 200 tests and a full run takes around 30 seconds. To use an existing empty database instead of the throwaway one, set `TEST_DATABASE_URL`. **Never point it at production data**: the tests create users and write rows.

Most tests start the real app on a random port and call it over HTTP, like Postman would. Run `npm test` before every push.

| Files | What they cover |
|---|---|
| `auth`, `tokens`, `edge-auth`, `edge-auth-limits` | Register, login, wrong passwords, refresh tokens (single use, reuse detection, expiry), logout, password reset, and the rate limits on those endpoints |
| `profile`, `financial-profile`, `logout-keeps-data`, `avatar`, `avatar-cloud`, `account-edit`, `account-edit-limits`, `account-deletion`, `account-deletion-cloud`, `account-deletion-limits`, `forecast-engine`, `forecast`, `forecast-scenarios`, `assistant`, `assistant-limits`, `bills`, `bills-edit`, `uploads`, `cloud-storage` | Balance, income and savings-goal updates, the profile picture (set, replace, remove, type and size limits, on disk and on Cloudinary), the saved calculator numbers (defaults, partial saves, validation, privacy, and that they and all other data survive logout and login), bills, file upload rules (allowed types, size limit, safe file names), and uploads to Cloudinary (tested with a fake Cloudinary, so no account is needed): the returned link, per-user folders, no copy left on disk, and the uploaded copy removed again if the database record cannot be saved |
| `expenses`, `expenses-manage`, `expenses-race`, `overspend`, `edge-money` | Recording, filtering, paging, editing and deleting expenses, exact money maths, and that simultaneous requests can never overspend the balance |
| `analytics` | Summary totals, per-category percentages, day and month grouping in UTC |
| `alert-rules`, `alert-rules-validation`, `alert-engine`, `alerts-flow` | Setting thresholds, what each of the six rule types fires on, firing once per period, notifications, marking alerts read |
| `calculator`, `calculators`, `safe-to-spend` | The money maths (safe-to-spend, EMI, cash flow, loan affordability), directly and through the API |
| `idempotency` | A retry with the same key does not repeat the action; users never see each other's cached answers |
| `edge-input`, `edge-behavior`, `edge-overload`, `platform`, `boot`, `request-logger`, `security-headers` | Odd input (bad dates, NUL characters), behaviour when the database is busy or down, startup and shutdown, request ids, unknown routes, the request log line with the client IP, Helmet's security headers, and the CORS allow-list |
| `openapi`, `openapi-features` | `src/docs/openapi.yaml` is valid and matches the code: every route is documented and real responses match the documented schemas |

Not tests: `helpers.js` (shared shortcuts such as `registerUser`), `pg.js` (starts the throwaway database) and `run.js` (what `npm test` runs).

Each test file runs in its own process, so the per-IP rate limits (for example 30 writes per minute) apply per file. A test that sends many writes belongs in its own file; that is why some topics are split across files.

When you change behaviour, change the tests with it. When you add or change a route, update `src/docs/openapi.yaml`: the `openapi` tests fail if it no longer matches.

## Project layout

```
src/
  server.js          boot: connect DB, listen, graceful shutdown
  app.js             middleware order and routes
  routes/            auth.js (public auth endpoints), api.js (profile, bills, expenses, files, dashboard, calculators),
                     alerts.js (alert rules and alerts), analytics.js (spending summary); all but auth.js need a token
  validation/        Joi schemas, one per endpoint
  middleware/        auth, validate, uuidParam, rateLimit, idempotency, upload, requestLogger, errorHandler
  services/          calculator.js: pure money maths, no I/O; budget.js: safe-to-spend; alerts.js: rule engine;
                     notifier.js: alert delivery hook; tokens.js: refresh + reset tokens; mailer.js: reset email hook;
                     storage.js: where uploads are kept (Cloudinary or disk)
  db/                migrate.js and migrations/*.sql
  utils/             db, redis, logger
  docs/openapi.yaml  the API contract
test/                node:test suites + run.js (starts the test database); see Testing
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
- **Deleting an account:** the user asks with their password and gets 24 hours to change their mind. The answer, `GET /api/me`, the dashboard and login all say it is pending and when it will be deleted. Cancelling is one call. When the day is over a check (at server start and every minute) deletes the profile and every row of theirs, and the uploaded files (Cloudinary or disk) are queued in the same transaction and removed, retried if the storage is briefly unreachable. An account past its deadline is refused at once even before that check runs.
- **Idempotency:** send an `Idempotency-Key` header on POST/PUT/DELETE; a retry within 5 minutes returns the first result instead of repeating the action. Do not send it on login, register or refresh, because the cached answer would contain tokens.
- **Rate limits (per IP):** 8 failed login, sign-up, refresh or reset attempts per 15 min, 8 password-reset requests per 15 min, 30 writes / 20 calculations / 60 reads per minute, 300 requests per 15 min overall. `/health` is exempt. A `429` response means wait and retry.
- **Files:** JPEG, PNG, WebP, GIF, PDF, MP4, MOV and WebM up to 20 MB. With `CLOUDINARY_URL` set they are uploaded to Cloudinary and returned as an `https://res.cloudinary.com/...` link; otherwise they are saved on disk under a random name (the extension comes from the file type, never from the client's file name) and returned as `/uploads/<name>`. If saving the database record fails after the upload, the uploaded copy is removed again.
- **Safe to spend:** the daily figure is (balance + what was already spent today - upcoming bills - a savings reserve) divided by the days until the next income, and never below zero. Today's spending is added back because recording an expense already lowered the balance; without that the same money would be counted twice. So the allowance stays the same all day, and `remainingToday` is that allowance minus what was spent. A bill with no due date, or one already past due, is always counted, so delete bills once they are paid.
- **Logging:** one line per request with the method, path, status, time, request id and client IP (`GET /api/bills 200 12ms 3f2a9c1e 203.0.113.9`); the id is also returned as `X-Request-Id`. Query strings, bodies, passwords and tokens are never logged. Behind a proxy (such as Render) set `TRUST_PROXY=1`, otherwise the IP logged is the proxy's, not the user's. IP addresses count as personal data in many countries, so keep the logs private and delete them on a schedule.
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

Add a new file `src/db/migrations/009_what_it_does.sql` and run `npm run migrate`. Files run once, in name order,
each in its own transaction. Never edit a migration that has already been applied; add a new one.

The project has eight so far (001 initial tables, 002 refresh and reset tokens, 003 alerts and analytics, 004 Cloudinary file links, 005 saved calculator numbers, 006 profile picture, 007 user name, 008 account deletion).
**Run `npm run migrate` after every `git pull` that brings a new migration file**, and on every deploy (the Render start command does it for you). Skipping it makes the new code fail with errors such as `relation "..." does not exist` or `column "..." does not exist`.

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
| `CORS_ORIGINS` | the real frontend address, for example `https://app.example.com`. Until it is set, only a placeholder origin is allowed |
| `CLOUDINARY_URL` | your Cloudinary URL, so uploaded files survive deploys (see Configuration) |
| `DB_CONNECT_TIMEOUT_MS` | `20000` if the database is hosted far away or sleeps when idle |

`PORT` is set by Render and read by the app.

**Migrations:** the start command above applies new migrations every time the service starts. That is safe to repeat, and instances starting together wait for each other. On a paid plan you can instead run `npm run migrate` as Render's *Pre-Deploy Command* and keep the start command as `npm start`.

**Things to know on Render:**
- The disk is wiped on every deploy and restart, so **uploaded files disappear** unless you set `CLOUDINARY_URL` (recommended: files are kept on Cloudinary) or attach a persistent disk mounted on the `src/uploads` folder (paid). See the limitations below.
- Free web services go to sleep when idle, and the first request after that is slow.
- Rate limits and idempotency are kept in memory, which is fine for one instance. Set `REDIS_URL` before running more than one.
- Password-reset emails and alert notifications are not sent until a sender is plugged into `src/services/mailer.js` and `src/services/notifier.js`.
- Never commit `.env`. It is already in `.gitignore`; set the same values in Render's *Environment* tab instead.

## Deploy checklist

- [ ] `NODE_ENV=production` and a long random `JWT_SECRET`
- [ ] `DATABASE_URL` points at the production database; `npm run migrate` ran
- [ ] `TRUST_PROXY` matches the number of proxies in front of the app
- [ ] `REDIS_URL` set if running more than one instance
- [ ] `CLOUDINARY_URL` is set (or the uploads directory is on a persistent volume), and `npm run migrate` has applied migration 004
- [ ] A real email sender is plugged into `src/services/mailer.js`, and a push/email sender into `src/services/notifier.js` if you want alerts delivered
- [ ] Load balancer health check hits `/health` (200 = ok, 503 = database down)
- [ ] HTTPS terminated in front of the app

## Known limitations

- **Uploaded files are reachable by anyone who has the link.** Without `CLOUDINARY_URL` they sit on the server's disk (`src/uploads`, served at `/uploads/<random-name>`), which does not scale past one instance. With it they are on Cloudinary at a hard-to-guess address. Both are "unguessable, not private". Truly private files need Cloudinary's authenticated delivery with signed links, which is not set up yet. Also: Cloudinary may block delivery of PDF and ZIP files until you allow it in its security settings.
- **CORS allows only a placeholder origin for now.** Browsers can call the API only from the origins in `CORS_ORIGINS`. Set the real frontend address there before launch.
- **Password-reset emails need a provider.** The reset flow works end to end, but `src/services/mailer.js` only logs the token (outside production) until you connect an email service.
- **No notifications are delivered.** Alerts appear when the app asks for them (`GET /api/alerts` or the dashboard's `unreadAlerts`). Push or email needs a sender in `src/services/notifier.js`.
- **Permanent deletion is done by the server itself** (a check at start-up and every minute). On a free Render plan that sleeps when idle, the data is removed when the server next wakes up. The account is unusable the moment the day is over either way. Backups kept by the database host are outside this app's control.
- **Only expenses are recorded as transactions, not income.**
- **HTTPS is not done by the app.** Render (or your proxy) must terminate it. Helmet sends the HTTPS-only header, but the app itself speaks plain HTTP.
- **Access tokens last 1 hour** and cannot be revoked individually: logout ends the refresh token, and a password reset invalidates earlier access tokens, but a stolen access token otherwise works until it expires.
