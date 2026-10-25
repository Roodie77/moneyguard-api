import express from 'express';
import bcrypt from 'bcrypt';
import { query, withTransaction } from '../utils/db.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { authMiddleware, signToken, ACCESS_TOKEN_SECONDS } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { uuidParam } from '../middleware/uuidParam.js';
import { writeLimiter, calcLimiter, readLimiter, authLimiter } from '../middleware/rateLimit.js';
import { upload, uploadAvatar } from '../middleware/upload.js';
import { storeUpload, discardUpload, removeStored, withUrl } from '../services/storage.js';
import * as schemas from '../validation/schemas.js';
import {
  canIAfford,
  runAffordabilityCalculator,
  generateCashFlowProjection,
  summarizeCashFlow,
  calculateProjectedBalance,
} from '../services/calculator.js';
import { safeToSpendFor, forecastFor } from '../services/budget.js';
import { issueRefreshToken } from '../services/tokens.js';
import { publicUser, deletionInfo, isDue, requestDeletion, cancelDeletion, purgeAccount, DELETION_GRACE_HOURS } from '../services/account.js';
import { evaluateAlerts } from '../services/alerts.js';
import alertsRouter from './alerts.js';
import analyticsRouter from './analytics.js';
import logger from '../utils/logger.js';

const router = express.Router();
router.use(authMiddleware);

// Loads the caller once per request. A valid token for a deleted user is rejected.
router.use(h(async (req, res, next) => {
  [req.user] = await query('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!req.user) return res.status(401).json({ error: 'Account not found' });
  // The grace period is over: the account is gone even if the sweep has not removed it yet.
  if (isDue(req.user) && await purgeAccount(req.userId)) return res.status(401).json({ error: 'Account not found' });
  // A password reset ends every session that started before it.
  if (req.user.passwordChangedAt && req.tokenIssuedAt < Math.floor(req.user.passwordChangedAt.getTime() / 1000)) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  next();
}));

router.param('id', uuidParam);

// Checks the user's alert rules after something they depend on changed. Never fails the request.
const checkAlerts = (req) => evaluateAlerts(req.userId);

// ---- Profile ----

// A wrong current password is a 400 with the field named (so the app can show it under the input), not a 401:
// a 401 means "your login token is no good" and makes apps try to refresh the session or log the user out.
const wrongPassword = (res, field = 'currentPassword', message = 'Current password is incorrect') =>
  res.status(400).json({ error: 'Validation failed', details: [{ field, message }] });

router.get('/me', readLimiter, (req, res) => {
  res.json(publicUser(req.user));
});

// Asks for the account to be deleted. It is NOT deleted now: it is scheduled for 24 hours from now, and the answer says so.
// Until then everything still works and the account can be cancelled. Needs the current password (a stolen login token alone
// must not be enough). Asking again does not move the deadline. Wrong guesses count towards the failed-attempts limit.
router.delete('/me', authLimiter, validate(schemas.deleteAccount), h(async (req, res) => {
  if (!(await bcrypt.compare(req.body.currentPassword, req.user.passwordHash))) return wrongPassword(res);
  const user = await requestDeletion(req.userId);
  res.status(202).json({ accountStatus: 'pending_deletion', graceHours: DELETION_GRACE_HOURS, ...deletionInfo(user) });
}));

// Cancels a pending deletion. Safe to repeat (an account that is not pending just stays active).
router.post('/me/cancel-deletion', writeLimiter, h(async (req, res) => {
  const user = await cancelDeletion(req.userId);
  res.json({ accountStatus: 'active', requestedAt: null, deletesAt: null, message: 'Account deletion cancelled. Your account and all your data are unchanged.', user: publicUser(user) });
}));

// Edit name, phone or email. Only the fields sent change. Changing the email needs the current password.
// (authLimiter: wrong passwords here count towards the same 8-tries-per-15-minutes limit as login.)
router.put('/me', authLimiter, validate(schemas.profileUpdate), h(async (req, res) => {
  const { name, phone, email, currentPassword } = req.body;
  const sets = [];
  const params = [];
  const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };

  if (email !== undefined && email !== req.user.email) {
    if (!(await bcrypt.compare(currentPassword, req.user.passwordHash))) return wrongPassword(res);
    set('email', email);
  }
  if (name !== undefined) set('name', name || null);
  if (phone !== undefined) set('phone', phone || null);
  if (!sets.length) return res.json(publicUser(req.user)); // for example the same email again: nothing to change

  params.push(req.userId);
  try {
    const [user] = await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    res.json(publicUser(user));
  } catch (err) {
    // The UNIQUE constraint is the real guard, as at sign-up.
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    throw err;
  }
}));

// Changes the password. Every other login (all refresh tokens, and access tokens issued before now) is ended, and a fresh
// session is returned for this device, so the user stays signed in here: replace the stored tokens with these.
router.put('/me/password', authLimiter, validate(schemas.changePassword), h(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!(await bcrypt.compare(currentPassword, req.user.passwordHash))) return wrongPassword(res);
  if (newPassword === currentPassword) return wrongPassword(res, 'newPassword', 'New password must be different from the current one');

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await query(
    `WITH changed AS (
       UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2 RETURNING id
     ), signed_out AS (
       DELETE FROM refresh_tokens WHERE user_id = $2
     )
     SELECT id FROM changed`,
    [passwordHash, req.userId],
  );
  res.json({ token: signToken(req.userId), expiresIn: ACCESS_TOKEN_SECONDS, refreshToken: await issueRefreshToken(req.userId) });
}));

// Sets or replaces the profile picture (an image in the form field "avatar", at most 5 MB). The old picture is deleted
// once the new one is saved, so a user never has more than one stored.
router.put('/me/avatar', writeLimiter, uploadAvatar, h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  let stored;
  try {
    stored = await storeUpload(req.file, req.userId, 'avatar');
    const [row] = await query(
      'UPDATE users SET avatar_url = $1, avatar_public_id = $2 WHERE id = $3 RETURNING avatar_url',
      [stored.url ?? `/uploads/${stored.filename}`, stored.publicId, req.userId],
    );
    await removeStored({ url: req.user.avatarUrl, publicId: req.user.avatarPublicId });
    res.json({ avatarUrl: row.avatarUrl });
  } catch (err) {
    await discardUpload(req.file, stored); // the new picture is already stored; don't leave it without a record
    throw err;
  }
}));

// Removes the profile picture. Safe to repeat.
router.delete('/me/avatar', writeLimiter, h(async (req, res) => {
  await query('UPDATE users SET avatar_url = NULL, avatar_public_id = NULL WHERE id = $1', [req.userId]);
  await removeStored({ url: req.user.avatarUrl, publicId: req.user.avatarPublicId });
  res.json({ avatarUrl: null });
}));

router.put('/balance', writeLimiter, validate(schemas.balance), h(async (req, res) => {
  const [row] = await query('UPDATE users SET balance = $1 WHERE id = $2 RETURNING balance', [req.body.balance, req.userId]);
  await checkAlerts(req);
  res.json(row);
}));

router.put('/next-income', writeLimiter, validate(schemas.nextIncome), h(async (req, res) => {
  const [row] = await query(
    'UPDATE users SET next_income_amount = $1, next_income_date = $2 WHERE id = $3 RETURNING next_income_amount, next_income_date',
    [req.body.amount, req.body.date ?? null, req.userId],
  );
  await checkAlerts(req);
  res.json(row);
}));

router.put('/savings-goal', writeLimiter, validate(schemas.savingsGoal), h(async (req, res) => {
  const [row] = await query(
    'UPDATE users SET savings_goal_amount = $1, savings_goal_deadline = $2 WHERE id = $3 RETURNING savings_goal_amount, savings_goal_deadline',
    [req.body.amount, req.body.deadline ?? null, req.userId],
  );
  await checkAlerts(req);
  res.json(row);
}));

// ---- Financial profile: the numbers typed into the calculators, remembered between logins ----

const PROFILE_DEFAULTS = {
  monthlyIncome: 0, monthlyExpenses: 0, existingDebtPayments: 0, proposedPayment: 0,
  targetDtiRatio: 0.4, annualInterestRate: 0, loanTermMonths: 12, updatedAt: null,
};
const PROFILE_COLUMNS = `monthly_income, monthly_expenses, existing_debt_payments, proposed_payment,
  target_dti_ratio, annual_interest_rate, loan_term_months, updated_at`;

// Nothing saved yet is not an error: the defaults come back (updatedAt is null), so the app can always pre-fill its form.
router.get('/financial-profile', readLimiter, h(async (req, res) => {
  const [row] = await query(`SELECT ${PROFILE_COLUMNS} FROM financial_profiles WHERE user_id = $1`, [req.userId]);
  res.json(row ?? PROFILE_DEFAULTS);
}));

// Saves only the fields that were sent; the others keep their saved value (or their default the first time).
router.put('/financial-profile', writeLimiter, validate(schemas.financialProfile), h(async (req, res) => {
  const b = req.body;
  const [row] = await query(
    `INSERT INTO financial_profiles (user_id, monthly_income, monthly_expenses, existing_debt_payments, proposed_payment,
                                     target_dti_ratio, annual_interest_rate, loan_term_months)
     VALUES ($1, COALESCE($2::numeric, 0), COALESCE($3::numeric, 0), COALESCE($4::numeric, 0), COALESCE($5::numeric, 0),
             COALESCE($6::numeric, 0.4), COALESCE($7::numeric, 0), COALESCE($8::int, 12))
     ON CONFLICT (user_id) DO UPDATE SET
       monthly_income         = COALESCE($2::numeric, financial_profiles.monthly_income),
       monthly_expenses       = COALESCE($3::numeric, financial_profiles.monthly_expenses),
       existing_debt_payments = COALESCE($4::numeric, financial_profiles.existing_debt_payments),
       proposed_payment       = COALESCE($5::numeric, financial_profiles.proposed_payment),
       target_dti_ratio       = COALESCE($6::numeric, financial_profiles.target_dti_ratio),
       annual_interest_rate   = COALESCE($7::numeric, financial_profiles.annual_interest_rate),
       loan_term_months       = COALESCE($8::int, financial_profiles.loan_term_months),
       updated_at = now()
     RETURNING ${PROFILE_COLUMNS}`,
    [req.userId, b.monthlyIncome ?? null, b.monthlyExpenses ?? null, b.existingDebtPayments ?? null, b.proposedPayment ?? null,
      b.targetDtiRatio ?? null, b.annualInterestRate ?? null, b.loanTermMonths ?? null],
  );
  res.json(row);
}));

// ---- Bills ----

router.get('/bills', readLimiter, h(async (req, res) => {
  res.json(await query('SELECT * FROM bills WHERE user_id = $1 ORDER BY created_at', [req.userId]));
}));

router.post('/bills', writeLimiter, validate(schemas.bill), h(async (req, res) => {
  const { name, amount, dueDate } = req.body;
  const [bill] = await query(
    'INSERT INTO bills (user_id, name, amount, due_date) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.userId, name, amount, dueDate ?? null],
  );
  await checkAlerts(req);
  res.status(201).json(bill);
}));

// Edits a bill. Only the fields sent change; a dueDate of null removes the due date.
router.put('/bills/:id', writeLimiter, validate(schemas.billUpdate), h(async (req, res) => {
  const { name, amount, dueDate } = req.body;
  const sets = [];
  const params = [];
  const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
  if (name !== undefined) set('name', name);
  if (amount !== undefined) set('amount', amount);
  if (dueDate !== undefined) set('due_date', dueDate);
  params.push(req.params.id, req.userId);
  const [bill] = await query(
    `UPDATE bills SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
    params,
  );
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  await checkAlerts(req); // a changed amount or due date can change an alert
  res.json(bill);
}));

router.delete('/bills/:id', writeLimiter, h(async (req, res) => {
  const deleted = await query('DELETE FROM bills WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.userId]);
  if (!deleted.length) return res.status(404).json({ error: 'Bill not found' });
  await checkAlerts(req);
  res.json({ ok: true });
}));

// ---- Expenses ----

// Newest first. Filters: from/to (UTC days, both included), category (any letter case), minAmount, maxAmount.
// Paged with limit (default 100, max 500) and offset; the X-Total-Count header is the number of matches across all pages.
router.get('/expenses', readLimiter, validateQuery(schemas.expenseQuery), h(async (req, res) => {
  const { from, to, category, minAmount, maxAmount, limit, offset } = req.query;
  const where = ['user_id = $1'];
  const params = [req.userId];
  const add = (condition, value) => { params.push(value); where.push(condition.replace('?', '$' + params.length)); };
  if (from) add('date >= ?', new Date(from));
  if (to) add('date < ?', new Date(Date.parse(to) + 86_400_000));
  if (category) add('lower(category) = lower(?)', category);
  if (minAmount != null) add('amount >= ?', minAmount);
  if (maxAmount != null) add('amount <= ?', maxAmount);
  const filter = where.join(' AND ');

  const [expenses, [{ total }]] = await Promise.all([
    query(
      `SELECT * FROM expenses WHERE ${filter} ORDER BY date DESC, created_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    query(`SELECT count(*)::int AS total FROM expenses WHERE ${filter}`, params),
  ]);
  res.set('X-Total-Count', String(total));
  res.json(expenses);
}));

// One statement: the balance is reduced only if it covers the amount, and the expense is recorded only if it was.
// The UPDATE locks the user's row, so simultaneous expenses are checked one after another against the real balance.
router.post('/expenses', writeLimiter, validate(schemas.expense), h(async (req, res) => {
  const { amount, category, description, date } = req.body;
  const [expense] = await query(
    `WITH reduced AS (
       UPDATE users SET balance = balance - $2 WHERE id = $1 AND balance >= $2 RETURNING id
     ), new_expense AS (
       INSERT INTO expenses (user_id, amount, category, description, date)
       SELECT id, $2::numeric, $3::text, $4::text, $5::timestamptz FROM reduced RETURNING *
     )
     SELECT * FROM new_expense`,
    [req.userId, amount, category, description, date],
  );
  if (!expense) return res.status(422).json({ error: 'Insufficient balance' });
  await checkAlerts(req);
  res.status(201).json(expense);
}));

// Edits an expense and moves the balance by the difference, atomically. Raising the amount above what the balance
// can cover is refused (422) like a new expense would be. The user's row is locked first, then the expense, in the
// same order everywhere, so concurrent edits and deletes cannot deadlock or overspend.
router.put('/expenses/:id', writeLimiter, validate(schemas.expenseUpdate), h(async (req, res) => {
  const { amount, category, description, date } = req.body;
  const outcome = await withTransaction(async (tx) => {
    await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [req.userId]);
    const [old] = await tx.query('SELECT * FROM expenses WHERE id = $1 AND user_id = $2 FOR UPDATE', [req.params.id, req.userId]);
    if (!old) return { status: 404 };

    if (amount !== undefined && amount !== old.amount) {
      const adjusted = await tx.query(
        `UPDATE users SET balance = balance + $1::numeric - $2::numeric
         WHERE id = $3 AND balance + $1::numeric - $2::numeric >= 0 RETURNING id`,
        [old.amount, amount, req.userId],
      );
      if (!adjusted.length) return { status: 422 };
    }
    const [expense] = await tx.query(
      `UPDATE expenses SET amount = COALESCE($3::numeric, amount), category = COALESCE($4::text, category),
              description = COALESCE($5::text, description), date = COALESCE($6::timestamptz, date)
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId, amount ?? null, category ?? null, description ?? null, date ?? null],
    );
    return { expense };
  });
  if (outcome.status === 404) return res.status(404).json({ error: 'Expense not found' });
  if (outcome.status === 422) return res.status(422).json({ error: 'Insufficient balance' });
  await checkAlerts(req);
  res.json(outcome.expense);
}));

// Deleting an expense gives its amount back to the balance (a refund, or a mistake being undone).
router.delete('/expenses/:id', writeLimiter, h(async (req, res) => {
  const balance = await withTransaction(async (tx) => {
    await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [req.userId]);
    const [deleted] = await tx.query('DELETE FROM expenses WHERE id = $1 AND user_id = $2 RETURNING amount', [req.params.id, req.userId]);
    if (!deleted) return null;
    const [user] = await tx.query('UPDATE users SET balance = balance + $1::numeric WHERE id = $2 RETURNING balance', [deleted.amount, req.userId]);
    return user.balance;
  });
  if (balance === null) return res.status(404).json({ error: 'Expense not found' });
  await checkAlerts(req);
  res.json({ ok: true, balance });
}));

// ---- Files ----

router.post('/files', writeLimiter, upload.single('file'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { originalname, mimetype, size } = req.file;
  let stored;
  try {
    stored = await storeUpload(req.file, req.userId); // a no-op on disk; an upload to Cloudinary in the cloud
    const [record] = await query(
      `INSERT INTO files (user_id, filename, original_name, mimetype, size, url, public_id, resource_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.userId, stored.filename, originalname, mimetype, size, stored.url, stored.publicId, stored.resourceType],
    );
    logger.info(`File uploaded: ${record.id} by user ${req.userId}`); // not the client-chosen name: it may contain control characters
    res.status(201).json(withUrl(record));
  } catch (err) {
    await discardUpload(req.file, stored); // the file is already stored; don't leave it without a record
    throw err;
  }
}));

router.get('/files', readLimiter, h(async (req, res) => {
  const files = await query('SELECT * FROM files WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]);
  res.json(files.map(withUrl));
}));

// ---- Dashboard and calculators ----

router.get('/dashboard', readLimiter, h(async (req, res) => {
  const { balance, nextIncomeAmount, nextIncomeDate, savingsGoalAmount } = req.user;
  const [safeToSpend, recentExpenses, [{ unread }]] = await Promise.all([
    safeToSpendFor(req.user),
    query('SELECT * FROM expenses WHERE user_id = $1 ORDER BY date DESC LIMIT 5', [req.userId]),
    query('SELECT count(*)::int AS unread FROM alerts WHERE user_id = $1 AND read_at IS NULL', [req.userId]),
  ]);
  res.json({
    user: { balance, nextIncomeAmount, nextIncomeDate, savingsGoalAmount },
    safeToSpend,
    recentExpenses,
    unreadAlerts: unread,
    accountDeletion: deletionInfo(req.user), // null, or the pending-deletion notice to show as a banner
  });
}));

router.post('/can-i-afford', calcLimiter, validate(schemas.canIAfford), h(async (req, res) => {
  const safeToSpend = await safeToSpendFor(req.user);
  const result = canIAfford({ purchaseAmount: req.body.amount, safeToSpend, balance: req.user.balance });
  await query(
    'INSERT INTO affordability_checks (user_id, amount, recommendation) VALUES ($1, $2, $3)',
    [req.userId, req.body.amount, result.recommendation],
  );
  res.json({ ...result, safeToSpend });
}));

router.post('/forecast', calcLimiter, validate(schemas.forecast), h(async (req, res) => {
  res.json(await forecastFor(req.user, req.body));
}));

router.post('/projected-balance', calcLimiter, validate(schemas.projectedBalance), (req, res) => {
  res.json(calculateProjectedBalance(req.body));
});

router.post('/cash-flow', calcLimiter, validate(schemas.cashFlow), (req, res) => {
  const projection = generateCashFlowProjection(req.body, req.body.monthlyPayment, req.body.months);
  res.json({ projection, summary: summarizeCashFlow(projection) });
});

router.post('/affordability', calcLimiter, validate(schemas.affordability), (req, res) => {
  res.json(runAffordabilityCalculator(req.body));
});

router.use(alertsRouter);
router.use(analyticsRouter);

export default router;
