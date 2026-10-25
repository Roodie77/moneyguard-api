// Shared set-up for the forecast tests (not a test file itself).
import { registerUser } from './helpers.js';

export const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

// A user with 40 days of steady spending (about 300 a day), a bill and the next income 10 days away. Made with SQL so the
// test does not depend on the API's write limits.
export async function userWithHistory(app, query, { balance = 10_000, perDay = 300, historyDays = 40 } = {}) {
  const u = await registerUser(app.api);
  const id = u.user.id;
  await query("UPDATE users SET balance = $2, next_income_date = $3, created_at = now() - interval '45 days' WHERE id = $1", [id, balance, days(10)]);
  await query('INSERT INTO bills (user_id, name, amount, due_date) VALUES ($1, $2, $3, $4)', [id, 'Rent', 2000, days(4)]);
  for (let i = 1; i <= historyDays; i++) {
    await query("INSERT INTO expenses (user_id, amount, date) VALUES ($1, $2, now() - ($3 || ' days')::interval)", [id, perDay + (i % 5) * 20, String(i)]);
  }
  return u;
}

