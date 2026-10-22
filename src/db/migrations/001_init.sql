CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL UNIQUE CHECK (email = lower(email)),
  phone                 text,
  password_hash         text NOT NULL,
  balance               numeric(15,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  next_income_amount    numeric(15,2) NOT NULL DEFAULT 0 CHECK (next_income_amount >= 0),
  next_income_date      timestamptz,
  savings_goal_amount   numeric(15,2) NOT NULL DEFAULT 0 CHECK (savings_goal_amount >= 0),
  savings_goal_deadline timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bills (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  amount     numeric(15,2) NOT NULL CHECK (amount > 0),
  due_date   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bills_user_idx ON bills (user_id);

CREATE TABLE expenses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      numeric(15,2) NOT NULL CHECK (amount > 0),
  category    text NOT NULL DEFAULT 'Other',
  description text NOT NULL DEFAULT '',
  date        timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_user_date_idx ON expenses (user_id, date DESC);

CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  original_name text NOT NULL,
  mimetype      text NOT NULL,
  size          integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_user_idx ON files (user_id);

CREATE TABLE affordability_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount         numeric(15,2) NOT NULL,
  recommendation text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX affordability_checks_user_idx ON affordability_checks (user_id);
