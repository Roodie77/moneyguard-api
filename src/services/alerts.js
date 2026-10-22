import { query } from '../utils/db.js';
import logger from '../utils/logger.js';
import { notifyAlert } from './notifier.js';
import { safeToSpendFor, utcDayStart, utcMonthStart, nextUtcMonthStart } from './budget.js';

export const MAX_RULES_PER_USER = 50;
export const ALERT_RETENTION_DAYS = 90;

const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fmt = (n) => cents(n).toFixed(2);
const DAY_MS = 86_400_000;

// Checks the user's enabled rules against their current data and records an alert for each rule that is
// triggered and has not already fired for the same day, month or bill. Returns only the alerts created now.
// Never throws: it runs after the user's real action succeeded, and a failure here must not undo or hide that.
export async function evaluateAlerts(userId) {
  try {
    return await evaluate(userId);
  } catch (err) {
    logger.warn(`Alert evaluation failed for user ${userId}: ${err.message}`);
    return [];
  }
}

async function evaluate(userId) {
  const rules = await query('SELECT * FROM alert_rules WHERE user_id = $1 AND enabled', [userId]);
  if (!rules.length) return [];
  const [user] = await query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) return [];

  const has = (type) => rules.some((r) => r.type === type);
  const now = new Date();
  const dayStart = utcDayStart(now);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const today = dayStart.toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  let spentToday = 0;
  if (has('daily_spend_limit')) {
    const [row] = await query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = $1 AND date >= $2 AND date < $3',
      [userId, dayStart, dayEnd],
    );
    spentToday = cents(row.total);
  }

  let monthTotal = 0;
  const monthByCategory = new Map();
  if (has('monthly_spend_limit') || has('category_monthly_budget')) {
    const rows = await query(
      `SELECT lower(category) AS category, SUM(amount) AS total FROM expenses
       WHERE user_id = $1 AND date >= $2 AND date < $3 GROUP BY lower(category)`,
      [userId, utcMonthStart(now), nextUtcMonthStart(now)],
    );
    for (const r of rows) {
      monthByCategory.set(r.category, cents(r.total));
      monthTotal += Number(r.total);
    }
    monthTotal = cents(monthTotal);
  }

  const triggered = []; // { rule, periodKey, message, data }
  for (const rule of rules) {
    const threshold = rule.threshold;
    switch (rule.type) {
      case 'low_balance':
        if (user.balance < threshold) {
          triggered.push({
            rule, periodKey: today,
            message: `Your balance (${fmt(user.balance)}) is below your alert level of ${fmt(threshold)}.`,
            data: { balance: user.balance, threshold },
          });
        }
        break;
      case 'daily_spend_limit':
        if (spentToday > threshold) {
          triggered.push({
            rule, periodKey: today,
            message: `You've spent ${fmt(spentToday)} today, over your daily limit of ${fmt(threshold)}.`,
            data: { spent: spentToday, threshold },
          });
        }
        break;
      case 'monthly_spend_limit':
        if (monthTotal > threshold) {
          triggered.push({
            rule, periodKey: month,
            message: `You've spent ${fmt(monthTotal)} this month, over your monthly limit of ${fmt(threshold)}.`,
            data: { spent: monthTotal, threshold },
          });
        }
        break;
      case 'category_monthly_budget': {
        const spent = monthByCategory.get(rule.category.toLowerCase()) ?? 0;
        if (spent > threshold) {
          triggered.push({
            rule, periodKey: month,
            message: `You've spent ${fmt(spent)} on ${rule.category} this month, over your budget of ${fmt(threshold)}.`,
            data: { category: rule.category, spent, threshold },
          });
        }
        break;
      }
      case 'bill_due_soon': {
        const horizon = new Date(dayStart.getTime() + (threshold + 1) * DAY_MS);
        const bills = await query(
          'SELECT * FROM bills WHERE user_id = $1 AND due_date >= $2 AND due_date < $3 ORDER BY due_date',
          [userId, dayStart, horizon],
        );
        for (const bill of bills) {
          const daysAway = Math.floor((utcDayStart(bill.dueDate) - dayStart) / DAY_MS);
          const when = daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `in ${daysAway} days`;
          triggered.push({
            rule, periodKey: `bill:${bill.id}`,
            message: `${bill.name} (${fmt(bill.amount)}) is due ${when}.`,
            data: { billId: bill.id, name: bill.name, amount: bill.amount, dueDate: bill.dueDate, daysAway },
          });
        }
        break;
      }
      case 'over_safe_to_spend': {
        const safe = await safeToSpendFor(user);
        if (safe.remainingToday < 0) {
          triggered.push({
            rule, periodKey: today,
            message: `You've spent ${fmt(safe.spentToday)} today, more than your safe amount of ${fmt(safe.dailySafeToSpend)}.`,
            data: { spent: safe.spentToday, dailySafeToSpend: safe.dailySafeToSpend },
          });
        }
        break;
      }
    }
  }

  const created = [];
  for (const t of triggered) {
    // The UNIQUE (rule_id, period_key) constraint makes this safe when two requests evaluate at once.
    const [alert] = await query(
      `INSERT INTO alerts (user_id, rule_id, type, message, data, period_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (rule_id, period_key) DO NOTHING RETURNING *`,
      [userId, t.rule.id, t.rule.type, t.message, JSON.stringify(t.data), t.periodKey],
    );
    if (!alert) continue;
    created.push(alert);
    try {
      await notifyAlert(alert);
    } catch (err) {
      logger.warn(`Alert notification failed for ${alert.id}: ${err.message}`);
    }
  }
  return created;
}

export const purgeOldAlerts = () =>
  query('DELETE FROM alerts WHERE created_at < now() - make_interval(days => $1)', [ALERT_RETENTION_DAYS]);
