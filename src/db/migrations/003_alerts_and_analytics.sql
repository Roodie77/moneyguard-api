-- Category filters and the analytics grouping use lower(category); categories are free text.
CREATE INDEX expenses_user_category_idx ON expenses (user_id, lower(category), date DESC);

-- A rule the user sets. One rule per type (and per category for category budgets).
-- threshold meaning by type: low_balance = balance floor, *_spend_limit and category budget = amount,
-- bill_due_soon = days ahead, over_safe_to_spend = none (it compares against the safe-to-spend figure).
CREATE TABLE alert_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN (
                 'low_balance', 'daily_spend_limit', 'monthly_spend_limit',
                 'category_monthly_budget', 'bill_due_soon', 'over_safe_to_spend')),
  threshold    numeric(15,2) CHECK (threshold > 0),
  category     text,
  category_key text GENERATED ALWAYS AS (coalesce(lower(category), '')) STORED,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'over_safe_to_spend') = (threshold IS NULL)),
  CHECK ((type = 'category_monthly_budget') = (category IS NOT NULL)),
  UNIQUE (user_id, type, category_key)
);

-- A rule that fired. period_key says which day, month or bill it was for, so a rule fires once per period.
-- Alerts outlive their rule (rule_id becomes NULL) so history is not lost when a rule is deleted.
CREATE TABLE alerts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id    uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  type       text NOT NULL,
  message    text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  period_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  UNIQUE (rule_id, period_key)
);
CREATE INDEX alerts_user_created_idx ON alerts (user_id, created_at DESC);
CREATE INDEX alerts_user_unread_idx ON alerts (user_id) WHERE read_at IS NULL;
