import express from 'express';
import { query } from '../utils/db.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { validateQuery } from '../middleware/validate.js';
import { readLimiter } from '../middleware/rateLimit.js';
import * as schemas from '../validation/schemas.js';
import { utcDayStart } from '../services/budget.js';

// Mounted inside the authenticated /api router: req.userId is set.
const router = express.Router();

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 731;
const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Spending over a range of UTC days (both ends included; default: the last 30 days up to today).
// "Day" and "month" buckets are UTC, like every other date calculation in the API.
router.get('/analytics/summary', readLimiter, validateQuery(schemas.analyticsQuery), h(async (req, res) => {
  const to = req.query.to ?? isoDay(utcDayStart().getTime());
  const from = req.query.from ?? isoDay(Date.parse(to) - 29 * DAY_MS);
  const days = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
  if (days < 1 || days > MAX_RANGE_DAYS) {
    const message = days < 1 ? 'from must not be after to' : `the range from..to can be at most ${MAX_RANGE_DAYS} days`;
    return res.status(400).json({ error: 'Validation failed', details: [{ field: 'from', message }] });
  }

  const start = new Date(from);
  const end = new Date(Date.parse(to) + DAY_MS);
  const bucket = req.query.groupBy === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
  const params = [req.userId, start, end];

  const [[totals], categories, series] = await Promise.all([
    query(
      'SELECT COALESCE(SUM(amount), 0) AS total, count(*)::int AS count FROM expenses WHERE user_id = $1 AND date >= $2 AND date < $3',
      params,
    ),
    // Categories are free text, so "Food" and "food" are one group; MIN() picks a spelling to display.
    query(
      `SELECT MIN(category) AS category, SUM(amount) AS total, count(*)::int AS count
       FROM expenses WHERE user_id = $1 AND date >= $2 AND date < $3
       GROUP BY lower(category) ORDER BY SUM(amount) DESC, lower(category)`,
      params,
    ),
    query(
      `SELECT to_char(date AT TIME ZONE 'UTC', '${bucket}') AS period, SUM(amount) AS total, count(*)::int AS count
       FROM expenses WHERE user_id = $1 AND date >= $2 AND date < $3
       GROUP BY 1 ORDER BY 1`,
      params,
    ),
  ]);

  const totalSpent = cents(totals.total);
  res.json({
    from,
    to,
    groupBy: req.query.groupBy,
    days,
    totalSpent,
    transactionCount: totals.count,
    averageDailySpend: cents(totalSpent / days),
    topCategory: categories[0]?.category ?? null,
    byCategory: categories.map((c) => ({
      category: c.category,
      total: cents(c.total),
      count: c.count,
      percent: totalSpent > 0 ? Math.round((c.total / totalSpent) * 1000) / 10 : 0,
    })),
    series: series.map((s) => ({ period: s.period, total: cents(s.total), count: s.count })), // periods with no spending are omitted
  });
}));

export default router;
