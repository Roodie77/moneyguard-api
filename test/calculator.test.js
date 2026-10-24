import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateProjectedBalance,
  calculateMaxPayment,
  calculateLoanAmountFromPayment,
  calculatePaymentFromLoan,
  generateCashFlowProjection,
  summarizeCashFlow,
  calculateSafeToSpend,
  canIAfford,
} from '../src/services/calculator.js';

const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
const round2 = (n) => Math.round(n * 100) / 100;

test('projected balance: income minus all commitments', () => {
  const r = calculateProjectedBalance({ monthlyIncome: 450000, ordinaryExpenses: 180000, existingEMI: 35000, proposedEMI: 50000 });
  assert.equal(r.projectedBalance, 185000);
  assert.equal(r.shortfall, 0);
  assert.equal(r.isNegative, false);
  assert.equal(r.warning, null);
});

test('projected balance: negative result reports the shortfall and a warning', () => {
  const r = calculateProjectedBalance({ monthlyIncome: 1000, ordinaryExpenses: 800, existingEMI: 200, proposedEMI: 100 });
  assert.equal(r.projectedBalance, -100);
  assert.equal(r.shortfall, 100);
  assert.equal(r.isNegative, true);
  assert.match(r.warning, /exceed your income by 100/);
});

test('projected balance: zero buffer is flagged', () => {
  const r = calculateProjectedBalance({ monthlyIncome: 1000, ordinaryExpenses: 1000 });
  assert.equal(r.projectedBalance, 0);
  assert.match(r.warning, /no remaining buffer/);
});

test('projected balance: floating point noise is rounded away (0.3 - 0.1 - 0.1 - 0.1)', () => {
  const r = calculateProjectedBalance({ monthlyIncome: 0.3, ordinaryExpenses: 0.1, existingEMI: 0.1, proposedEMI: 0.1 });
  assert.ok(r.projectedBalance === 0); // `===` on purpose: rounding can yield -0, which JSON prints as 0
  assert.equal(r.isNegative, false);
});

test('projected balance: negative inputs are treated as 0', () => {
  assert.equal(calculateProjectedBalance({ monthlyIncome: -5 }).monthlyIncome, 0);
});

test('max payment: income x DTI minus existing debt, never below 0', () => {
  assert.equal(calculateMaxPayment({ monthlyGrossIncome: 1000, targetDtiRatio: 0.4, existingMonthlyDebtPayments: 100 }), 300);
  assert.equal(calculateMaxPayment({ monthlyGrossIncome: 1000, targetDtiRatio: 0.4, existingMonthlyDebtPayments: 900 }), 0);
});

test('loan maths: 10,000 at 12% over 12 months is about 888.49 a month, and back again', () => {
  const payment = calculatePaymentFromLoan(10000, 0.12, 12);
  assert.equal(payment, 888.49);
  assert.ok(Math.abs(calculateLoanAmountFromPayment(payment, 0.12, 12) - 10000) < 1);
});

test('loan maths: zero interest divides evenly; invalid rate or term returns 0', () => {
  assert.equal(calculatePaymentFromLoan(1200, 0, 12), 100);
  assert.equal(calculateLoanAmountFromPayment(100, 0, 12), 1200);
  assert.equal(calculatePaymentFromLoan(1200, 12, 12), 0); // 12 = "1200%": the rate is a fraction, so rejected
  assert.equal(calculatePaymentFromLoan(1200, 0.1, 0), 0);
});

test('cash flow: balance carries from month to month', () => {
  const inputs = { startingCashBalance: 100, monthlyGrossIncome: 1000, existingMonthlyDebtPayments: 200, otherMonthlyExpenses: 300 };
  const projection = generateCashFlowProjection(inputs, 100, 3);
  assert.deepEqual(projection.map((m) => m.endingBalance), [500, 900, 1300]);
});

test('cash flow: months are clamped to 1..120', () => {
  assert.equal(generateCashFlowProjection({}, 0, 9999).length, 120);
  assert.equal(generateCashFlowProjection({}, 0, 0).length, 1);
});

test('cash flow summary: lists negative months and the lowest balance', () => {
  const projection = generateCashFlowProjection({ startingCashBalance: 50, monthlyGrossIncome: 100, otherMonthlyExpenses: 200 }, 0, 2);
  const summary = summarizeCashFlow(projection);
  assert.deepEqual(summary.negativeMonths, [1, 2]);
  assert.equal(summary.lowestEndingBalance, -150);
  assert.equal(summary.warnings.length, 1);
  assert.deepEqual(summarizeCashFlow([]), { totalMonths: 0, negativeMonths: [], lowestEndingBalance: 0, warnings: [] });
});

test('safe to spend: bills due before the next income are reserved, later ones are not', () => {
  const r = calculateSafeToSpend({
    balance: 1000,
    nextIncomeDate: daysFromNow(10),
    bills: [
      { amount: 200, dueDate: daysFromNow(5) },
      { amount: 300, dueDate: daysFromNow(20) },
    ],
    todayExpenses: [{ amount: 20 }],
  });
  assert.equal(r.upcomingBillsTotal, 200);
  assert.equal(r.availableAfterCommitments, 800);
  // The 20 spent today is already out of the 1000, so this morning there was 820 to share (days is 10, or 11 across a DST change).
  assert.equal(r.dailySafeToSpend, round2(820 / r.daysUntilNextIncome));
  assert.equal(r.spentToday, 20);
  assert.equal(r.remainingToday, round2(r.dailySafeToSpend - 20));
});

test('safe to spend: spending is not counted twice, so the daily allowance stays the same all day', () => {
  const base = { nextIncomeDate: daysFromNow(10) };
  const morning = calculateSafeToSpend({ ...base, balance: 1000 });
  // After spending 60 the balance is 940 and 60 is "spent today". The allowance must not shrink because of it.
  const evening = calculateSafeToSpend({ ...base, balance: 940, todayExpenses: [{ amount: 60 }] });
  assert.equal(evening.dailySafeToSpend, morning.dailySafeToSpend);
  assert.equal(evening.remainingToday, round2(morning.dailySafeToSpend - 60));
});

test('safe to spend: spending a little less than the allowance never shows "nothing left" or "over budget"', () => {
  const base = { nextIncomeDate: daysFromNow(10) };
  const allowance = calculateSafeToSpend({ ...base, balance: 1000 }).dailySafeToSpend; // about 100
  const spent = round2(allowance - 5);
  const r = calculateSafeToSpend({ ...base, balance: round2(1000 - spent), todayExpenses: [{ amount: spent }] });
  assert.equal(r.remainingToday, 5);
  assert.ok(!r.warnings.includes("Already over today's safe amount."));
});

test('safe to spend: spending more than the allowance does show as over budget, by the right amount', () => {
  const base = { nextIncomeDate: daysFromNow(10) };
  const allowance = calculateSafeToSpend({ ...base, balance: 1000 }).dailySafeToSpend;
  const spent = round2(allowance + 30);
  const r = calculateSafeToSpend({ ...base, balance: round2(1000 - spent), todayExpenses: [{ amount: spent }] });
  assert.equal(r.remainingToday, -30);
  assert.ok(r.warnings.includes("Already over today's safe amount."));
});

test('safe to spend: savings reserve is a quarter of the goal, capped at 20% of the balance', () => {
  const base = { balance: 1000, nextIncomeDate: daysFromNow(10) };
  assert.equal(calculateSafeToSpend({ ...base, savingsGoalAmount: 400 }).savingsReserve, 100);
  assert.equal(calculateSafeToSpend({ ...base, savingsGoalAmount: 4000 }).savingsReserve, 200);
});

test('safe to spend: bills larger than the balance give 0 per day and a warning', () => {
  const r = calculateSafeToSpend({ balance: 100, nextIncomeDate: daysFromNow(5), bills: [{ amount: 500, dueDate: daysFromNow(1) }] });
  assert.equal(r.availableAfterCommitments, -400);
  assert.equal(r.dailySafeToSpend, 0);
  assert.ok(r.warnings.includes('Commitments exceed current balance.'));
});

test('safe to spend: missing or past income date falls back instead of dividing by zero', () => {
  const none = calculateSafeToSpend({ balance: 300 });
  assert.ok(none.warnings.includes('No next income date; using 30 days.'));
  assert.ok(none.daysUntilNextIncome >= 30);

  const past = calculateSafeToSpend({ balance: 300, nextIncomeDate: daysFromNow(-3) });
  assert.equal(past.daysUntilNextIncome, 1);
  assert.ok(Number.isFinite(past.dailySafeToSpend));
});

test('can I afford: Safe, ThinkTwice and NotRecommended thresholds', () => {
  const safeToSpend = { remainingToday: 100, availableAfterCommitments: 1000, daysUntilNextIncome: 10 };
  const check = (purchaseAmount) => canIAfford({ purchaseAmount, safeToSpend, balance: 500 });

  assert.equal(check(10).recommendation, 'Safe');
  assert.equal(check(150).recommendation, 'ThinkTwice'); // above today's 100, below double
  assert.equal(check(250).recommendation, 'NotRecommended'); // more than double
  assert.equal(check(10).remainingAfterPurchase, 90);
});

test('can I afford: already over budget, or an invalid amount, is never recommended', () => {
  assert.equal(canIAfford({ purchaseAmount: 1, safeToSpend: { remainingToday: -5, availableAfterCommitments: 100 }, balance: 100 }).recommendation, 'NotRecommended');
  assert.equal(canIAfford({ purchaseAmount: 0, safeToSpend: {}, balance: 100 }).recommendation, 'NotRecommended');
});
