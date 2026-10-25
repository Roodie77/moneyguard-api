// The survival simulation checked against answers that can be worked out by hand (no database needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateSurvival, fitSpendModel, seededRandom, hashSeed, percent } from '../src/services/forecast.js';

const NO_SPENDING = { zeroDayShare: 1, mu: 0, sigma: 0.2 };
const bills = (days, byDay = {}) => Array.from({ length: days + 1 }, (_, d) => byDay[d] ?? 0);
const run = (overrides) => simulateSurvival({ balance: 1000, days: 5, billsByDay: bills(5), model: NO_SPENDING, seed: 7, ...overrides });

test('the same seed always gives the same answer', () => {
  const model = { zeroDayShare: 0.2, mu: 4, sigma: 0.8 };
  const a = run({ model, amount: 300 });
  const b = run({ model, amount: 300 });
  assert.deepEqual(a, b);
  assert.notEqual(run({ model, amount: 300, seed: 8 }).purchaseRuinProbability, undefined);
});

test('seededRandom is repeatable and hashSeed is stable', () => {
  const r1 = seededRandom(5);
  const r2 = seededRandom(5);
  assert.deepEqual([r1(), r1(), r1()], [r2(), r2(), r2()]);
  assert.equal(hashSeed('abc'), hashSeed('abc'));
  assert.notEqual(hashSeed('abc'), hashSeed('abd'));
});

test('no spending and no bills: never runs out, and the whole balance is the maximum purchase', () => {
  const r = run();
  assert.equal(r.baselineRuinProbability, 0);
  assert.equal(r.maxPurchaseNow, 1000);
});

test('a purchase bigger than the balance is certain ruin; one that fits exactly is not', () => {
  assert.equal(run({ amount: 1000.01 }).purchaseRuinProbability, 1);
  assert.equal(run({ amount: 1000 }).purchaseRuinProbability, 0);
});

test('bills that are due reduce what is safe, to the cent', () => {
  const r = run({ billsByDay: bills(5, { 2: 300, 5: 200 }) });
  assert.equal(r.baselineRuinProbability, 0);
  assert.equal(r.maxPurchaseNow, 500);
  assert.equal(run({ billsByDay: bills(5, { 5: 1200 }) }).baselineRuinProbability, 1); // a bill on the income day still counts
});

test('the protected buffer counts as already spent', () => {
  assert.equal(run({ buffer: 250 }).maxPurchaseNow, 750);
  assert.equal(run({ buffer: 250, amount: 800 }).purchaseRuinProbability, 1);
});

test('matches a hand-worked case: one day, spending log-normal with median 100, balance 100, so a 50% chance of running out', () => {
  const r = simulateSurvival({ balance: 100, days: 1, billsByDay: bills(1), model: { zeroDayShare: 0, mu: Math.log(100), sigma: 0.2 }, seed: 11 });
  assert.ok(Math.abs(r.baselineRuinProbability - 0.5) < 0.02, `got ${r.baselineRuinProbability}`);
});

test('maxPurchaseNow is the right quantile: balance 200, spending median 100 (sigma 0.2), 95% sure', () => {
  // slack = 200 - spend; its 5% quantile is 200 - 100 * exp(1.645 * 0.2) = 61.03
  const r = simulateSurvival({ balance: 200, days: 1, billsByDay: bills(1), model: { zeroDayShare: 0, mu: Math.log(100), sigma: 0.2 }, seed: 3, confidence: 0.95 });
  assert.ok(Math.abs(r.maxPurchaseNow - 61.03) < 3, `got ${r.maxPurchaseNow}`);
  // and buying exactly that keeps the chance of running out at about 5%
  const at = simulateSurvival({ balance: 200, days: 1, billsByDay: bills(1), model: { zeroDayShare: 0, mu: Math.log(100), sigma: 0.2 }, seed: 3, amount: r.maxPurchaseNow });
  assert.ok(Math.abs(at.purchaseRuinProbability - 0.05) < 0.01, `got ${at.purchaseRuinProbability}`);
});

test('more spending, or a bigger purchase, never lowers the chance of running out', () => {
  const calm = { zeroDayShare: 0.3, mu: 3.5, sigma: 0.6 };
  const heavy = { zeroDayShare: 0.3, mu: 4.5, sigma: 0.6 };
  const base = { balance: 2000, days: 10, billsByDay: bills(10) };
  assert.ok(simulateSurvival({ ...base, model: heavy }).baselineRuinProbability >= simulateSurvival({ ...base, model: calm }).baselineRuinProbability);
  let last = -1;
  for (const amount of [0, 200, 500, 900, 1500]) {
    const p = simulateSurvival({ ...base, model: calm, amount }).purchaseRuinProbability;
    assert.ok(p >= last, `${amount}: ${p} < ${last}`);
    last = p;
  }
});

test('ruinByDay never decreases and ends at the purchase chance; the worst-case shortfall is never negative', () => {
  const r = simulateSurvival({ balance: 800, days: 10, billsByDay: bills(10, { 4: 100 }), model: { zeroDayShare: 0.2, mu: 4.2, sigma: 0.8 }, amount: 300, seed: 5 });
  assert.equal(r.ruinByDay.length, 11);
  for (let i = 1; i < r.ruinByDay.length; i++) assert.ok(r.ruinByDay[i] >= r.ruinByDay[i - 1]);
  assert.equal(r.ruinByDay[10], r.purchaseRuinProbability);
  assert.ok(r.expectedShortfallInWorstCase >= 0);
});

test("what was already spent today is not counted twice", () => {
  const model = { zeroDayShare: 0, mu: Math.log(100), sigma: 0.2 };
  const base = { balance: 100, days: 1, billsByDay: bills(1), model, seed: 2 };
  assert.ok(simulateSurvival({ ...base, spentToday: 90 }).baselineRuinProbability < 0.05); // 90 of the day's ~100 is already gone
});

test('fitSpendModel: a new user gets the starting assumptions; history takes over as days accumulate', () => {
  const fresh = fitSpendModel({ dailyTotals: [], budgetPerDay: 1000 });
  assert.equal(fresh.source, 'default');
  assert.ok(fresh.meanDailySpend > 0 && fresh.meanDailySpend < 1000); // assumed to spend less than the whole budget

  const steady = fitSpendModel({ dailyTotals: Array(40).fill(500), budgetPerDay: 5000 });
  assert.equal(steady.source, 'history');
  assert.ok(steady.meanDailySpend > 450 && steady.meanDailySpend < 700, `got ${steady.meanDailySpend}`);

  const early = fitSpendModel({ dailyTotals: [500, 500, 500], budgetPerDay: 5000 });
  assert.equal(early.source, 'blended');
  assert.ok(early.meanDailySpend > steady.meanDailySpend); // still pulled up towards the assumption

  assert.ok(fitSpendModel({ dailyTotals: [0, 0, 0, 0], budgetPerDay: 0 }).meanDailySpend >= 0); // no NaN with no money
});

test('percent never shows a false 0% or 100%', () => {
  assert.equal(percent(0), 0);
  assert.equal(percent(0.0004), 1);
  assert.equal(percent(0.999), 99);
  assert.equal(percent(1), 100);
  assert.equal(percent(0.314), 31);
});
