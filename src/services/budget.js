import { query } from '../utils/db.js';
import { calculateSafeToSpend } from './calculator.js';

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
