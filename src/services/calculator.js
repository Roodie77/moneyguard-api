const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
};

function safeNum(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Core calculation from the product plan:
 * Projected balance = Income − Ordinary expenses − Existing EMI − Proposed EMI
 */
export function calculateProjectedBalance({
  monthlyIncome = 0,
  ordinaryExpenses = 0,
  existingEMI = 0,
  proposedEMI = 0,
}) {
  const income = Math.max(safeNum(monthlyIncome), 0);
  const expenses = Math.max(safeNum(ordinaryExpenses), 0);
  const existing = Math.max(safeNum(existingEMI), 0);
  const proposed = Math.max(safeNum(proposedEMI), 0);

  const projected = money(income - expenses - existing - proposed);
  const shortfall = projected < 0 ? money(Math.abs(projected)) : 0;

  let warning = null;
  if (projected < 0) {
    warning = `Your planned monthly commitments exceed your income by ${shortfall}. Consider reviewing the repayment amount or your budget before proceeding.`;
  } else if (projected === 0) {
    warning = 'Your planned commitments equal your income. There is no remaining buffer.';
  }

  return {
    monthlyIncome: income,
    ordinaryExpenses: expenses,
    existingEMI: existing,
    proposedEMI: proposed,
    projectedBalance: projected,
    shortfall,
    isNegative: projected < 0,
    warning,
  };
}

// Existing functions kept for compatibility
export function calculateMaxPayment(inputs) {
  const income = Math.max(safeNum(inputs.monthlyGrossIncome), 0);
  const dti = Math.min(Math.max(safeNum(inputs.targetDtiRatio, 0.4), 0), 1);
  const existing = Math.max(safeNum(inputs.existingMonthlyDebtPayments), 0);
  return money(Math.max(income * dti - existing, 0));
}

export function calculateLoanAmountFromPayment(monthlyPayment, annualInterestRate = 0, termMonths = 12) {
  const payment = Math.max(safeNum(monthlyPayment), 0);
  const term = Math.max(Math.floor(safeNum(termMonths)), 0);
  const rate = Math.max(safeNum(annualInterestRate), 0);
  if (payment <= 0 || term <= 0 || rate > 5) return 0;
  const monthlyRate = rate / 12;
  if (monthlyRate === 0) return money(payment * term);
  const factor = (1 - Math.pow(1 + monthlyRate, -term)) / monthlyRate;
  return Number.isFinite(factor) ? money(payment * factor) : 0;
}

export function calculatePaymentFromLoan(loanAmount, annualInterestRate = 0, termMonths = 12) {
  const loan = Math.max(safeNum(loanAmount), 0);
  const term = Math.max(Math.floor(safeNum(termMonths)), 0);
  const rate = Math.max(safeNum(annualInterestRate), 0);
  if (loan <= 0 || term <= 0 || rate > 5) return 0;
  const monthlyRate = rate / 12;
  if (monthlyRate === 0) return money(loan / term);
  const pow = Math.pow(1 + monthlyRate, term);
  if (!Number.isFinite(pow) || pow === 1) return money(loan / term);
  return money((loan * (monthlyRate * pow)) / (pow - 1));
}

export function runAffordabilityCalculator(inputs = {}) {
  const result = calculateProjectedBalance({
    monthlyIncome: inputs.monthlyGrossIncome,
    ordinaryExpenses: inputs.otherMonthlyExpenses,
    existingEMI: inputs.existingMonthlyDebtPayments,
    proposedEMI: inputs.proposedMonthlyPayment || 0,
  });

  const warnings = [];
  if (result.warning) warnings.push(result.warning);
  if (result.monthlyIncome === 0) warnings.push('Monthly income is missing or zero.');

  const maxPayment = calculateMaxPayment(inputs);
  const maxLoan = calculateLoanAmountFromPayment(maxPayment, inputs.annualInterestRate ?? 0, inputs.loanTermMonths ?? 12);
  const totalDebt = result.existingEMI + result.proposedEMI;
  const dti = result.monthlyIncome > 0 ? money(totalDebt / result.monthlyIncome) : 0;

  return {
    ...result,
    maxAffordableMonthlyPayment: maxPayment,
    maxAffordableLoanAmount: maxLoan,
    debtToIncomeRatio: dti,
    isAffordable: result.projectedBalance >= 0,
    warnings,
  };
}

export function generateCashFlowProjection(inputs = {}, monthlyPayment = 0, months = 12) {
  const safeMonths = Math.max(Math.min(Math.floor(safeNum(months, 12)), 120), 1);
  const payment = Math.max(safeNum(monthlyPayment), 0);
  const projection = [];
  let balance = safeNum(inputs.startingCashBalance);

  for (let month = 1; month <= safeMonths; month++) {
    const starting = balance;
    const income = Math.max(safeNum(inputs.monthlyGrossIncome), 0);
    const debt = Math.max(safeNum(inputs.existingMonthlyDebtPayments), 0) + payment;
    const expenses = Math.max(safeNum(inputs.otherMonthlyExpenses), 0);
    const ending = money(starting + income - debt - expenses);
    projection.push({
      month,
      startingBalance: money(starting),
      income: money(income),
      debtPayments: money(debt),
      otherExpenses: money(expenses),
      endingBalance: ending,
      isNegative: ending < 0,
    });
    balance = ending;
  }
  return projection;
}

export function summarizeCashFlow(projection = []) {
  if (!Array.isArray(projection) || projection.length === 0) {
    return { totalMonths: 0, negativeMonths: [], lowestEndingBalance: 0, warnings: [] };
  }
  const negativeMonths = projection.filter((m) => m.isNegative).map((m) => m.month);
  const minBalance = Math.min(...projection.map((m) => m.endingBalance));
  const warnings = negativeMonths.length
    ? [`Negative balance in month(s): ${negativeMonths.join(', ')}. Lowest: ${minBalance}.`]
    : [];
  return { totalMonths: projection.length, negativeMonths, lowestEndingBalance: minBalance, warnings };
}

export function calculateSafeToSpend({ balance = 0, nextIncomeDate, bills = [], savingsGoalAmount = 0, todayExpenses = [] }) {
  const warnings = [];
  // Everything is counted in UTC days, so the result never depends on the server's time zone.
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);

  let incomeDate;
  if (nextIncomeDate) {
    incomeDate = new Date(nextIncomeDate);
    if (isNaN(incomeDate.getTime())) {
      warnings.push('Invalid next income date; using 30 days.');
      incomeDate = new Date(now.getTime() + 30 * 86400000);
    }
  } else {
    warnings.push('No next income date; using 30 days.');
    incomeDate = new Date(now.getTime() + 30 * 86400000);
  }
  incomeDate.setUTCHours(0, 0, 0, 0);

  let days = Math.ceil((incomeDate - now) / 86400000);
  if (days <= 0) {
    warnings.push('Next income is today or past; treating as 1 day.');
    days = 1;
  }

  // A bill due at any time on the income day is still reserved (the income may not have arrived yet).
  const incomeDayEnd = incomeDate.getTime() + 86400000;
  const safeBills = Array.isArray(bills) ? bills : [];
  const upcomingBillsTotal = safeBills
    .filter((b) => {
      const d = new Date(b.dueDate);
      return !isNaN(d.getTime()) && d.getTime() < incomeDayEnd && Number(b.amount) > 0;
    })
    .reduce((sum, b) => sum + Number(b.amount), 0);

  const safeBalance = Math.max(safeNum(balance), 0);
  const safeSavings = Math.max(safeNum(savingsGoalAmount), 0);
  const savingsReserve = money(Math.min(safeSavings / 4 || 0, safeBalance * 0.2));
  const available = money(safeBalance - upcomingBillsTotal - savingsReserve);
  const safeExpenses = Array.isArray(todayExpenses) ? todayExpenses : [];
  const spentToday = safeExpenses.reduce((s, e) => s + Math.max(safeNum(e.amount), 0), 0);
  // Today's spending has already been taken out of the balance. Add it back to get what was available this morning,
  // so it is not counted twice (once as a smaller balance, once as "spent today"). That makes the daily allowance steady
  // through the day, and "left today" is exactly the allowance minus what was spent.
  const dailySafe = money(Math.max(0, (available + spentToday) / days));
  const remainingToday = money(dailySafe - spentToday);

  if (available < 0) warnings.push('Commitments exceed current balance.');
  if (remainingToday < 0) warnings.push("Already over today's safe amount.");

  return {
    dailySafeToSpend: dailySafe,
    remainingToday,
    daysUntilNextIncome: days,
    upcomingBillsTotal: money(upcomingBillsTotal),
    savingsReserve,
    availableAfterCommitments: available,
    spentToday: money(spentToday),
    warnings,
  };
}

export function canIAfford({ purchaseAmount, safeToSpend, balance }) {
  const amount = safeNum(purchaseAmount);
  if (amount <= 0) {
    return {
      recommendation: 'NotRecommended',
      reason: 'Amount must be positive.',
      explanation: 'Invalid amount.',
      remainingAfterPurchase: safeToSpend?.remainingToday ?? 0,
      cashFlowWarnings: [],
    };
  }

  const remaining = safeToSpend?.remainingToday ?? 0;
  const available = safeToSpend?.availableAfterCommitments ?? 0;
  let recommendation = 'Safe';
  let reason = "Fits within today's safe amount.";

  if (remaining < 0 || amount > remaining * 2 || amount > available * 0.5) {
    recommendation = 'NotRecommended';
    reason = 'This is well above your safe daily amount.';
  } else if (amount > remaining) {
    recommendation = 'ThinkTwice';
    reason = `Exceeds today's remaining safe amount (${remaining}).`;
  }

  const days = safeToSpend?.daysUntilNextIncome || 30;
  const projectedInputs = {
    monthlyGrossIncome: 0,
    existingMonthlyDebtPayments: 0,
    otherMonthlyExpenses: amount / Math.max(1, days / 30),
    startingCashBalance: Math.max(safeNum(balance), 0), // the purchase itself is the expense below; subtracting it here too counted it twice
  };
  const projection = generateCashFlowProjection(projectedInputs, 0, Math.min(3, Math.ceil(days / 30) || 1));
  const summary = summarizeCashFlow(projection);
  const explanation = `${reason} After this you would have about ${money(Math.max(safeNum(balance), 0) - amount)} left.`;

  return {
    recommendation,
    reason,
    explanation,
    remainingAfterPurchase: money(remaining - amount),
    cashFlowWarnings: summary.warnings,
  };
}
