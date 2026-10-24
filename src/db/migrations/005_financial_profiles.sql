-- The numbers a user types into the calculators (monthly income, expenses, loan payments, interest...), saved so the
-- app can fill them in again after the user logs out and back in. One row per user, created the first time they save.
CREATE TABLE financial_profiles (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_income       numeric(15,2) NOT NULL DEFAULT 0   CHECK (monthly_income >= 0),
  monthly_expenses     numeric(15,2) NOT NULL DEFAULT 0   CHECK (monthly_expenses >= 0),
  existing_debt_payments numeric(15,2) NOT NULL DEFAULT 0 CHECK (existing_debt_payments >= 0),
  proposed_payment     numeric(15,2) NOT NULL DEFAULT 0   CHECK (proposed_payment >= 0),
  target_dti_ratio     numeric(5,4)  NOT NULL DEFAULT 0.4 CHECK (target_dti_ratio BETWEEN 0 AND 1),
  annual_interest_rate numeric(7,6)  NOT NULL DEFAULT 0   CHECK (annual_interest_rate BETWEEN 0 AND 1),
  loan_term_months     integer       NOT NULL DEFAULT 12  CHECK (loan_term_months BETWEEN 1 AND 480),
  updated_at           timestamptz   NOT NULL DEFAULT now()
);
