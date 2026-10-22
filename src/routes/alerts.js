import express from 'express';
import { query } from '../utils/db.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { uuidParam } from '../middleware/uuidParam.js';
import { writeLimiter, readLimiter } from '../middleware/rateLimit.js';
import * as schemas from '../validation/schemas.js';
import { evaluateAlerts, MAX_RULES_PER_USER } from '../services/alerts.js';

// Mounted inside the authenticated /api router: req.userId is set.
const router = express.Router();
router.param('id', uuidParam);

const RULE_COLUMNS = 'id, user_id, type, threshold, category, enabled, created_at, updated_at';

// ---- Rules: the thresholds the user chooses. There are no default rules. ----

router.get('/alert-rules', readLimiter, h(async (req, res) => {
  res.json(await query(`SELECT ${RULE_COLUMNS} FROM alert_rules WHERE user_id = $1 ORDER BY created_at, id`, [req.userId]));
}));

// Creates the rule, or updates the user's existing rule of the same type (and category, for category budgets).
router.put('/alert-rules', writeLimiter, validate(schemas.alertRule), h(async (req, res) => {
  const { type, threshold, category, enabled } = req.body;

  const [{ total }] = await query('SELECT count(*)::int AS total FROM alert_rules WHERE user_id = $1', [req.userId]);
  if (total >= MAX_RULES_PER_USER) {
    const [existing] = await query(
      "SELECT 1 FROM alert_rules WHERE user_id = $1 AND type = $2 AND category_key = coalesce(lower($3::text), '')",
      [req.userId, type, category ?? null],
    );
    if (!existing) return res.status(422).json({ error: `At most ${MAX_RULES_PER_USER} alert rules are allowed` });
  }

  const [rule] = await query(
    `INSERT INTO alert_rules (user_id, type, threshold, category, enabled)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, type, category_key) DO UPDATE
       SET threshold = EXCLUDED.threshold, category = EXCLUDED.category, enabled = EXCLUDED.enabled, updated_at = now()
     RETURNING ${RULE_COLUMNS}`,
    [req.userId, type, threshold ?? null, category ?? null, enabled],
  );
  await evaluateAlerts(req.userId); // a new rule may already be triggered by the current data
  res.json(rule);
}));

// The alerts it already produced stay in the history.
router.delete('/alert-rules/:id', writeLimiter, h(async (req, res) => {
  const deleted = await query('DELETE FROM alert_rules WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.userId]);
  if (!deleted.length) return res.status(404).json({ error: 'Alert rule not found' });
  res.json({ ok: true });
}));

// ---- Alerts: what the rules found ----

// Checks the rules first, so time-based alerts (a bill coming due) appear without anything else having happened.
router.get('/alerts', readLimiter, validateQuery(schemas.alertsQuery), h(async (req, res) => {
  const { unread, limit, offset } = req.query;
  await evaluateAlerts(req.userId);

  const filter = unread ? 'user_id = $1 AND read_at IS NULL' : 'user_id = $1';
  const [alerts, [counts]] = await Promise.all([
    query(
      `SELECT * FROM alerts WHERE ${filter} ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset],
    ),
    query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE read_at IS NULL)::int AS unread
       FROM alerts WHERE user_id = $1`,
      [req.userId],
    ),
  ]);
  res.json({ alerts, unreadCount: counts.unread, total: unread ? counts.unread : counts.total });
}));

router.post('/alerts/read-all', writeLimiter, h(async (req, res) => {
  const updated = await query('UPDATE alerts SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING id', [req.userId]);
  res.json({ updated: updated.length });
}));

// Marking an already-read alert read again is fine and keeps its first read time.
router.post('/alerts/:id/read', writeLimiter, h(async (req, res) => {
  const [alert] = await query(
    'UPDATE alerts SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING *',
    [req.params.id, req.userId],
  );
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  res.json(alert);
}));

export default router;
