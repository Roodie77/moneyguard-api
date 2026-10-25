// Survival forecast: the chance that a user's money lasts until the next income, found by simulation.
//
// Today's "safe to spend" divides the money left by the days left. That is an average, and it hides risk: two people with
// the same balance can have very different chances of running out, because spending is lumpy. Here the days up to the
// next income are simulated many times (Monte Carlo). Bills fall on their due dates; daily spending is random, drawn from
// a distribution learned from the user's own history. Every question is then answered from the simulated futures:
//   - P(ruin): the share of futures where the balance drops below the protected buffer (balance < buffer);
//   - the largest purchase that keeps P(ruin) under the user's chosen risk (a quantile of the "slack" of each future);
//   - the chance of having run out by each day, a curve showing when the danger is.
// Pure functions only (no database, no clock), so a seeded run always gives the same numbers and the tests can pin them.

export const MAX_HORIZON_DAYS = 90;
export const DEFAULT_PATHS = 10_000;
// How many "days of evidence" the starting assumptions are worth when learning from history. The typical size of a day's
// spending is learned fastest (the budget is only a rough guide to it); the spread and the zero days lean on it longer.
const PRIOR_DAYS_LEVEL = 3;
const PRIOR_DAYS_SPREAD = 7;
const PRIOR_DAYS_ZERO = 14;
const PRIOR_SIGMA = 0.9; // spread of a typical spending day (log scale)
const PRIOR_ZERO_DAYS = 0.25; // share of days with no spending, assumed for someone new
const PRIOR_SPEND_SHARE = 0.6; // a new user is assumed to spend this share of their budget (not all of it)
const SIGMA_RANGE = [0.2, 2];

const round = (n, places = 2) => Math.round((n + Number.EPSILON) * 10 ** places) / 10 ** places;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Small, fast, seedable random numbers (mulberry32). The same seed always gives the same sequence.
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A stable 32-bit number from text, to seed a user's forecast (same user, same day, same answer).
export function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Learns how one day of spending behaves: a share of days with no spending, and on the other days a log-normal amount
// (spending is skewed: many small days, a few big ones). Few observed days lean on the starting assumptions (the budget),
// so a brand-new user still gets a sensible model; with more days the user's own history takes over.
export function fitSpendModel({ dailyTotals = [], budgetPerDay = 0 }) {
  const days = dailyTotals.map((v) => Math.max(0, num(v)));
  const n = days.length;
  const positives = days.filter((v) => v > 0);
  const nPos = positives.length;

  const priorMean = Math.max(0.01, PRIOR_SPEND_SHARE * Math.max(0, num(budgetPerDay)) / (1 - PRIOR_ZERO_DAYS));
  const priorMu = Math.log(priorMean) - PRIOR_SIGMA ** 2 / 2;

  const p0 = (n - nPos + PRIOR_DAYS_ZERO * PRIOR_ZERO_DAYS) / (n + PRIOR_DAYS_ZERO);
  const logs = positives.map(Math.log);
  const meanLog = nPos ? logs.reduce((s, v) => s + v, 0) / nPos : 0;
  const varLog = nPos > 1 ? logs.reduce((s, v) => s + (v - meanLog) ** 2, 0) / (nPos - 1) : 0;
  const mu = (nPos * meanLog + PRIOR_DAYS_LEVEL * priorMu) / (nPos + PRIOR_DAYS_LEVEL);
  const variance = (Math.max(nPos - 1, 0) * varLog + PRIOR_DAYS_SPREAD * PRIOR_SIGMA ** 2) / (Math.max(nPos - 1, 0) + PRIOR_DAYS_SPREAD);
  const sigma = Math.min(SIGMA_RANGE[1], Math.max(SIGMA_RANGE[0], Math.sqrt(variance)));

  return {
    source: n === 0 ? 'default' : n < 28 ? 'blended' : 'history',
    observedDays: n,
    zeroDayShare: p0,
    mu,
    sigma,
    meanDailySpend: (1 - p0) * Math.exp(mu + sigma ** 2 / 2),
  };
}

// Runs the simulation. Day 0 is today; the money is at risk on days 0..days-1 and bills due on the income day itself are
// still taken (the income may not have arrived yet). A purchase happens at the start of day `inDays`.
//   billsByDay: length days+1, the bill money due on each day (index `days` is the income day).
//   spentToday: already taken out of the balance, so today's random spending is reduced by it (never below 0).
export function simulateSurvival({
  balance,
  buffer = 0,
  days,
  billsByDay,
  model,
  amount = 0,
  inDays = 0,
  confidence = 0.95,
  paths = DEFAULT_PATHS,
  seed = 1,
  spentToday = 0,
}) {
  const rand = seededRandom(seed);
  const risk = 1 - confidence;
  const start = num(balance);
  const floor = Math.max(0, num(buffer));
  const todaySpent = Math.max(0, num(spentToday));
  const purchaseDay = Math.min(Math.max(0, Math.floor(inDays)), days); // `days` means "after the income arrives"
  const purchaseAmount = purchaseDay < days ? amount : 0; // a purchase after the income does not touch this period

  const firstRuinCount = new Float64Array(days + 1); // paths whose balance (with the purchase) first goes under the buffer on day d
  const slack = new Float64Array(paths); // the biggest purchase today this future could absorb
  const shortfalls = new Float64Array(paths); // how far below the buffer the requested purchase pushes it
  let baselineRuin = 0;

  const balances = new Float64Array(days + 1);
  const suffixMin = new Float64Array(days + 2);
  for (let p = 0; p < paths; p++) {
    let b = start;
    let prefixMin = Infinity;
    let firstRuin = days + 1; // first day the balance is below the buffer, without any purchase
    let firstRuinWithPurchase = days + 1;
    for (let t = 0; t <= days; t++) {
      if (t < days) {
        // Three random numbers per day, always, so the sequence does not depend on which days are zero days.
        const noSpend = rand() < model.zeroDayShare;
        const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
        if (!noSpend) {
          const spend = Math.exp(model.mu + model.sigma * z);
          b -= t === 0 ? Math.max(0, spend - todaySpent) : spend;
        }
      }
      b -= billsByDay[t] ?? 0;
      balances[t] = b;
      if (b < floor && firstRuin > days) firstRuin = t;
      if (b - (t >= purchaseDay ? purchaseAmount : 0) < floor && firstRuinWithPurchase > days) firstRuinWithPurchase = t;
    }
    suffixMin[days + 1] = Infinity;
    for (let t = days; t >= 0; t--) suffixMin[t] = Math.min(balances[t], suffixMin[t + 1]);

    if (firstRuin <= days) baselineRuin++;
    slack[p] = suffixMin[0] - floor;
    if (firstRuinWithPurchase <= days) firstRuinCount[firstRuinWithPurchase]++;
    if (purchaseDay < days) {
      prefixMin = Infinity;
      for (let t = 0; t < purchaseDay; t++) prefixMin = Math.min(prefixMin, balances[t]);
      shortfalls[p] = Math.max(0, floor - Math.min(prefixMin, suffixMin[purchaseDay] - amount));
    } else {
      shortfalls[p] = Math.max(0, floor - suffixMin[0]);
    }
  }

  const sortedSlack = Array.from(slack).sort((a, b) => a - b);
  const maxPurchaseNow = Math.max(0, sortedSlack[Math.min(paths - 1, Math.floor(risk * paths))]);
  const tail = Array.from(shortfalls).sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(risk * paths)));
  const expectedShortfallInWorstCase = tail.reduce((s, v) => s + v, 0) / tail.length;

  // Cumulative: the chance of having gone under the buffer on or before each day (the last entry is the income day).
  let running = 0;
  const ruinByDay = Array.from({ length: days + 1 }, (_, d) => (running += firstRuinCount[d]) / paths);
  const purchaseRuin = ruinByDay[days];

  return {
    baselineRuinProbability: baselineRuin / paths,
    purchaseRuinProbability: purchaseRuin,
    maxPurchaseNow,
    expectedShortfallInWorstCase,
    ruinByDay,
    paths,
  };
}

// Prints a probability the way people say it: no false precision, and never a flat 0% or 100% unless it truly is one.
export const percent = (p) => {
  if (p <= 0) return 0;
  if (p >= 1) return 100;
  return Math.min(99, Math.max(1, Math.round(p * 100)));
};

export const roundProbability = (p) => round(p, 4);
export { round as roundMoney };
