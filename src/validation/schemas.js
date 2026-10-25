import Joi from 'joi';

// Numeric strings like "100" are accepted; booleans, arrays, null and "" are rejected.
// precision(2) rounds to cents, matching the NUMERIC(15,2) columns. Rounding first means
// 0.004 becomes 0 and is rejected here instead of violating a database CHECK later.
const money = Joi.number().precision(2).min(0).max(1e12);
const positiveMoney = Joi.number().precision(2).min(0.01).max(1e12);

// Postgres cannot store NUL characters in text; reject them here instead of failing with a 500.
const text = (max) =>
  Joi.string().trim().max(max)
    .pattern(/\u0000/, { name: 'NUL', invert: true })
    .messages({ 'string.pattern.invert.name': '{#label} contains an invalid character' });

// A real calendar date (2026-02-30 is rejected, not silently turned into March 2) between 1900 and 2200.
// Date-times must carry a time zone, otherwise the same input would mean different instants on different servers.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const date = Joi.string().custom((value, helpers) => {
  const match = ISO_DATE.exec(value);
  const parsed = new Date(value);
  if (!match || Number.isNaN(parsed.getTime())) return helpers.message('{#label} must be an ISO 8601 date, e.g. 2026-12-01 or 2026-12-01T09:00:00Z');
  const [year, month, day] = match.slice(1).map(Number);
  const calendar = new Date(Date.UTC(2000, month - 1, day)); // a leap year, so Feb 29 is checked below
  const realDay = calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day
    && (month !== 2 || day !== 29 || (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)));
  if (!realDay || year < 1900 || year > 2200) return helpers.message('{#label} must be a real date between 1900 and 2200');
  return parsed.toISOString();
});

// ascii only: JavaScript and Postgres lowercase some unicode letters differently, which breaks the
// lowercase-email constraint, and look-alike characters would allow duplicate-looking accounts.
const email = Joi.string().trim().lowercase().email({ allowUnicode: false }).max(254);

// bcrypt ignores everything past 72 BYTES, so a long password of multi-byte characters
// would silently match a different password sharing its first 72 bytes.
const password = Joi.string().min(8).custom((value, helpers) =>
  Buffer.byteLength(value) > 72 ? helpers.message('{#label} must be at most 72 bytes (non-latin characters use more than one)') : value);

const PHONE = /^\+?[0-9 ()-]{7,20}$/;

export const register = Joi.object({
  email: email.required(),
  password: password.required(),
  name: text(100).allow(null, ''),
  phone: Joi.string().trim().pattern(PHONE).allow(null, ''),
});

// Edit the details entered at sign-up. Send only what changed (at least one); null or '' clears a name or phone.
// Changing the email also needs the current password: a stolen login token alone must not be enough to take over an account.
export const profileUpdate = Joi.object({
  name: text(100).allow(null, ''),
  phone: Joi.string().trim().pattern(PHONE).allow(null, ''),
  email,
  currentPassword: Joi.string().max(72)
    .when('email', { is: Joi.exist(), then: Joi.required() })
    .messages({ 'any.required': 'currentPassword is required to change the email' }), // named, so the app can show it under that input
}).min(1);

// Deleting an account needs the password, so a stolen login token alone cannot do it.
export const deleteAccount = Joi.object({ currentPassword: Joi.string().max(72).required() });

export const changePassword = Joi.object({
  currentPassword: Joi.string().max(72).required(),
  newPassword: password.required(),
});

export const login = Joi.object({
  email: email.required(),
  password: Joi.string().max(72).required(),
});

export const refresh = Joi.object({ refreshToken: Joi.string().max(200).required() });

export const forgotPassword = Joi.object({ email: email.required() });

export const resetPassword = Joi.object({
  token: Joi.string().max(200).required(),
  password: password.required(),
});

export const balance = Joi.object({ balance: money.required() });

export const nextIncome = Joi.object({
  amount: money.required(),
  date: date.allow(null),
});

export const savingsGoal = Joi.object({
  amount: money.required(),
  deadline: date.allow(null),
});

// What the calculators ask for, saved so the app can fill it in again. Every field is optional (send only what changed),
// but at least one must be sent.
export const financialProfile = Joi.object({
  monthlyIncome: money,
  monthlyExpenses: money,
  existingDebtPayments: money,
  proposedPayment: money,
  targetDtiRatio: Joi.number().precision(4).min(0).max(1),
  annualInterestRate: Joi.number().precision(6).min(0).max(1)
    .messages({ 'number.max': 'annualInterestRate is a fraction, e.g. 0.12 for 12%' }),
  loanTermMonths: Joi.number().integer().min(1).max(480),
}).min(1);

export const bill = Joi.object({
  name: text(100).min(1).required(),
  amount: positiveMoney.required(),
  dueDate: date.allow(null),
});

// Send only what changed (at least one). A dueDate of null removes the due date.
export const billUpdate = Joi.object({
  name: text(100).min(1),
  amount: positiveMoney,
  dueDate: date.allow(null),
}).min(1);

export const expense = Joi.object({
  amount: positiveMoney.required(),
  category: text(50).default('Other'),
  description: text(200).allow('').default(''),
  date: date.default(() => new Date().toISOString()),
});

// Every field optional, but at least one must be sent.
export const expenseUpdate = Joi.object({
  amount: positiveMoney,
  category: text(50),
  description: text(200).allow(''),
  date,
}).min(1);

// A calendar day such as 2026-12-01 (UTC). Reuses the full date check above, so 2026-02-30 is rejected.
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((value, helpers) =>
  date.validate(value).error ? helpers.message('{#label} must be a real date like 2026-12-01') : value);

const page = {
  limit: Joi.number().integer().min(1).max(500).default(100),
  offset: Joi.number().integer().min(0).max(1e9).default(0),
};

const dayRange = (obj, maxDays) => obj.custom((value, helpers) => {
  if (value.from && value.to && value.from > value.to) return helpers.message('from must not be after to');
  if (value.from && value.to && (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 >= maxDays) {
    return helpers.message(`the range from..to can be at most ${maxDays} days`);
  }
  return value;
});

export const expenseQuery = dayRange(Joi.object({
  from: day,
  to: day,
  category: text(50).min(1),
  minAmount: positiveMoney,
  maxAmount: positiveMoney,
  ...page,
}), 36_600).custom((value, helpers) =>
  value.minAmount != null && value.maxAmount != null && value.minAmount > value.maxAmount
    ? helpers.message('minAmount must not be more than maxAmount') : value);

export const analyticsQuery = dayRange(Joi.object({
  from: day,
  to: day,
  groupBy: Joi.string().valid('day', 'month').default('day'),
}), 731);

export const ALERT_TYPES = [
  'low_balance',
  'daily_spend_limit',
  'monthly_spend_limit',
  'category_monthly_budget',
  'bill_due_soon',
  'over_safe_to_spend',
];

// What `threshold` means depends on the type; fields that do not apply to a type are rejected, not ignored.
export const alertRule = Joi.object({
  type: Joi.string().valid(...ALERT_TYPES).required(),
  threshold: Joi.when('type', {
    switch: [
      { is: 'bill_due_soon', then: Joi.number().integer().min(1).max(60).required() },
      { is: 'over_safe_to_spend', then: Joi.forbidden() },
    ],
    otherwise: positiveMoney.required(),
  }),
  category: Joi.when('type', { is: 'category_monthly_budget', then: text(50).min(1).required(), otherwise: Joi.forbidden() }),
  enabled: Joi.boolean().default(true),
});

export const alertsQuery = Joi.object({
  unread: Joi.boolean().default(false),
  ...page,
});

export const forecast = Joi.object({
  amount: positiveMoney,
  inDays: Joi.number().integer().min(0).max(365).default(0),
  confidence: Joi.number().min(0.5).max(0.99).default(0.95),
});

export const canIAfford = Joi.object({ amount: positiveMoney.required() });

export const projectedBalance = Joi.object({
  monthlyIncome: money.required(),
  ordinaryExpenses: money.default(0),
  existingEMI: money.default(0),
  proposedEMI: money.default(0),
});

export const cashFlow = Joi.object({
  monthlyGrossIncome: money.required(),
  otherMonthlyExpenses: money.default(0),
  existingMonthlyDebtPayments: money.default(0),
  startingCashBalance: Joi.number().min(-1e12).max(1e12).default(0), // may start overdrawn
  monthlyPayment: money.default(0),
  months: Joi.number().integer().min(1).max(120).default(6),
});

export const affordability = Joi.object({
  monthlyGrossIncome: money.required(),
  otherMonthlyExpenses: money.default(0),
  existingMonthlyDebtPayments: money.default(0),
  proposedMonthlyPayment: money.default(0),
  targetDtiRatio: Joi.number().min(0).max(1).default(0.4),
  annualInterestRate: Joi.number().min(0).max(1).default(0)
    .messages({ 'number.max': 'annualInterestRate is a fraction, e.g. 0.12 for 12%' }),
  loanTermMonths: Joi.number().integer().min(1).max(480).default(12),
});
