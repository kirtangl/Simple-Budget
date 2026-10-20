'use strict';

// Pure pay-cycle maths: no database access here, so it is easy to test.
// Dates are plain 'YYYY-MM-DD' strings and are handled in UTC so that
// daylight saving never shifts a day.

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.25;

// How often you get paid. A pay cycle runs from one pay day to the day before
// the next. Weekly, fortnightly and custom cycles step a fixed number of days
// from the anchor pay day; monthly cycles start on the anchor's day of the month.
const PAY_FREQUENCIES = { weekly: 7, fortnightly: 14, monthly: null, custom: null };
const DEFAULT_PAY_CYCLE = { frequency: 'fortnightly', days: 14 };

function payCycle(frequency, customDays) {
  if (frequency === 'monthly') return { frequency, days: null };
  if (frequency === 'custom') {
    const days = Math.min(Math.max(Math.round(Number(customDays) || 14), 1), 366);
    return { frequency, days };
  }
  return Object.hasOwn(PAY_FREQUENCIES, frequency) && PAY_FREQUENCIES[frequency]
    ? { frequency, days: PAY_FREQUENCIES[frequency] } : DEFAULT_PAY_CYCLE;
}

function paysPerYear(cycle = DEFAULT_PAY_CYCLE) {
  if (cycle.frequency === 'monthly') return 12;
  if (cycle.frequency === 'weekly') return 52;
  if (cycle.frequency === 'fortnightly') return 26;
  return DAYS_PER_YEAR / cycle.days;
}

// How many times a year each frequency comes out, and for the monthly-style
// frequencies, how many months apart.
const FREQUENCIES = {
  weekly: { perYear: 52 },
  fortnightly: { perYear: 26 },
  monthly: { perYear: 12, months: 1 },
  bimonthly: { perYear: 6, months: 2 },
  quarterly: { perYear: 4, months: 3 },
  semiannual: { perYear: 2, months: 6 },
  yearly: { perYear: 1, months: 12 },
};

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(str, days) {
  return formatDate(parseDate(str) + days * DAY_MS);
}

function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
}

// A real calendar date between 1900 and 2199. Far-off years aren't useful, and
// the loan maths steps day by day, so they would make every page slow.
function isValidDate(str) {
  return typeof str === 'string' && /^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(str) && formatDate(parseDate(str)) === str;
}

function lastDayOfMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

// The anchor's day of the month, `months` months after the anchor (clamped to short months).
function monthlyStart(anchor, months) {
  const [y, m, d] = anchor.split('-').map(Number);
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  return formatDate(Date.UTC(year, month, Math.min(d, lastDayOfMonth(year, month))));
}

// Which pay cycle (relative to the anchor pay date) contains `date`.
function cycleIndexFor(anchor, date, cycle = DEFAULT_PAY_CYCLE) {
  if (cycle.frequency === 'monthly') {
    const [ay, am] = anchor.split('-').map(Number);
    const [y, m] = date.split('-').map(Number);
    let i = (y - ay) * 12 + (m - am);
    if (date < monthlyStart(anchor, i)) i -= 1;
    return i;
  }
  return Math.floor(daysBetween(anchor, date) / cycle.days);
}

function cycleBounds(anchor, index, cycle = DEFAULT_PAY_CYCLE) {
  if (cycle.frequency === 'monthly') {
    const start = monthlyStart(anchor, index);
    return { index, start, end: addDays(monthlyStart(anchor, index + 1), -1) };
  }
  const start = addDays(anchor, index * cycle.days);
  return { index, start, end: addDays(start, cycle.days - 1) };
}

// Per-pay equivalent of an expense, in cents (not rounded): amount × times a year ÷ pays a year.
function perPayCents(expense, cycle = DEFAULT_PAY_CYCLE) {
  const f = FREQUENCIES[expense.frequency];
  return f ? (expense.amount_cents * f.perYear) / paysPerYear(cycle) : 0;
}

// Every date this expense comes out between start and end (inclusive).
// Weekly and fortnightly expenses count day_offset days from the anchor pay day,
// so they stay put whatever the pay cycle is.
function occurrences(expense, start, end, anchor = start) {
  const f = FREQUENCIES[expense.frequency];
  if (!f) return [];
  const dates = [];

  if (expense.frequency === 'weekly' || expense.frequency === 'fortnightly') {
    const step = expense.frequency === 'weekly' ? 7 : 14;
    const offset = ((Number(expense.day_offset) || 0) % step + step) % step;
    const first = addDays(anchor, offset);
    const skip = Math.ceil(daysBetween(first, start) / step);
    for (let d = addDays(first, skip * step); d <= end; d = addDays(d, step)) dates.push(d);
    return dates;
  }

  const day = Math.min(Math.max(Number(expense.day_of_month) || 1, 1), 31);
  const startMonth = Math.min(Math.max(Number(expense.start_month) || 1, 1), 12) - 1;
  const s = new Date(parseDate(start));
  const e = new Date(parseDate(end));
  // Walk every month the range touches.
  for (let y = s.getUTCFullYear(), m = s.getUTCMonth(); y < e.getUTCFullYear() || (y === e.getUTCFullYear() && m <= e.getUTCMonth()); ) {
    if (f.months === 1 || (((m - startMonth) % f.months) + f.months) % f.months === 0) {
      const d = formatDate(Date.UTC(y, m, Math.min(day, lastDayOfMonth(y, m))));
      if (d >= start && d <= end) dates.push(d);
    }
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  return dates;
}

// How each account's per-pay total (with its buffer) is rounded.
const ROUNDING = { exact: 1, up5: 500, up10: 1000 };
const DEFAULT_DEPOSIT_RULES = { rounding: 'up10', buffer_percent: 0 };

// Add the buffer percentage to the account's whole per-pay total, then round that up (to the cent,
// $5 or $10), so the deposit is always a round number. 293 -> up5 -> 295; 301 -> +10% -> 331.10 -> up10 -> 340.
function roundUp(cents, rounding) {
  const step = (Object.hasOwn(ROUNDING, rounding) && ROUNDING[rounding]) || 1;
  // The small epsilon stops float noise like 29300.0000001 rounding up a whole step.
  return Math.max(0, Math.ceil(cents / step - 1e-9) * step);
}

function depositCents(averageCents, rules = DEFAULT_DEPOSIT_RULES) {
  const buffered = Math.round((averageCents * (100 + (Number(rules.buffer_percent) || 0))) / 100);
  return roundUp(buffered, rules.rounding);
}

// An income counts in a cycle it overlaps, except that once it has ended it
// drops out of the current cycle straight away (past cycles still show it).
function incomeActive(income, cycle, today) {
  if (income.start_date && income.start_date > cycle.end) return false;
  if (income.end_date && income.end_date < cycle.start) return false;
  if (income.end_date && today && cycle.start <= today && today <= cycle.end && income.end_date < today) return false;
  return true;
}

// Everything the Overview page needs for one pay cycle.
// How often an income is paid (separate from the budget cycle, e.g. paid
// fortnightly but budgeting monthly).
const INCOME_FREQUENCIES = { weekly: 52, fortnightly: 26, monthly: 12 };

// Income per budget cycle, averaged: a $3,000 fortnightly pay is $6,500 a month.
function incomePerCycle(income, cycle = DEFAULT_PAY_CYCLE) {
  const perYear = INCOME_FREQUENCIES[income.frequency] || 26;
  return (income.after_tax_cents * perYear) / paysPerYear(cycle);
}

// A saving with a yearly target is split evenly across the budget cycles.
const isSplit = (e) => e.yearly_cents !== null && e.yearly_cents !== undefined;

// Per-cycle equivalent of any expense-like row, honouring yearly-split savings.
function perCycleCents(e, cycle = DEFAULT_PAY_CYCLE) {
  return isSplit(e) ? e.yearly_cents / paysPerYear(cycle) : perPayCents(e, cycle);
}

// Whether a row with optional start/end dates applies to any part of the cycle.
function inRange(row, bounds) {
  return !(row.start_date && row.start_date > bounds.end) && !(row.end_date && row.end_date < bounds.start);
}

// The next date on or after `today` this row comes out, or null (ended, or nothing within two years).
function nextDate(row, today, anchor = today) {
  const from = row.start_date && row.start_date > today ? row.start_date : today;
  const horizon = addDays(today, 731);
  const to = row.end_date && row.end_date < horizon ? row.end_date : horizon;
  if (from > to) return null;
  return occurrences(row, from, to, anchor)[0] ?? null;
}

// Monthly-style rows set for a day the month doesn't have (the 29th to 31st) come out
// on its last day instead. Returns the day it was set for when that happened, else null.
function movedFrom(e, date, spread = false) {
  if (spread || !FREQUENCIES[e.frequency]?.months) return null;
  const day = Math.min(Math.max(Number(e.day_of_month) || 1, 1), 31);
  return Number(date.slice(8)) < day ? day : null;
}

// Savings move into their account every cycle, so a yearly target, or a saving
// that comes round less often than the cycle, shows its share each cycle.
function spreadsEachCycle(e, pc = DEFAULT_PAY_CYCLE) {
  return isSplit(e) || ((e.kind || 'expense') === 'saving' && Boolean(FREQUENCIES[e.frequency])
    && FREQUENCIES[e.frequency].perYear < paysPerYear(pc));
}

// Start of the financial year (1 July) or calendar year that `today` falls in.
function yearStart(today, basis) {
  const y = Number(today.slice(0, 4));
  if (basis === 'financial') return Number(today.slice(5, 7)) >= 7 ? `${y}-07-01` : `${y - 1}-07-01`;
  return `${y}-01-01`;
}

// What has come out for a row from `from` up to (not including) `today`, the same
// way the Overview counts bills as paid. Savings spread per cycle count each cycle's share.
// `history` (its amount_history rows) prices each payment at the amount in force on its
// date; without it, every payment is counted at today's amount.
function paidBetween(e, from, today, { anchor = from, payAnchor = anchor, payCycle: pc = DEFAULT_PAY_CYCLE, history = [] } = {}) {
  const start = e.start_date && e.start_date > from ? e.start_date : from;
  const last = addDays(today, -1);
  const end = e.end_date && e.end_date < last ? e.end_date : last;
  if (start > end) return { count: 0, cents: 0 };
  const paidIn = (row, s, until) => {
    if (spreadsEachCycle(row, pc)) {
      const each = Math.round(perCycleCents(row, pc));
      let count = 0;
      for (let i = cycleIndexFor(anchor, s, pc); ; i += 1) {
        const c = cycleBounds(anchor, i, pc);
        if (c.start > until) break;
        if (c.start >= s) count += 1;
      }
      return { count, cents: count * each };
    }
    const count = occurrences(row, s, until, payAnchor).length;
    return { count, cents: count * row.amount_cents };
  };
  const changes = history.filter((h) => h.field === 'amount_cents' && Number.isInteger(h.value))
    .sort((a, b) => (a.on_date < b.on_date ? -1 : a.on_date > b.on_date ? 1 : a.id - b.id));
  if (!changes.length) return paidIn(e, start, end);
  // The row as it was under one recorded amount (and how often it was paid then).
  const asAt = (h) => ({ ...e, amount_cents: h.value, frequency: h.frequency || e.frequency, ...(isSplit(e) && { yearly_cents: h.value }) });
  // Before the first record (bills added after they started), its first amount applies.
  let current = changes.filter((h) => h.on_date <= start).at(-1) || changes[0];
  let from_ = start;
  const total = { count: 0, cents: 0 };
  const add = (r) => { total.count += r.count; total.cents += r.cents; };
  for (const h of changes.filter((c) => c.on_date > start && c.on_date <= end)) {
    add(paidIn(asAt(current), from_, addDays(h.on_date, -1)));
    current = h;
    from_ = h.on_date;
  }
  add(paidIn(asAt(current), from_, end));
  return total;
}

// The rows a cycle's deposits put money aside for: active in the cycle, and still to
// come out. A temporary bill whose last date has already passed (or never comes) isn't saved for.
function fundedRows(rows, cycle, payAnchor = cycle.start) {
  return rows.filter((e) => e.active && inRange(e, cycle) && (isSplit(e) || !e.end_date
    || occurrences(e, cycle.start, e.end_date < addDays(cycle.start, 400) ? e.end_date : addDays(cycle.start, 400), payAnchor)
      .some((d) => !(e.start_date && d < e.start_date))));
}

// Expenses can be ordinary bills (kind 'expense'), savings transfers ('saving')
// or loan repayments ('loan'). All of them go into the account deposits.
// Savings only count as expenses when show_as_expense is set.
// `anchor` is where budget cycles start; `payAnchor` is the pay day that weekly
// and fortnightly bills are counted from (the same unless they're set apart).
function buildCycle({ anchor, payAnchor = anchor, index, today, expenses, accounts, incomes, rules = DEFAULT_DEPOSIT_RULES, payCycle: pc = DEFAULT_PAY_CYCLE }) {
  const cycle = cycleBounds(anchor, index, pc);
  const active = expenses.filter((e) => e.active && inRange(e, cycle));
  const perCycle = (e) => perCycleCents(e, pc);
  const countsAsExpense = (e) => (e.kind || 'expense') !== 'saving' || Boolean(e.show_as_expense);

  const spread = (e) => spreadsEachCycle(e, pc);
  const bills = [];
  for (const e of active) {
    const dates = spread(e) ? [cycle.start] : occurrences(e, cycle.start, cycle.end, payAnchor);
    const amount = spread(e) ? Math.round(perCycle(e)) : e.amount_cents;
    for (const date of dates) {
      if ((e.start_date && date < e.start_date) || (e.end_date && date > e.end_date)) continue;
      const status = date < today ? 'paid' : date === today ? 'due' : 'upcoming';
      bills.push({ expense_id: e.id, loan_id: e.loan_id ?? null, kind: e.kind || 'expense', is_expense: countsAsExpense(e), date, name: e.name,
        amount_cents: amount, status, moved_from_day: movedFrom(e, date, spread(e)), payee_id: e.payee_id, category_id: e.category_id, subcategory_id: e.subcategory_id, account_id: e.account_id });
    }
  }
  bills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));

  const funded = fundedRows(active, cycle, payAnchor);

  const accountRows = accounts.map((a) => {
    const own = funded.filter((e) => e.account_id === a.id);
    const average = own.reduce((sum, e) => sum + perCycle(e), 0);
    // Bills come out of the account; savings stay in it, so they're listed separately.
    const saved = own.filter((e) => (e.kind || 'expense') === 'saving').reduce((sum, e) => sum + perCycle(e), 0);
    const cycleBills = bills.filter((b) => b.account_id === a.id && b.kind !== 'saving');
    const billsTotal = cycleBills.reduce((sum, b) => sum + b.amount_cents, 0);
    const paid = cycleBills.filter((b) => b.status === 'paid').reduce((sum, b) => sum + b.amount_cents, 0);
    // Each account can have its own rounding and buffer; empty means the household's.
    const ownRules = { rounding: Object.hasOwn(ROUNDING, a.rounding ?? '') ? a.rounding : rules.rounding,
      buffer_percent: a.buffer_percent ?? rules.buffer_percent };
    const rounded = roundUp(average, ownRules.rounding);
    const deposit = depositCents(average, ownRules);
    return { account_id: a.id, rules: ownRules, average_cents: Math.round(average), rounded_cents: rounded, deposit_cents: deposit,
      bills_cents: billsTotal, savings_cents: Math.round(saved), paid_cents: paid, remaining_cents: billsTotal - paid,
      spare_cents: deposit - billsTotal - Math.round(saved) };
  });

  const unassigned = funded.filter((e) => !e.account_id).reduce((sum, e) => sum + perCycle(e), 0);

  const incomeRows = incomes.filter((i) => incomeActive(i, cycle, today))
    .map((i) => ({ income_id: i.id, name: i.name, amount_cents: Math.round(incomePerCycle(i, pc)), pay_cents: i.after_tax_cents,
      frequency: i.frequency || 'fortnightly', end_date: i.end_date || null,
      in_budget: i.include_in_budget === undefined || i.include_in_budget === null ? true : Boolean(i.include_in_budget) }));

  const sum = (rows, key) => rows.reduce((s, r) => s + r[key], 0);
  // Only income marked "in budget" pays for the deposits; the rest is shown separately.
  const income = sum(incomeRows.filter((i) => i.in_budget), 'amount_cents');
  const otherIncome = sum(incomeRows.filter((i) => !i.in_budget), 'amount_cents');
  const deposits = sum(accountRows, 'deposit_cents');
  const spending = bills.filter((b) => b.is_expense);
  const billsTotal = sum(spending, 'amount_cents');
  const paid = sum(spending.filter((b) => b.status === 'paid'), 'amount_cents');
  const savingsTotal = sum(bills.filter((b) => b.kind === 'saving'), 'amount_cents');

  return {
    cycle: { ...cycle, is_current: cycle.start <= today && today <= cycle.end, frequency: pc.frequency },
    today,
    rules,
    incomes: incomeRows,
    accounts: accountRows,
    bills,
    totals: {
      income_cents: income,
      other_income_cents: otherIncome,
      deposits_cents: deposits,
      remaining_cents: income - deposits,
      bills_cents: billsTotal,
      savings_cents: savingsTotal,
      paid_cents: paid,
      outstanding_cents: billsTotal - paid,
      unassigned_cents: depositCents(unassigned, rules),
    },
  };
}

// ---------- What should be in each account ----------
//
// A guide to how much each account should be holding today so that, with the
// deposits still to come each cycle, every bill in the next 12 months can be
// paid. E.g. $50 a fortnight towards a $1,300 bill due in two cycles: the
// account should already hold $1,200. Savings are left out (they just build up).
// Bills share the account, so money put in early for a bill that's months away
// can cover one that comes sooner; this is the least that never runs short.

// Bills that come out every two months or less often.
const isBigBill = (e) => !isSplit(e) && (FREQUENCIES[e.frequency]?.months || 0) >= 2;

// Per account, in whole cents (never below zero), with the day the account is
// at its lowest (low_on, after the bill named low_after) and the big bills ahead.
function heldEstimates(rows, accounts, { today, anchor = today, payAnchor = anchor, payCycle: pc = DEFAULT_PAY_CYCLE }) {
  const until = addDays(today, 365);
  const live = rows.filter((e) => e.active && (e.kind || 'expense') !== 'saving'
    && !(e.end_date && e.end_date < today) && !isSplit(e));
  // Deposits land at the start of each cycle after today.
  const depositCycles = [];
  for (let i = cycleIndexFor(anchor, today, pc) + 1; ; i += 1) {
    const bounds = cycleBounds(anchor, i, pc);
    if (bounds.start > until) break;
    depositCycles.push(bounds);
  }
  return accounts.map((a) => {
    const own = live.filter((e) => e.account_id === a.id);
    const events = [];
    // Each deposit only covers what applies in that cycle (not before it starts or after it ends).
    for (const bounds of depositCycles) {
      const perCycle = own.filter((e) => inRange(e, bounds)).reduce((sum, e) => sum + perCycleCents(e, pc), 0);
      events.push([bounds.start, 0, -perCycle, null]);
    }
    const ahead = [];
    for (const e of own) {
      let first = true;
      for (const d of occurrences(e, today, until, payAnchor)) {
        if ((e.start_date && d < e.start_date) || (e.end_date && d > e.end_date)) continue;
        events.push([d, 1, e.amount_cents, e.name]);
        if (first && isBigBill(e)) ahead.push({ expense_id: e.id, name: e.name, date: d, amount_cents: e.amount_cents });
        first = false;
      }
    }
    // Deposits before bills on the same day; track the most the account is ever short.
    events.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
    let running = 0;
    let need = 0;
    let low = null;
    for (const [date, , amount, name] of events) {
      running += amount;
      if (running > need) { need = running; low = { date, name }; }
    }
    ahead.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.name.localeCompare(y.name)));
    return { account_id: a.id, held_cents: Math.round(need), low_on: low && low.date, low_after: low && low.name, ahead };
  });
}

// ---------- Loans ----------
//
// Everything here is an estimate. Interest is worked out daily on the balance
// (rate ÷ 365) and added to the loan on the interest day each month, the way
// most Australian lenders do it. Repayments come out on their schedule.

const LOAN_FREQUENCIES = { weekly: 52, fortnightly: 26, monthly: 12 };

// The usual repayment for a loan of `principal` cents over `periods` repayments.
function amortisedRepayment(principalCents, annualRatePercent, periodsPerYear, periods) {
  if (!(principalCents > 0) || !(periods > 0)) return 0;
  const r = (Number(annualRatePercent) || 0) / 100 / periodsPerYear;
  if (r === 0) return principalCents / periods;
  return (principalCents * r) / (1 - (1 + r) ** -periods);
}

// The most you could borrow for a given repayment (the reverse of the above).
function maxPrincipal(repaymentCents, annualRatePercent, periodsPerYear, periods) {
  if (!(repaymentCents > 0) || !(periods > 0)) return 0;
  const r = (Number(annualRatePercent) || 0) / 100 / periodsPerYear;
  if (r === 0) return repaymentCents * periods;
  return (repaymentCents * (1 - (1 + r) ** -periods)) / r;
}

function addMonths(date, months) {
  const [, , d] = date.split('-').map(Number);
  const start = monthlyStart(date, months);
  return start.slice(0, 8) + String(Math.min(d, Number(start.slice(8)))).padStart(2, '0');
}

// A repayment schedule as an expense-like row, so it fits the pay-cycle maths.
// Weekly and fortnightly repayments land every 7/14 days from `date`; monthly
// ones on `date`'s day of the month.
function repaymentRow(loan, frequency, amount, date, anchor) {
  const freq = LOAN_FREQUENCIES[frequency] ? frequency : 'monthly';
  const first = date || anchor;
  const step = freq === 'weekly' ? 7 : 14;
  return {
    id: null, loan_id: loan.id, kind: 'loan', name: loan.name, amount_cents: amount,
    frequency: freq, account_id: loan.account_id, category_id: loan.category_id ?? null, payee_id: null, subcategory_id: null,
    day_offset: freq === 'monthly' ? null : ((daysBetween(anchor, first) % step) + step) % step,
    day_of_month: freq === 'monthly' ? Number(first.slice(8)) : null,
    start_date: date || null, end_date: loanEndDate(loan),
    active: loan.include_in_budget === 0 || loan.paid_off ? 0 : 1,
  };
}

// The lender's schedule: what has to be paid, how often, from when.
function scheduledRepayment(loan) {
  return {
    frequency: LOAN_FREQUENCIES[loan.repayment_frequency] ? loan.repayment_frequency : 'monthly',
    amount_cents: loanRepayment(loan),
    date: loan.scheduled_date || loan.start_date || null,
  };
}

// What is actually budgeted (e.g. $700 a fortnight towards $1,400 a month).
// Anything left blank follows the scheduled repayment.
function budgetedRepayment(loan) {
  const s = scheduledRepayment(loan);
  const own = loan.budget_cents != null;
  return {
    custom: own,
    frequency: own && LOAN_FREQUENCIES[loan.budget_frequency] ? loan.budget_frequency : s.frequency,
    amount_cents: own ? loan.budget_cents : s.amount_cents,
    date: (own && loan.budget_date) || s.date,
  };
}

// The budgeted repayments as an expense-like row: these are what go in the
// Expenses list and the account deposits.
function loanAsExpense(loan, anchor) {
  const b = budgetedRepayment(loan);
  return repaymentRow(loan, b.frequency, b.amount_cents, b.date, anchor);
}

function scheduleAsExpense(loan, anchor) {
  const s = scheduledRepayment(loan);
  return repaymentRow(loan, s.frequency, s.amount_cents, s.date, anchor);
}

function loanEndDate(loan) {
  return loan.start_date && loan.term_months ? addMonths(loan.start_date, loan.term_months) : null;
}

function loanPeriods(loan) {
  return Math.round(((Number(loan.term_months) || 0) / 12) * (LOAN_FREQUENCIES[loan.repayment_frequency] || 12));
}

// Repayment worked out from the amount borrowed, rate and term.
function calculatedRepayment(loan) {
  return Math.round(amortisedRepayment(loan.principal_cents, loan.interest_rate, LOAN_FREQUENCIES[loan.repayment_frequency] || 12, loanPeriods(loan)));
}

// Where a loan should be on `date` if only the minimum repayments were made: the amount borrowed
// spread over the term with interest (so it reaches $0 at the end), less the repayments due so far.
// Null without an amount, start date and term.
function minimumBalance(loan, date) {
  const n = loanPeriods(loan);
  const P = Number(loan.principal_cents);
  if (!(P > 0) || !n || !loan.start_date || !date) return null;
  const freq = LOAN_FREQUENCIES[loan.repayment_frequency] ? loan.repayment_frequency : 'monthly';
  const ppy = LOAN_FREQUENCIES[freq];
  let k = 0;
  if (freq === 'monthly') { while (k < n && addMonths(loan.start_date, k + 1) <= date) k++; }
  else k = Math.max(0, Math.floor(daysBetween(loan.start_date, date) / (freq === 'weekly' ? 7 : 14)));
  k = Math.min(k, n);
  const pmt = amortisedRepayment(P, loan.interest_rate, ppy, n);
  const r = (Number(loan.interest_rate) || 0) / 100 / ppy;
  const left = r ? P * (1 + r) ** k - (pmt * ((1 + r) ** k - 1)) / r : P - pmt * k;
  return { balance_cents: Math.max(0, Math.round(left)), repayments: k, repayment_cents: Math.round(pmt) };
}

// The scheduled repayment: the one you set, or the calculated one.
function loanRepayment(loan) {
  return loan.repayment_cents != null ? loan.repayment_cents : calculatedRepayment(loan);
}

// How the budgeted repayments line up with the next scheduled one: the amount
// due, and how much will have gone in since the last due date.
function nextDue(loan, today) {
  const s = scheduledRepayment(loan);
  if (!s.date || !(s.amount_cents > 0)) return null;
  const row = scheduleAsExpense(loan, s.date);
  const ahead = occurrences(row, today, addDays(today, 62), s.date).filter((d) => d >= s.date);
  const due = ahead[0];
  // Nothing is due once the term is over (a loan that wasn't ticked Paid off).
  const end = loanEndDate(loan);
  if (!due || (end && due > end)) return null;
  const before = occurrences(row, addDays(due, -62), addDays(due, -1), s.date).filter((d) => d >= s.date);
  const from = before.length ? addDays(before[before.length - 1], 1) : (s.date < due ? s.date : addDays(due, -30));
  const b = budgetedRepayment(loan);
  const paid = occurrences(repaymentRow(loan, b.frequency, b.amount_cents, b.date, b.date || s.date), from, due, b.date || s.date)
    .filter((d) => !b.date || d >= b.date);
  // Only a full period on the budgeted schedule can be short; one that started part way through can't be judged.
  const full = !b.date || b.date <= from;
  return { date: due, from, due_cents: s.amount_cents, budgeted_cents: paid.length * b.amount_cents, payments: paid.length, full_period: full };
}

// Steps the loan forward from a known balance. Stops at `until`, or when the loan
// is paid off if `until` is null (giving up after 50 years).
// `sample(date, balance, month)` is called on the first of each month, for
// charts, with what was repaid and charged in interest over the month just gone.
// Interest builds up daily, but the balance only changes on a few days a month (a
// repayment, the interest day), so it jumps from one of those days to the next and
// adds the days between at once. The result is the same as going day by day.
function simulateLoan(loan, until, sample) {
  const known = loan.balance_cents != null && loan.balance_date;
  let date = known ? loan.balance_date : loan.start_date;
  let balance = known ? loan.balance_cents : loan.principal_cents;
  if (!date || balance == null) return null;
  // The repayments actually being made (the budgeted ones), not the lender's minimum.
  // Before the budgeted repayments start, the scheduled ones are paid.
  const b = budgetedRepayment(loan);
  const s = scheduledRepayment(loan);
  const firstPay = b.date || loan.start_date;
  const asExpense = loanAsExpense(loan, firstPay || date);
  const asScheduled = scheduleAsExpense(loan, s.date || loan.start_date || date);
  const daily = (Number(loan.interest_rate) || 0) / 100 / 365;
  const offset = Number(loan.offset_cents) || 0;
  const interestDay = Math.min(Math.max(Number(loan.interest_day) || Number((loan.start_date || date).slice(8)), 1), 31);
  const limit = until || addDays(date, 365 * 50);
  let accrued = 0;
  let interestTotal = 0;
  let paidTotal = 0;
  let monthPaid = 0;
  let monthInterest = 0;
  while (date < limit && balance > 0) {
    // The days that matter over the next year or so (repayments, interest days, month starts).
    const from = addDays(date, 1);
    const chunkEnd = addDays(from, 366) < limit ? addDays(from, 366) : limit;
    const due = new Set(occurrences(asExpense, from, chunkEnd, firstPay || from));
    const dueScheduled = b.custom && b.date ? new Set(occurrences(asScheduled, from, chunkEnd, s.date || loan.start_date || from)) : new Set();
    const days = new Set([...due, ...dueScheduled, chunkEnd]);
    for (let [y, m] = from.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= chunkEnd.slice(0, 7); m === 12 ? (y += 1, m = 1) : (m += 1)) {
      const month = `${y}-${String(m).padStart(2, '0')}`;
      days.add(`${month}-${String(Math.min(interestDay, lastDayOfMonth(y, m - 1))).padStart(2, '0')}`);
      if (sample) days.add(`${month}-01`);
    }
    for (const day of [...days].filter((d) => d >= from && d <= chunkEnd).sort()) {
      if (sample && day.endsWith('-01')) {
        sample(day, balance, { paid_cents: Math.round(monthPaid), interest_cents: Math.round(monthInterest) });
        monthPaid = 0;
        monthInterest = 0;
      }
      // Money in an offset account isn't charged interest. Every day up to and including this one.
      accrued += Math.max(0, balance - offset) * daily * daysBetween(date, day);
      date = day;
      const [y, m, d] = day.split('-').map(Number);
      if (d === Math.min(interestDay, lastDayOfMonth(y, m - 1))) {
        balance += accrued;
        interestTotal += accrued;
        monthInterest += accrued;
        accrued = 0;
      }
      const budgeted = !b.custom || !b.date || day >= b.date;
      const isDue = budgeted ? due.has(day) : dueScheduled.has(day);
      if (isDue && (!loan.start_date || day > loan.start_date)) {
        const pay = Math.min(budgeted ? b.amount_cents : s.amount_cents, balance + accrued);
        balance -= pay;
        paidTotal += pay;
        monthPaid += pay;
      }
      if (balance <= 0) break;
    }
  }
  // The last part-month of a loan run to pay-off.
  if (sample && !until && (monthPaid || monthInterest)) {
    sample(addDays(date, 1), balance, { paid_cents: Math.round(monthPaid), interest_cents: Math.round(monthInterest) });
    monthPaid = 0;
    monthInterest = 0;
  }
  return { date, balance_cents: Math.max(0, Math.round(balance)), interest_cents: Math.round(interestTotal), paid_cents: Math.round(paidTotal), paid_off: balance <= 0,
    month_so_far: { paid_cents: Math.round(monthPaid), interest_cents: Math.round(monthInterest) } };
}

// When the balance comes from a statement, nothing is known about the loan
// before it. Estimate that stretch from the start date at today's rate, so the
// interest and repayments so far aren't zero. The estimated balance on the
// statement date shows how close the guess is.
function loanHistory(loan) {
  const known = loan.balance_cents != null && loan.balance_date;
  if (!known || !loan.start_date || !(loan.principal_cents > 0) || loan.start_date >= loan.balance_date) return null;
  // The offset balance is today's, so it isn't applied to the years before the statement.
  const fresh = { ...loan, balance_cents: null, balance_date: null, offset_cents: null };
  return { fresh, to: loan.balance_date, statement_balance_cents: loan.balance_cents };
}

// Month-by-month balance from the start to pay-off, plus what has gone in so
// far. Used for the loan detail charts.
function loanTimeline(loan, today) {
  // Each point is the end of a month: the balance then, and that month's repayments and interest.
  const points = [];
  let interestSum = 0;
  let carry = null;
  const add = (date, balance, month) => {
    if (carry) {
      month = { paid_cents: month.paid_cents + carry.paid_cents, interest_cents: month.interest_cents + carry.interest_cents };
      carry = null;
    }
    interestSum += month.interest_cents;
    points.push({ month: addDays(date, -1).slice(0, 7), balance_cents: Math.round(Math.max(0, balance)),
      paid_cents: month.paid_cents, interest_cents: month.interest_cents, interest_total_cents: interestSum });
  };
  // Part-months at the joins are carried into the next month.
  const h = loanHistory(loan);
  const before = h ? simulateLoan(h.fresh, h.to, add) : null;
  if (before) {
    carry = before.month_so_far;
    // Bend the estimate so it meets the statement balance, rather than jumping to it.
    const gap = h.statement_balance_cents - before.balance_cents;
    points.forEach((p, i) => { p.balance_cents = Math.max(0, Math.round(p.balance_cents + (gap * (i + 1)) / (points.length + 1))); });
  }
  const sofar = simulateLoan(loan, today, add);
  if (!sofar) return null;
  carry = carry ? { paid_cents: carry.paid_cents + sofar.month_so_far.paid_cents, interest_cents: carry.interest_cents + sofar.month_so_far.interest_cents } : sofar.month_so_far;
  const rest = sofar.paid_off ? null : simulateLoan({ ...loan, balance_cents: sofar.balance_cents, balance_date: today }, null, add);
  return {
    from: loan.start_date || loan.balance_date,
    points,
    history: before ? { to: h.to, paid_cents: before.paid_cents, interest_cents: before.interest_cents,
      estimated_balance_cents: before.balance_cents, statement_balance_cents: h.statement_balance_cents } : null,
    paid_to_date_cents: sofar.paid_cents + (before ? before.paid_cents : 0),
    interest_to_date_cents: sofar.interest_cents + (before ? before.interest_cents : 0),
    paid_since_cents: sofar.paid_cents,
    interest_since_cents: sofar.interest_cents,
    paid_left_cents: rest ? rest.paid_cents : 0,
    interest_left_cents: rest ? rest.interest_cents : 0,
    payoff_date: rest && rest.paid_off ? rest.date : sofar.paid_off ? sofar.date : null,
  };
}

// Estimates shown on the Loans tab. Every page load asks for them, so each loan's are
// kept until the loan (or the day) changes.
const estimateCache = new Map();
function loanEstimates(loan, today) {
  const key = `${today}|${JSON.stringify(loan)}`;
  if (!estimateCache.has(key)) {
    if (estimateCache.size >= 1000) estimateCache.clear();
    estimateCache.set(key, workOutEstimates(loan, today));
  }
  return structuredClone(estimateCache.get(key));
}

function workOutEstimates(loan, today) {
  const now = simulateLoan(loan, today);
  const h = loanHistory(loan);
  const before = h ? simulateLoan(h.fresh, h.to) : null;
  const payoff = now && !now.paid_off ? simulateLoan({ ...loan, balance_cents: now.balance_cents, balance_date: today }, null) : now;
  const s = scheduledRepayment(loan);
  const b = budgetedRepayment(loan);
  const perYear = (r) => r.amount_cents * LOAN_FREQUENCIES[r.frequency];
  return {
    calculated_repayment_cents: calculatedRepayment(loan),
    repayment_cents_used: s.amount_cents,
    scheduled: { ...s, per_month_cents: Math.round(perYear(s) / 12) },
    budgeted: { ...b, per_month_cents: Math.round(perYear(b) / 12) },
    next_due: nextDue(loan, today),
    end_date: loanEndDate(loan),
    estimated_balance_cents: now ? now.balance_cents : null,
    estimated_payoff_date: payoff && payoff.paid_off ? payoff.date : null,
    estimated_interest_left_cents: payoff ? payoff.interest_cents : null,
    estimated_interest_paid_cents: now ? now.interest_cents + (before ? before.interest_cents : 0) : null,
    estimates_from: loan.balance_cents != null && loan.balance_date ? loan.balance_date : loan.start_date || null,
  };
}

module.exports = {
  FREQUENCIES, PAY_FREQUENCIES, DEFAULT_PAY_CYCLE, payCycle, paysPerYear, monthlyStart,
  addDays, daysBetween, isValidDate, cycleIndexFor, cycleBounds,
  perPayCents, occurrences, INCOME_FREQUENCIES, incomePerCycle, isSplit, perCycleCents, inRange, nextDate, movedFrom, spreadsEachCycle, yearStart, paidBetween, fundedRows,
  LOAN_FREQUENCIES, amortisedRepayment, maxPrincipal, addMonths, loanAsExpense, scheduleAsExpense,
  scheduledRepayment, budgetedRepayment, nextDue, loanEndDate, calculatedRepayment, minimumBalance,
  loanRepayment, simulateLoan, loanEstimates, loanTimeline, loanHistory, ROUNDING, DEFAULT_DEPOSIT_RULES, roundUp, depositCents, buildCycle,
  heldEstimates,
};
