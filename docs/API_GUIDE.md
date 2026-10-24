# MoneyGuard API: the friendly guide

*Written for the people building the app screens. No backend knowledge needed. If you can make a button, you can read this.*

(For the exact, machine-readable contract, run the server and open `/docs`. This guide explains the same thing in words.)

---

## 1. The big picture

Think of MoneyGuard as a **piggy bank with a very careful grown-up** looking after it.

- You tell the grown-up how much is in the piggy bank. (**balance**)
- You tell them about things you have to pay later. (**bills**)
- You tell them when you spend money. (**expenses**)
- They tell you: *"Today you can safely spend this much."* (**safe to spend**)
- You can also ask silly-looking but important questions: *"Could I afford this? What if I borrow money?"* (**calculators**)

The grown-up lives on a computer far away (the **server**). Your app talks to it by sending **letters** (requests) and getting **letters back** (responses). Every letter is written in a tidy format called **JSON**.

That's all this is. The rest of this guide is "how to write the letters".

---

## 2. Rules for every letter

### Where to send them

The server's address is called the **base URL**. While developing it is `http://localhost:3000`. Every path below goes after it.
Example: `GET /api/me` means `GET http://localhost:3000/api/me`.

### What a letter looks like

- Write it in JSON.
- Say you wrote JSON: add the header `Content-Type: application/json`. (The only exception is file upload, section 9.)
- The verb matters:
  - **GET** = "show me something" (never changes anything)
  - **POST** = "make a new thing"
  - **PUT** = "replace this value"
  - **DELETE** = "throw this away"

### The wristband (how the server knows it's you)

Most letters need to show a **wristband**, like at a water park. You put it in a header:

```
Authorization: Bearer <your access token here>
```

No wristband, or a broken one → the server says **401**. Section 3 explains how to get and renew wristbands.

### Money

- Money is a normal number: `250.75`.
- Up to **2 decimals**. `10.999` becomes `11`.
- You may send `"250.75"` (as text) and it's fine. What you **get back** is always a real number.
- The biggest amount allowed is `1000000000000` (a trillion).
- `amount` for bills, expenses and purchases must be **at least `0.01`**.

### Dates

- Use the format `2026-12-01` (means midnight, UTC), **or** `2026-12-01T09:00:00Z`, **or** with an offset `2026-12-01T09:00:00+05:30`.
- A time **without** a zone (`2026-12-01T09:00:00`) is **rejected**. The server won't guess your time zone.
- Pretend dates (`2026-02-30`) are rejected. Allowed years: 1900 to 2200.
- Dates you get back always look like `2026-12-01T00:00:00.000Z`.

### When something goes wrong

Every error looks like this:

```json
{ "error": "Something is wrong, in words" }
```

If you sent bad stuff, you also get a list saying **which box** was bad (great for showing red text under a field):

```json
{
  "error": "Validation failed",
  "details": [
    { "field": "amount", "message": "amount must be greater than or equal to 0.01" },
    { "field": "date",   "message": "date must be an ISO 8601 date, e.g. 2026-12-01 or 2026-12-01T09:00:00Z" }
  ]
}
```

Every response also has an `X-Request-Id` header. If something breaks, send that number to the backend team. It lets them find your exact letter.

### What the numbers mean (status codes)

| Number | In kid words | What your app should do |
|---|---|---|
| **200** | "Done, here you go." | Use the answer. |
| **201** | "Made it!" | Use the new thing. |
| **400** | "I can't read your letter." | Show the `details` next to the fields. |
| **401** | "Who are you? / Your wristband stopped working." | Refresh the token, or send to login. See section 3. |
| **404** | "That doesn't exist." | Show "not found". |
| **409** | "That's already taken." (or "still working on your last letter") | Tell the user. |
| **422** | "I understood you, but I won't do it." (not enough money) | Tell the user. Nothing changed. |
| **429** | "Too many letters! Slow down." | Wait a bit, then try again. |
| **503** | "I'm busy. Try again in a moment." | Wait the number of seconds in the `Retry-After` header, then retry. Don't log the user out. |
| **500** | "Oops, my bad." | Show a friendly error; send the `X-Request-Id` to the backend team. |

---

## 3. Logging in: the two keys

When someone logs in, the server gives you **two** things, like at a theme park:

1. **A wristband (`token`)**. Short. It works for **1 hour**. You show it with every letter.
2. **A membership card (`refreshToken`)**. Long. It works for **7 days**. You never show it with normal letters. You only use it to **get a fresh wristband** when the old one runs out.

Why two? If someone steals your wristband, it stops working in an hour. The membership card stays hidden and is used rarely.

```
login  ───►  wristband (1 hour)  +  membership card (7 days)
                │                          │
           use for every letter       use ONLY to get a new pair
```

### Register (make an account)

`POST /api/auth/register`

```json
{ "email": "sam@example.com", "password": "mysecret123", "phone": "+91 98765 43210" }
```

- `email`: ASCII letters only. The server trims spaces and makes it lowercase.
- `password`: **8 or more characters**, but **no more than 72 bytes**. Letters like `é` or Hindi characters take 2 to 4 bytes each, so a very long non-English password can be too long.
- `phone`: optional.

Success (**201**):

```json
{
  "token": "eyJhbGciOi...",
  "expiresIn": 3600,
  "refreshToken": "q8Zk3...",
  "user": {
    "id": "7d1c...",
    "email": "sam@example.com",
    "phone": "+91 98765 43210",
    "balance": 0,
    "nextIncomeAmount": 0,
    "nextIncomeDate": null,
    "savingsGoalAmount": 0,
    "savingsGoalDeadline": null,
    "createdAt": "2026-10-22T10:00:00.000Z"
  }
}
```

Problems: **409** (email already used), **400** (bad input), **429** (too many tries).

### Log in

`POST /api/auth/login`

```json
{ "email": "sam@example.com", "password": "mysecret123" }
```

Success (**200**) gives the same shape as register.
Wrong email **or** wrong password gives the same **401** `Invalid credentials`. This is on purpose: the server won't tell a stranger which emails have accounts.

> **Careful:** only **8 wrong logins per 15 minutes** are allowed from one internet address. After that you get **429**. Don't loop on a failure.

### Renew the wristband

`POST /api/auth/refresh`

```json
{ "refreshToken": "q8Zk3..." }
```

Success (**200**):

```json
{ "token": "eyJhbGciOi...", "expiresIn": 3600, "refreshToken": "n3Pw9..." }
```

**The most important rule in this whole guide:**

> Every membership card works **exactly once**. The answer contains a **brand-new** card. **Save the new card immediately** and throw the old one away.

If you use an old card a second time, the server thinks it was stolen and **cancels that whole login**. Everyone using it must log in again.

So:

- Save the new `refreshToken` **before** doing anything else.
- Never refresh from two places at once. If three requests all get a 401 at the same time, let **one** refresh, and make the other two wait for it.
- Each refresh starts a fresh 7 days. Someone who opens the app at least once a week stays signed in forever. Someone away for more than 7 days has to log in again.

If `/refresh` answers **401**, the card is dead (too old, already used, logged out, or the password was reset). Clear your saved tokens and show the **login screen**.

If `/refresh` answers **429**, **503**, or you have no internet, that's **not** a dead card. **Keep your saved tokens** and try again later. Don't log the user out for a bad Wi-Fi moment.

### When should I renew?

- **On a 401** from any normal letter: refresh once, then repeat the letter once. Or...
- **Just before time runs out:** `expiresIn` is seconds (3600 = 1 hour). Renew a minute or two early.

### Log out

`POST /api/auth/logout`

```json
{ "refreshToken": "q8Zk3..." }
```

Always answers `{ "ok": true }`, even if the card was already dead. After this, delete the saved tokens on the phone. The old wristband still works until its hour is up. That's normal.

### Forgot password

Two steps, like asking a grown-up for a spare key.

**Step 1.** `POST /api/auth/forgot-password`

```json
{ "email": "sam@example.com" }
```

Always answers **200**:

```json
{ "message": "If that email has an account, a password reset link is on its way." }
```

It says this **whether or not** the email has an account. Show the user the same friendly message either way. (Again: it won't reveal who has an account.)

The server then emails a **reset token**. It works **once**, for **60 minutes**. A newer request cancels the older token.

> Limit: 8 requests per 15 minutes per internet address.
>
> **Backend note:** the email part is not connected to a real email service yet. In development, the token is printed in the server log. See `src/services/mailer.js`.

**Step 2.** `POST /api/auth/reset-password`

```json
{ "token": "the-token-from-the-email", "password": "my-new-password" }
```

- **200** `{ "ok": true }`: password changed.
- **400** `Invalid or expired reset token`: wrong, too old, or already used. Ask them to start over.
- Same password rules as register (8+ characters, max 72 bytes).

**After a successful reset, the user is logged out everywhere**: every membership card and every old wristband stops working. Delete saved tokens and send them to the **login screen**. They log in with the new password.

---

## 4. The "app lock" (this part lives in the app, not the server)

The server only checks the wristband and card. It can't make the phone ask for a fingerprint. That's your job in the app. The short version:

- **Every time the app opens it starts locked.** Ask for the phone's password, PIN, or fingerprint/face.
- Only **after** that works, use the saved membership card to get a fresh wristband.
- When the app goes to the background or closes, **lock it again** and forget the wristband (keep it in memory only).
- Store the membership card in the phone's secure place (iOS Keychain, Android Keystore). **Never store the password.**
- Only a **401 from `/refresh`** means "log in again". Bad internet never does.

The full version, with a step-by-step flow, is in **[CLIENT_AUTH.md](CLIENT_AUTH.md)**.

---

## 5. About you

Every letter from here on needs the wristband header.

### Who am I? `GET /api/me`

Returns the same `user` object you saw at login, with the freshest numbers.

### Set the piggy-bank amount `PUT /api/balance`

```json
{ "balance": 1000 }
```

Answer: `{ "balance": 1000 }`. It can be `0` but not negative.

This **replaces** the number. It does not add to it. Use it when the user says "I actually have this much right now".

### Set when the next pay comes `PUT /api/next-income`

```json
{ "amount": 500, "date": "2026-12-01" }
```

- `date` is optional. Leave it out (or `null`) if unknown. The server then assumes **30 days** away.
- Answer: `{ "nextIncomeAmount": 500, "nextIncomeDate": "2026-12-01T00:00:00.000Z" }`.

### Set a savings goal `PUT /api/savings-goal`

```json
{ "amount": 200, "deadline": "2027-03-01" }
```

`deadline` is optional. Answer: `{ "savingsGoalAmount": 200, "savingsGoalDeadline": "..." }`.

### Remember my calculator numbers `GET` and `PUT /api/financial-profile`

The three "what if" calculators (section 8) only do maths on the numbers you send them. They **do not remember** those numbers. So if your app asks the user for "monthly income, expenses, loan payment" and keeps the answers only in the phone's memory, the user has to type them all again after logging out.

This endpoint is the server's notebook for those numbers.

**Right after login:** `GET /api/financial-profile` and use the answer to fill in the calculator screen. If nothing was ever saved you still get an answer (the defaults, with `"updatedAt": null`), never an error.

**When the user fills in or changes a number:** `PUT /api/financial-profile` with only what changed:

```json
{ "monthlyIncome": 400000, "monthlyExpenses": 150000, "existingDebtPayments": 30000, "proposedPayment": 50000,
  "targetDtiRatio": 0.4, "annualInterestRate": 0.18, "loanTermMonths": 24 }
```

All seven fields are optional, but send at least one. The answer is everything as saved, plus `updatedAt`. `annualInterestRate` is a fraction (`0.18` = 18%), like in the calculators.

**Which calculator field is which:**

| Saved field | projected-balance | cash-flow | affordability |
|---|---|---|---|
| `monthlyIncome` | `monthlyIncome` | `monthlyGrossIncome` | `monthlyGrossIncome` |
| `monthlyExpenses` | `ordinaryExpenses` | `otherMonthlyExpenses` | `otherMonthlyExpenses` |
| `existingDebtPayments` | `existingEMI` | `existingMonthlyDebtPayments` | `existingMonthlyDebtPayments` |
| `proposedPayment` | `proposedEMI` | `monthlyPayment` | `proposedMonthlyPayment` |
| `targetDtiRatio` | | | `targetDtiRatio` |
| `annualInterestRate` | | | `annualInterestRate` |
| `loanTermMonths` | | | `loanTermMonths` |

For `cash-flow`, take `startingCashBalance` from the user's `balance` (`GET /api/me`).

**Good to know:** logging out never deletes anything the user saved. If an app shows an empty screen after login, the app is not loading the data. It is still on the server.

---

## 6. Bills (things to pay later)

### See them `GET /api/bills`

An array, oldest first:

```json
[{ "id": "uuid", "userId": "uuid", "name": "Rent", "amount": 250.75, "dueDate": "2026-11-01T00:00:00.000Z", "createdAt": "..." }]
```

### Add one `POST /api/bills`

```json
{ "name": "Rent", "amount": 250.75, "dueDate": "2026-11-01" }
```

- `name`: required, 1 to 100 characters.
- `amount`: required, at least `0.01`.
- `dueDate`: optional.

Answer (**201**): the new bill.

### Remove one `DELETE /api/bills/{id}`

Answer `{ "ok": true }`, or **404** if it doesn't exist (or isn't yours). An `id` that isn't shaped like a proper id also gets 404.

> Bills **do not** take money out of the balance. They are only *promises* the server thinks about when it works out what's safe to spend.

---

## 7. Expenses (money you spent)

### See them `GET /api/expenses`

Newest first (by `date`). You can narrow the list with these optional extras on the end of the address, like asking the grown-up "only show me the pizza ones":

| Extra | Means | Example |
|---|---|---|
| `from` | this day and later (UTC) | `?from=2026-10-01` |
| `to` | this day and earlier, **including** the whole day | `?to=2026-10-31` |
| `category` | only this category (capital letters don't matter) | `?category=food` |
| `minAmount`, `maxAmount` | only amounts in this range | `?minAmount=10&maxAmount=50` |
| `limit` | how many to give you (1 to 500, default **100**) | `?limit=20` |
| `offset` | how many to skip, for the next page | `?limit=20&offset=20` |

Mix them with `&`. The answer is still a list. The header **`X-Total-Count`** says how many expenses match **in total**, so you know whether to ask for another page. A bad extra (like `limit=0`) gets a 400 saying which one.

Each expense looks like:

```json
{ "id": "uuid", "userId": "uuid", "amount": 12.5, "category": "Food", "description": "lunch", "date": "2026-10-22T12:00:00.000Z", "createdAt": "..." }
```

### Fix a mistake `PUT /api/expenses/{id}`

Send **only** what changed (at least one thing):

```json
{ "amount": 15, "category": "Snacks" }
```

You can change `amount`, `category`, `description`, `date`. You get the updated expense back (**200**).

If the `amount` changes, the piggy bank moves by the **difference**: the expense went from 12.5 to 15, so 2.5 more comes out. If the new amount is more than the piggy bank can pay, you get **422** `Insufficient balance` and nothing changes. A wrong or someone else's `id` gives **404**.

### Take one back `DELETE /api/expenses/{id}`

Throws the expense away **and puts the money back** in the piggy bank. Answer: `{ "ok": true, "balance": 1012.5 }` (the balance after the refund), or **404**.

### Spend `POST /api/expenses`

```json
{ "amount": 12.5, "category": "Food", "description": "lunch", "date": "2026-10-22T12:00:00Z" }
```

- `amount`: required, at least `0.01`.
- `category`: optional, up to 50 characters, default `"Other"`.
- `description`: optional, up to 200 characters.
- `date`: optional, default = now.

**201**: the expense was saved **and** the balance went down by that amount, in one single step.

**You can't spend more than you have.**

If `amount` is more than the balance, you get:

```json
{ "error": "Insufficient balance" }
```

with status **422**, and **nothing changes**: no expense saved, balance untouched. Spending *exactly* the balance is allowed (it becomes 0).

This is safe even if two phones tap "spend" at the same moment. The server checks and subtracts as one move, so the balance can never go below 0.

Good screens: show the current balance, and when you get a 422, say "That's more than you have" and offer to update the balance.

---

## 8. The home screen and the questions

### Home screen `GET /api/dashboard`

One call for the whole home screen:

```json
{
  "user": { "balance": 1000, "nextIncomeAmount": 500, "nextIncomeDate": "2026-12-01T00:00:00.000Z", "savingsGoalAmount": 200 },
  "safeToSpend": {
    "dailySafeToSpend": 24.5,
    "remainingToday": 14.5,
    "daysUntilNextIncome": 30,
    "upcomingBillsTotal": 250.75,
    "savingsReserve": 50,
    "availableAfterCommitments": 699.25,
    "spentToday": 10,
    "warnings": []
  },
  "recentExpenses": [ /* up to 5 newest expenses */ ],
  "unreadAlerts": 2
}
```

What the numbers mean:

- **`dailySafeToSpend`**: "You can spend about this much each day until the next pay." It is never negative. It is worked out from what you had **this morning** (today's spending is added back to the balance), so it **stays the same all day** and does not shrink as you spend.
- **`spentToday`**: how much was spent so far today. A "day" is a **UTC** day, so it flips at midnight UTC, not at the phone's midnight.
- **`remainingToday`**: `dailySafeToSpend − spentToday`. **Negative means the user is over budget today.** Show it in red.
- **`upcomingBillsTotal`**: bills due on or before the day the next pay arrives. A bill with **no due date**, or one already past due, is **always counted**, so delete bills the user has paid.
- **`savingsReserve`**: a bit set aside for the savings goal.
- **`unreadAlerts`** (next to `safeToSpend`, not inside it): how many alerts the user has not read. Use it for the red badge (see section 10).
- **`warnings`**: a list of sentences. Show them as-is. Examples: "Commitments exceed current balance."

### "Can I afford this?" `POST /api/can-i-afford`

```json
{ "amount": 300 }
```

Answer:

```json
{
  "recommendation": "ThinkTwice",
  "reason": "...",
  "explanation": "...",
  "remainingAfterPurchase": 700,
  "cashFlowWarnings": [],
  "safeToSpend": { /* same shape as above */ }
}
```

`recommendation` is exactly one of: **`Safe`** (green), **`ThinkTwice`** (yellow), **`NotRecommended`** (red). `reason` and `explanation` are sentences you can show directly. Each call is also saved on the server as a history record.

This only *asks*. It does **not** spend anything.

### Three "what if" calculators

These are pure maths. They don't read or change the user's saved data, and you can call them as often as the limits allow.

**`POST /api/projected-balance`**: "What's left each month if I take a new loan payment (EMI)?"

```json
{ "monthlyIncome": 450000, "ordinaryExpenses": 180000, "existingEMI": 35000, "proposedEMI": 50000 }
```

Only `monthlyIncome` is required; the rest default to 0. Answer:

```json
{
  "monthlyIncome": 450000, "ordinaryExpenses": 180000, "existingEMI": 35000, "proposedEMI": 50000,
  "projectedBalance": 185000, "shortfall": 0, "isNegative": false, "warning": null
}
```

`projectedBalance` **can be negative** here. If so, `isNegative` is `true`, `shortfall` says by how much, and `warning` is a sentence to show.

**`POST /api/cash-flow`**: "Month by month, will I run out?"

```json
{ "monthlyGrossIncome": 1000, "otherMonthlyExpenses": 400, "existingMonthlyDebtPayments": 0, "monthlyPayment": 100, "startingCashBalance": 100, "months": 3 }
```

Only `monthlyGrossIncome` is required. `months` is 1 to 120 (default 6). `startingCashBalance` may be negative. Answer:

```json
{
  "projection": [
    { "month": 1, "startingBalance": 100, "income": 1000, "debtPayments": 100, "otherExpenses": 400, "endingBalance": 600, "isNegative": false }
  ],
  "summary": { "totalMonths": 3, "negativeMonths": [], "lowestEndingBalance": 600, "warnings": [] }
}
```

Great for a line chart: plot `endingBalance` per `month`, and colour the `isNegative` months red.

**`POST /api/affordability`**: "How big a loan could I handle?"

```json
{
  "monthlyGrossIncome": 100000, "otherMonthlyExpenses": 30000, "existingMonthlyDebtPayments": 10000,
  "proposedMonthlyPayment": 15000, "targetDtiRatio": 0.4, "annualInterestRate": 0.12, "loanTermMonths": 24
}
```

- Only `monthlyGrossIncome` is required.
- **`annualInterestRate` is a fraction**: `0.12` means 12%. Sending `12` is rejected.
- `targetDtiRatio` (0 to 1, default 0.4) = "the most of my income I'm happy to give to debt".
- `loanTermMonths` is 1 to 480 (default 12).

The answer includes everything from `projected-balance` **plus**: `maxAffordableMonthlyPayment`, `maxAffordableLoanAmount`, `debtToIncomeRatio` (a fraction: `0.15` = 15%), `isAffordable`, and `warnings`.

---

## 9. Looking back: analytics

`GET /api/analytics/summary` answers "where did my money go?". Extras (all optional):

| Extra | Means | Default |
|---|---|---|
| `from` | first day (UTC), e.g. `2026-10-01` | 29 days before `to` |
| `to` | last day (UTC), included | today |
| `groupBy` | `day` or `month` for the chart series | `day` |

A range can be at most **731 days**. Answer:

```json
{
  "from": "2026-10-01", "to": "2026-10-31", "groupBy": "day", "days": 31,
  "totalSpent": 116, "transactionCount": 4, "averageDailySpend": 3.74,
  "topCategory": "Travel",
  "byCategory": [
    { "category": "Travel", "total": 100, "count": 1, "percent": 86.2 },
    { "category": "Food",   "total": 16,  "count": 3, "percent": 13.8 }
  ],
  "series": [
    { "period": "2026-10-01", "total": 15,  "count": 2 },
    { "period": "2026-10-02", "total": 100, "count": 1 }
  ]
}
```

- `byCategory` is biggest first and is great for a pie chart. "Food" and "food" are counted together.
- `series` is oldest first and is great for a bar chart. **Days (or months) with no spending are left out**, so fill the gaps with zero when you draw.
- `topCategory` is `null` when nothing was spent.
- Days and months are **UTC**, like everything else.

---

## 10. Alerts: the piggy bank taps you on the shoulder

You decide **when** to be tapped. Out of the box the user has **no alert rules**, so nothing happens until they set one.

### Set a rule `PUT /api/alert-rules`

```json
{ "type": "daily_spend_limit", "threshold": 50 }
```

The `threshold` means different things depending on the `type`:

| `type` | `threshold` is | You get tapped when... |
|---|---|---|
| `low_balance` | an amount | the balance is **below** it |
| `daily_spend_limit` | an amount | today's spending is **above** it |
| `monthly_spend_limit` | an amount | this month's spending is **above** it |
| `category_monthly_budget` | an amount, plus a `category` | this month's spending in that category is **above** it |
| `bill_due_soon` | a number of days (1 to 60) | a bill is due within that many days, today included |
| `over_safe_to_spend` | *leave it out* | today's spending is above today's safe-to-spend number |

```json
{ "type": "category_monthly_budget", "threshold": 300, "category": "Food" }
{ "type": "over_safe_to_spend" }
{ "type": "bill_due_soon", "threshold": 3, "enabled": false }
```

- Sending a field that doesn't belong to the type (a `threshold` on `over_safe_to_spend`, a `category` on `daily_spend_limit`) is a **400**, so mistakes show up early.
- Setting the same type again **updates** it (for category budgets: the same category, capital letters ignored). There is only ever one rule per type.
- `enabled: false` switches a rule off without deleting it. Default is `true`.
- A user can have at most **50** rules (**422** after that).
- The rule is checked right away, so if it's already true you'll get the alert straight away.

`GET /api/alert-rules` lists them. `DELETE /api/alert-rules/{id}` removes one (alerts it already made stay).

### See the alerts `GET /api/alerts`

```json
{
  "alerts": [{
    "id": "uuid", "userId": "uuid", "ruleId": "uuid", "type": "daily_spend_limit",
    "message": "You've spent 60.00 today, over your daily limit of 50.00.",
    "data": { "spent": 60, "threshold": 50 },
    "periodKey": "2026-10-22", "createdAt": "2026-10-22T10:15:00.000Z", "readAt": null
  }],
  "unreadCount": 1,
  "total": 1
}
```

- Newest first. Show `message` as it is. `data` has the raw numbers if you want a fancier screen (what's in it depends on the `type`).
- Extras: `?unread=true` (only unread), `?limit=` and `?offset=` for pages. `unreadCount` is for the red badge; the dashboard also has an **`unreadAlerts`** number so the home screen needs no extra call.
- `ruleId` is `null` if the rule was deleted afterwards.
- **When do alerts appear?** Right after the thing that caused them: add an expense, change the balance, add a bill, and so on. So **after each of those, ask for `/api/alerts` (or the dashboard) again** to see anything new. Asking for `/api/alerts` also checks bills coming due, so open it when the app opens.
- **Nothing is pushed to the phone yet.** Alerts only show up when the app asks. (Push notifications can be added later on the server without changing any of this.)

### Each rule only taps once

A rule taps **once per day** (low balance, daily limit, safe-to-spend), **once per month** (monthly limit, category budget) or **once per bill**. Spending more the same day does not tap again. Changing the threshold afterwards does not tap again until the next day or month. Days and months are **UTC**.

### Mark as read

- `POST /api/alerts/{id}/read` returns the alert with `readAt` filled in. Doing it twice is fine.
- `POST /api/alerts/read-all` answers `{ "updated": 3 }`.

Alerts are kept for **90 days**, then cleaned up.

---

## 11. Files (receipts, photos)

### Upload `POST /api/files`

Not JSON this time. Send a **multipart form** with **one field named `file`**.

```
curl -H "Authorization: Bearer <token>" -F "file=@receipt.jpg" http://localhost:3000/api/files
```

- Allowed: JPEG, PNG, WebP, GIF, PDF, MP4, MOV, WebM.
- Max size: **20 MB**.
- Answer (**201**):

```json
{ "id": "uuid", "userId": "uuid", "filename": "9f2c....jpg", "originalName": "receipt.jpg", "mimetype": "image/jpeg", "size": 48213,
  "url": "https://res.cloudinary.com/your-cloud/image/upload/v1/moneyguard/<userId>/9f2c....jpg", "publicId": "moneyguard/<userId>/9f2c...", "resourceType": "image", "createdAt": "..." }
```

- **400** if there's no file, the type isn't allowed, or it's too big.

### See your files `GET /api/files`

An array of the objects above, newest first.

### Show a file

Open the **`url`** from the record. It is the only thing you need:

- If the server uses Cloudinary, `url` is a full `https://res.cloudinary.com/...` link. Put it straight into an image or video view, or a browser. No wristband is needed.
- If the server keeps files on its own disk, `url` is a path like `/uploads/9f2c.png`. Put the server's address in front of it (`http://localhost:3000/uploads/9f2c.png`).

Both work the same way for the app: `if url starts with "http" use it as it is, otherwise put the base URL in front`.

> **Heads-up:** that link is a public link. Nobody can *guess* it, but anyone who *has* it can open it. Don't promise users their files are private.

---

## 12. Rules of the road

### Too many letters (rate limits)

The server counts letters **per internet address**. If you go over, you get **429** with an `error` message. Headers named `RateLimit-*` say when you may try again.

| Kind | Limit |
|---|---|
| Wrong logins, bad registrations, bad refresh/logout/reset attempts | 8 per 15 minutes (only the *failed* ones count) |
| Asking for a password reset (`forgot-password`) | 8 per 15 minutes (every request counts) |
| Changing things (balance, income, goal, bills, expenses, uploads) | 30 per minute |
| Calculators (`can-i-afford`, `projected-balance`, `cash-flow`, `affordability`) | 20 per minute |
| Reading (`/me`, lists, `/dashboard`, `/analytics`, `/alerts`) | 60 per minute |
| Everything together | 300 per 15 minutes |
| `/health` | no limit |

Tip: don't fire a calculator on every keystroke. Wait until the user stops typing for a moment, or until they press a button.

### Pressed the button twice? (Idempotency-Key)

If a phone loses signal after tapping "Add expense", the app may not know whether it worked. Retrying could add it twice. To prevent that, send a header with a **new random id for each user action** (a UUID is perfect):

```
Idempotency-Key: 3f2a9c1e-5b7d-4d3a-9d1e-0c2f6b8a7e41
```

If the server sees the same key and same body again (within 5 minutes), it **does not repeat the action**. It sends back the first answer and adds `Idempotent-Replayed: true`.

Good to know:

- Use it on **POST/PUT/DELETE** actions that change money or data (expenses, bills, balance).
- Make a **new key for each new attempt by the user**. Only reuse a key when *retrying the same attempt*.
- A "no" answer is remembered too. If an expense got **422** (not enough money) and the user tops up and tries again, use a **new key**, or they'll get the old 422 back.
- Server errors (500s) and 429s are *not* remembered, so retrying those with the same key is fine.
- **Don't** use it on `/login`, `/register` or `/refresh`. Those answers contain tokens, and you don't want them kept around.

### Is the server alive? `GET /health`

No wristband. Answers `{ "status": "ok", "database": "connected", "redis": "memory" }` (**200**), or **503** if the database is down.

### Size limits

A JSON letter can be at most **10 KB**. Longer gets rejected.

---

## 13. A whole day in the life (follow along)

1. **First time:** `POST /api/auth/register`. Save `refreshToken` in secure storage. Keep `token` in memory.
2. `PUT /api/balance` → `{ "balance": 1000 }`
3. `PUT /api/next-income` → `{ "amount": 500, "date": "2026-12-01" }`
4. `POST /api/bills` → `{ "name": "Rent", "amount": 250 }`
5. `GET /api/dashboard` → draw the home screen. Today the user may spend about `dailySafeToSpend`.
6. User wants to buy something: `POST /api/can-i-afford` → show green / yellow / red.
7. User buys it: `POST /api/expenses` (with an `Idempotency-Key`). If **422**, say "not enough balance". Otherwise redraw the home screen, and ask for `/api/alerts` to see if that spend tapped the user on the shoulder.
8. **An hour later**, a letter gets a **401**. `POST /api/auth/refresh` → save the **new** card → repeat the letter. The user notices nothing.
9. **Closing the app:** lock it, forget the wristband. **Opening it again:** unlock with fingerprint/PIN → refresh → carry on.
10. **A week of not opening the app:** the card is too old. `/refresh` says **401**. Show the login screen.

---

## 14. Mistakes people make (so you don't)

| Mistake | What happens | Do this instead |
|---|---|---|
| Reusing an old `refreshToken` | The whole login gets cancelled | Always save the newest one |
| Two refreshes at the same moment | One succeeds, the other kills the login | Only one refresh at a time; others wait |
| Logging out the user when the network fails | Annoyed user | Only a 401 from `/refresh` means log in again |
| Storing the password | Security hole | Never. Store only the refresh token, in secure storage |
| Storing the wristband on disk | Easy to steal | Keep it in memory only |
| Sending `10.999` and expecting `10.999` | It becomes `11` | Round to 2 decimals yourself first |
| Sending a date without a time zone | 400 | Add `Z` or an offset like `+05:30` |
| Sending interest as `12` | 400 | Send `0.12` |
| Expecting `PUT /api/balance` to add | It replaces | Work out the new total first |
| Expecting expenses to go below 0 | 422 `Insufficient balance` | Check the balance first; handle the 422 |
| Assuming the expense list is complete | It returns 100 by default | Use `limit`/`offset` and `X-Total-Count` |
| Waiting for alerts to arrive by themselves | Nothing is pushed yet | Re-fetch `/api/alerts` after changes and when the app opens |
| Drawing the analytics series as-is | Days without spending are missing | Fill the gaps with zero |
| Expecting bills to reduce the balance | They don't | Only expenses do |
| Reusing an `Idempotency-Key` for a new attempt | Old answer replayed | New key per new attempt |
| Hammering a calculator on every keypress | 429 | Wait until typing stops |
| Treating `/uploads/...` as private | Anyone with the link can see it | Warn users, or wait for private storage |

---

## 15. Quick cheat sheet

| What | Method and path | Wristband? |
|---|---|---|
| Make account | `POST /api/auth/register` | no |
| Log in | `POST /api/auth/login` | no |
| New wristband | `POST /api/auth/refresh` | no (uses the card) |
| Log out | `POST /api/auth/logout` | no (uses the card) |
| Ask for reset | `POST /api/auth/forgot-password` | no |
| Set new password | `POST /api/auth/reset-password` | no |
| Who am I | `GET /api/me` | yes |
| Set balance | `PUT /api/balance` | yes |
| Set next income | `PUT /api/next-income` | yes |
| Set savings goal | `PUT /api/savings-goal` | yes |
| List / add / remove bills | `GET` / `POST` / `DELETE /api/bills[/{id}]` | yes |
| List / add expenses | `GET` / `POST /api/expenses` | yes |
| Edit / delete an expense | `PUT` / `DELETE /api/expenses/{id}` | yes |
| Where did my money go | `GET /api/analytics/summary` | yes |
| Alert rules | `GET` / `PUT /api/alert-rules`, `DELETE /api/alert-rules/{id}` | yes |
| Alerts | `GET /api/alerts`, `POST /api/alerts/{id}/read`, `POST /api/alerts/read-all` | yes |
| List / upload files | `GET` / `POST /api/files` | yes |
| Home screen | `GET /api/dashboard` | yes |
| Can I afford it | `POST /api/can-i-afford` | yes |
| Loan calculators | `POST /api/projected-balance`, `/api/cash-flow`, `/api/affordability` | yes |
| Is it alive | `GET /health` | no |
| Download a file | `GET /uploads/{filename}` | no |

If you get stuck: read the error message (it's written in plain words), look at `details` for which field is wrong, and keep the `X-Request-Id` handy for the backend team.
