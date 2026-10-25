import { query } from '../utils/db.js';
import { calculateSafeToSpend } from './calculator.js';
import { MAX_HORIZON_DAYS, fitSpendModel, simulateSurvival, hashSeed, percent, roundProbability, roundMoney } from './forecast.js';

export const utcDayStart = (date = new Date()) => new Date(date.toISOString().slice(0, 10));
export const utcMonthStart = (date = new Date()) => new Date(`${date.toISOString().slice(0, 7)}-01`);
export const nextUtcMonthStart = (date = new Date()) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));

// Today's safe-to-spend figure for a user row (all "today" maths use the UTC day).
export async function safeToSpendFor(user) {
  const dayStart = utcDayStart();
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const [bills, todayExpenses] = await Promise.all([
    query('SELECT * FROM bills WHERE user_id = $1', [user.id]),
    query('SELECT amount FROM expenses WHERE user_id = $1 AND date >= $2 AND date < $3', [user.id, dayStart, dayEnd]),
  ]);
  return calculateSafeToSpend({
    balance: user.balance,
    nextIncomeDate: user.nextIncomeDate,
    bills,
    savingsGoalAmount: user.savingsGoalAmount,
    todayExpenses,
  });
}

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 60;
const DISCLAIMER =
  'An estimate from your own spending history. It cannot foresee one-off emergencies and is not financial advice.';

// The survival forecast for a user row: learns their spending from the last 60 days, simulates the days until the next
// income, and answers "what is the chance I run out?" and "how much can I safely spend?" (see services/forecast.js).
export async function forecastFor(user, { amount = 0, inDays = 0, confidence = 0.95 } = {}) {
  const dayStart = utcDayStart();
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const historyFrom = new Date(dayStart.getTime() - HISTORY_DAYS * DAY_MS);
  const [bills, todayExpenses, history] = await Promise.all([
    query('SELECT * FROM bills WHERE user_id = $1', [user.id]),
    query('SELECT amount FROM expenses WHERE user_id = $1 AND date >= $2 AND date < $3', [user.id, dayStart, dayEnd]),
    query(
      `SELECT to_char((date AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, sum(amount)::float8 AS total
         FROM expenses WHERE user_id = $1 AND date >= $2 AND date < $3 GROUP BY 1`,
      [user.id, historyFrom, dayStart],
    ),
  ]);
  const safe = calculateSafeToSpend({
    balance: user.balance,
    nextIncomeDate: user.nextIncomeDate,
    bills,
    savingsGoalAmount: user.savingsGoalAmount,
    todayExpenses,
  });
  const warnings = [...safe.warnings];

  const days = Math.min(safe.daysUntilNextIncome, MAX_HORIZON_DAYS);
  if (days < safe.daysUntilNextIncome) warnings.push(`Next income is ${safe.daysUntilNextIncome} days away; only the next ${MAX_HORIZON_DAYS} days are forecast.`);

  // Bills fall on their due day. One with no date, or already past, is still owed, so it is counted today (as in safe-to-spend).
  const billsByDay = new Array(days + 1).fill(0);
  for (const bill of bills) {
    const due = bill.dueDate ? new Date(bill.dueDate).getTime() : 0;
    if (Number.isNaN(due) || Number(bill.amount) <= 0) continue;
    const index = Math.max(0, Math.floor((due - dayStart.getTime()) / DAY_MS));
    if (index <= days) billsByDay[index] += Number(bill.amount);
  }

  // Observed spending days: from the first day we have any trace of the user (up to 60 days back) until yesterday.
  const totals = new Map(history.map((row) => [row.day, row.total]));
  const firstSeen = [new Date(user.createdAt), ...history.map((row) => new Date(row.day))]
    .map((d) => utcDayStart(d).getTime())
    .reduce((a, b) => Math.min(a, b));
  const from = Math.max(historyFrom.getTime(), firstSeen);
  const observed = Math.max(0, Math.round((dayStart.getTime() - from) / DAY_MS));
  const dailyTotals = Array.from({ length: observed }, (_, i) => totals.get(new Date(from + i * DAY_MS).toISOString().slice(0, 10)) ?? 0);

  const model = fitSpendModel({ dailyTotals, budgetPerDay: Math.max(0, safe.availableAfterCommitments) / safe.daysUntilNextIncome });
  const result = simulateSurvival({
    balance: Math.max(0, Number(user.balance)),
    buffer: safe.savingsReserve,
    days,
    billsByDay,
    model,
    amount,
    inDays,
    confidence,
    spentToday: safe.spentToday,
    seed: hashSeed(`${user.id}:${dayStart.toISOString().slice(0, 10)}`),
  });

  const risk = 1 - confidence;
  const dateOf = (offset) => new Date(dayStart.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
  const response = {
    confidence,
    horizonDays: days,
    nextIncomeDate: dateOf(safe.daysUntilNextIncome),
    survivalProbability: roundProbability(1 - result.baselineRuinProbability),
    ruinProbability: roundProbability(result.baselineRuinProbability),
    maxPurchaseNow: roundMoney(result.maxPurchaseNow),
    averageMethod: { dailySafeToSpend: safe.dailySafeToSpend, daysUntilNextIncome: safe.daysUntilNextIncome },
    purchase: null,
    ruinByDay: result.ruinByDay.map((p, d) => ({ inDays: d, date: dateOf(d), ruinProbability: roundProbability(p) })),
    model: {
      source: model.source,
      observedDays: model.observedDays,
      meanDailySpend: roundMoney(model.meanDailySpend),
      zeroSpendDayShare: roundProbability(model.zeroDayShare),
      paths: result.paths,
    },
    summary: '',
    warnings,
    disclaimer: DISCLAIMER,
  };

  response.summary = `Without any new purchase you have about a ${percent(response.survivalProbability)}% chance of making it to your next income. ` +
    `The most you can spend now while keeping the risk of running out under ${percent(risk)}% is ${response.maxPurchaseNow}.`;

  if (amount > 0) {
    const ruin = result.purchaseRuinProbability;
    const verdict = ruin <= risk ? 'Safe' : ruin <= Math.min(0.5, risk * 3) ? 'ThinkTwice' : 'NotRecommended';
    response.purchase = {
      amount,
      inDays,
      ruinProbability: roundProbability(ruin),
      survivalProbability: roundProbability(1 - ruin),
      expectedShortfallInWorstCase: roundMoney(result.expectedShortfallInWorstCase),
      verdict,
    };
    if (inDays >= days) warnings.push('That day is on or after your next income, so the purchase does not put this period at risk.');
    const when = inDays === 0 ? 'today' : `in ${inDays} day(s)`;
    response.summary = `Buying ${amount} ${when} leaves about a ${percent(ruin)}% chance of running out before your next income` +
      (verdict === 'Safe' ? ', within your chosen risk.' : '.') +
      (verdict !== 'Safe' ? ` Waiting until your next income (${response.nextIncomeDate}) takes it out of this period's risk, or try a smaller amount: up to ${response.maxPurchaseNow} stays within your chosen risk.` : '');
  }
  return response;
}
