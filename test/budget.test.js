'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const budget = require('../src/budget');

// A made-up household, worked through by hand: e.g. Bills is $270 a fortnight
// plus $180.99 a month (× 12 ÷ 26 = $83.53) plus $2,435 a year (÷ 26 = $93.65),
// $447.18 a fortnight, rounded up to the next $10 = $450.
const ANCHOR = '2026-10-06';
const accounts = [{ id: 1, name: 'Mortgage' }, { id: 2, name: 'Bills' }, { id: 3, name: 'Direct debits' }, { id: 4, name: 'Everyday' }];
const rows = [
  [1, 'fortnightly', 0, null, 650],
  [2, 'fortnightly', 0, null, 90], [2, 'fortnightly', 3, null, 180], [2, 'monthly', 15, null, 120],
  [2, 'monthly', 22, null, 45], [2, 'monthly', 8, null, 15.99], [2, 'yearly', 12, 10, 780],
  [2, 'yearly', 1, 7, 1200], [2, 'yearly', 3, 3, 95], [2, 'yearly', 18, 11, 360],
  [3, 'fortnightly', 4, null, 95], [3, 'fortnightly', 11, null, 140], [3, 'monthly', 16, null, 249.5],
  [3, 'monthly', 27, null, 64.2], [3, 'monthly', 2, null, 30],
  [4, 'fortnightly', 1, null, 350], [4, 'fortnightly', 8, null, 150],
];
const expenses = rows.map(([account_id, frequency, day, month, amount], i) => ({
  id: i + 1, name: `Bill ${i + 1}`, account_id, frequency, active: 1,
  amount_cents: Math.round(amount * 100),
  day_offset: frequency === 'fortnightly' ? day : null,
  day_of_month: frequency === 'fortnightly' ? null : day,
  start_month: month,
}));

test('recommended deposits per account', () => {
  const result = budget.buildCycle({ anchor: ANCHOR, index: 0, today: '2026-10-11', expenses, accounts, incomes: [] });
  const deposit = Object.fromEntries(result.accounts.map((a) => [a.account_id, a.deposit_cents / 100]));
  assert.deepEqual(deposit, { 1: 650, 2: 450, 3: 400, 4: 500 });
});

test('bills due in the cycle and their total', () => {
  const result = budget.buildCycle({ anchor: ANCHOR, index: 0, today: '2026-10-11', expenses, accounts, incomes: [] });
  assert.equal(result.cycle.start, '2026-10-06');
  assert.equal(result.cycle.end, '2026-10-19');
  assert.equal(result.totals.bills_cents, 282049);
  assert.ok(result.bills.every((b, i, all) => i === 0 || all[i - 1].date <= b.date));
  assert.equal(result.bills.find((b) => b.date === '2026-10-12').amount_cents, 78000);
});

test('bill status follows today', () => {
  const result = budget.buildCycle({ anchor: ANCHOR, index: 0, today: '2026-10-08', expenses, accounts, incomes: [] });
  const statuses = new Set(result.bills.map((b) => `${b.date < '2026-10-08' ? 'before' : b.date === '2026-10-08' ? 'on' : 'after'}:${b.status}`));
  assert.deepEqual([...statuses].sort(), ['after:upcoming', 'before:paid', 'on:due']);
});

test('cycles step by fourteen days in both directions', () => {
  assert.deepEqual(budget.cycleBounds(ANCHOR, 1), { index: 1, start: '2026-10-20', end: '2026-11-02' });
  assert.deepEqual(budget.cycleBounds(ANCHOR, -1), { index: -1, start: '2026-09-22', end: '2026-10-05' });
  assert.equal(budget.cycleIndexFor(ANCHOR, '2026-10-05'), -1);
  assert.equal(budget.cycleIndexFor(ANCHOR, '2026-10-19'), 0);
  assert.equal(budget.cycleIndexFor(ANCHOR, '2026-10-20'), 1);
});

test('occurrences for each frequency', () => {
  const e = (frequency, extra) => ({ frequency, amount_cents: 100, ...extra });
  assert.deepEqual(budget.occurrences(e('weekly', { day_offset: 2 }), '2026-10-06', '2026-10-19'), ['2026-10-08', '2026-10-15']);
  assert.deepEqual(budget.occurrences(e('monthly', { day_of_month: 31 }), '2027-02-20', '2027-03-05'), ['2027-02-28']);
  assert.deepEqual(budget.occurrences(e('quarterly', { day_of_month: 1, start_month: 2 }), '2026-01-01', '2026-12-31'),
    ['2026-02-01', '2026-05-01', '2026-08-01', '2026-11-01']);
  assert.deepEqual(budget.occurrences(e('yearly', { day_of_month: 25, start_month: 12 }), '2026-12-20', '2027-01-02'), ['2026-12-25']);
});

test('income only counts in cycles where it is active', () => {
  const incomes = [{ id: 1, name: 'A', after_tax_cents: 100000 }, { id: 2, name: 'B', after_tax_cents: 50000, end_date: '2026-10-01' }];
  const result = budget.buildCycle({ anchor: ANCHOR, index: 0, today: '2026-10-11', expenses: [], accounts: [], incomes });
  assert.equal(result.totals.income_cents, 100000);
});

test('deposit rounding and buffer follow the household rules', () => {
  const d = (dollars, rounding, buffer_percent = 0) => budget.depositCents(dollars * 100, { rounding, buffer_percent }) / 100;
  assert.equal(d(293, 'exact'), 293);
  assert.equal(d(293, 'up5'), 295);
  assert.equal(d(293, 'up10'), 300);
  assert.equal(d(301, 'up10'), 310);
  assert.equal(d(301, 'up10', 10), 340); // 301 + 10% = 331.10, then up to the next $10
  assert.equal(d(293, 'up5', 5), 310); // 307.65 -> 310
  assert.equal(d(301, 'exact', 10), 331.1);
  assert.equal(d(300, 'up10'), 300); // already round: no extra step
  assert.equal(d(292.31, 'exact'), 292.31);
});

test('rounding applies to the account total, not each bill', () => {
  const twoBills = [
    { id: 1, name: 'A', account_id: 1, frequency: 'fortnightly', day_offset: 0, amount_cents: 15100, active: 1 },
    { id: 2, name: 'B', account_id: 1, frequency: 'fortnightly', day_offset: 0, amount_cents: 15000, active: 1 },
  ];
  const result = budget.buildCycle({ anchor: ANCHOR, index: 0, today: ANCHOR, expenses: twoBills,
    accounts: [{ id: 1, name: 'Direct' }], incomes: [], rules: { rounding: 'up10', buffer_percent: 10 } });
  assert.equal(result.accounts[0].rounded_cents, 31000); // 301 -> 310, not 160 + 150
  assert.equal(result.accounts[0].deposit_cents, 34000); // 301 + 10% = 331.10 -> 340
});

test('pay cycles can be weekly, monthly or a custom number of days', () => {
  const weekly = budget.payCycle('weekly');
  assert.deepEqual(budget.cycleBounds('2026-10-06', 1, weekly), { index: 1, start: '2026-10-13', end: '2026-10-19' });
  const monthly = budget.payCycle('monthly');
  assert.deepEqual(budget.cycleBounds('2026-01-31', 1, monthly), { index: 1, start: '2026-02-28', end: '2026-03-30' });
  assert.equal(budget.cycleIndexFor('2026-01-15', '2026-03-14', monthly), 1);
  assert.equal(budget.cycleIndexFor('2026-01-15', '2026-03-15', monthly), 2);
  const custom = budget.payCycle('custom', 10);
  assert.deepEqual(budget.cycleBounds('2026-10-06', -1, custom), { index: -1, start: '2026-09-26', end: '2026-10-05' });
  // A $260 fortnightly bill is $130 a week, $563.33 a month.
  const bill = { amount_cents: 26000, frequency: 'fortnightly' };
  assert.equal(budget.perPayCents(bill, weekly), 13000);
  assert.equal(Math.round(budget.perPayCents(bill, monthly)), 56333);
});

test('fortnightly bills stay on their fortnight when pay is weekly', () => {
  const bill = { frequency: 'fortnightly', day_offset: 2 };
  assert.deepEqual(budget.occurrences(bill, '2026-10-06', '2026-10-12', '2026-10-06'), ['2026-10-08']);
  assert.deepEqual(budget.occurrences(bill, '2026-10-13', '2026-10-19', '2026-10-06'), []);
  assert.deepEqual(budget.occurrences(bill, '2026-10-20', '2026-10-26', '2026-10-06'), ['2026-10-22']);
});

test('loan repayments and estimates', () => {
  // $500,000 at 6% over 30 years, monthly: the textbook repayment is $2,997.75.
  const loan = { id: 1, name: 'Home', principal_cents: 50000000, interest_rate: 6, term_months: 360,
    repayment_frequency: 'monthly', start_date: '2024-01-15' };
  assert.equal(budget.calculatedRepayment(loan), 299775);
  assert.equal(budget.loanRepayment({ ...loan, repayment_cents: 350000 }), 350000);
  const est = budget.loanEstimates(loan, '2026-10-11');
  assert.ok(est.estimated_balance_cents < 50000000 && est.estimated_balance_cents > 47000000);
  assert.ok(est.estimated_payoff_date > '2053-01-01' && est.estimated_payoff_date <= '2054-01-15');
  // Paying more pays it off sooner.
  const faster = budget.loanEstimates({ ...loan, repayment_cents: 400000 }, '2026-10-11');
  assert.ok(faster.estimated_payoff_date < est.estimated_payoff_date);
  // A known balance from a statement takes over from the original amount.
  const fromStatement = budget.loanEstimates({ ...loan, balance_cents: 10000000, balance_date: '2026-10-01' }, '2026-10-11');
  assert.ok(fromStatement.estimated_balance_cents < 10100000);
  // maxPrincipal is the reverse of the repayment.
  assert.equal(Math.round(budget.maxPrincipal(299775, 6, 12, 360) / 100), 500000);
});

test('budgeted loan repayments can differ from the scheduled ones', () => {
  // $1,400 due monthly on the 15th, paid $700 a fortnight from 2 Oct.
  const loan = { id: 1, name: 'Car', account_id: 1, principal_cents: 3000000, interest_rate: 7, start_date: '2026-01-15',
    term_months: 60, repayment_frequency: 'monthly', repayment_cents: 140000, scheduled_date: '2026-02-15',
    budget_frequency: 'fortnightly', budget_cents: 70000, budget_date: '2026-10-02' };
  const row = budget.loanAsExpense(loan, '2026-10-02');
  assert.equal(row.frequency, 'fortnightly');
  assert.equal(row.amount_cents, 70000);
  assert.deepEqual(budget.occurrences(row, '2026-10-01', '2026-10-31', '2026-10-02'), ['2026-10-02', '2026-10-16', '2026-10-30']);
  const due = budget.nextDue(loan, '2026-10-11');
  assert.deepEqual(due, { date: '2026-10-15', from: '2026-09-16', due_cents: 140000, budgeted_cents: 70000, payments: 1, full_period: false });
  assert.equal(budget.nextDue({ ...loan, budget_date: '2026-09-04' }, '2026-10-11').budgeted_cents, 140000);
  const est = budget.loanEstimates(loan, '2026-10-11');
  assert.equal(est.scheduled.per_month_cents, 140000);
  assert.equal(est.budgeted.per_month_cents, 151667);
  // Without a budgeted amount it follows the schedule.
  const plain = budget.loanAsExpense({ ...loan, budget_cents: null }, '2026-10-02');
  assert.equal(plain.frequency, 'monthly');
  assert.equal(plain.day_of_month, 15);
  // Paying more than scheduled pays it off sooner.
  const sooner = budget.loanEstimates({ ...loan, budget_date: '2026-02-01' }, '2026-10-11').estimated_payoff_date;
  const later = budget.loanEstimates({ ...loan, budget_cents: null }, '2026-10-11').estimated_payoff_date;
  assert.ok(sooner < later, `${sooner} < ${later}`);
});

test('yearly savings split across cycles, only count as expenses when asked, and temporary rows end', () => {
  const monthly = budget.payCycle('monthly');
  const base = { active: 1, kind: 'saving', frequency: 'yearly', amount_cents: 100000, yearly_cents: 100000, account_id: 1 };
  const exps = [
    { ...base, id: 1, name: 'Holiday' },
    { ...base, id: 2, name: 'Xmas', show_as_expense: 1 },
    { id: 3, name: 'Gym', active: 1, frequency: 'monthly', day_of_month: 3, amount_cents: 5000, account_id: 1, end_date: '2026-10-31' },
  ];
  const incomes = [{ id: 1, name: 'Pay', after_tax_cents: 300000, frequency: 'fortnightly' },
    { id: 2, name: 'Contract', after_tax_cents: 100000, frequency: 'monthly', end_date: '2026-10-31' }];
  const run = (index) => budget.buildCycle({ anchor: '2026-10-01', index, today: '2026-10-11', expenses: exps,
    accounts: [{ id: 1 }], incomes, payCycle: monthly, rules: { rounding: 'exact', buffer_percent: 0 } });
  const oct = run(0);
  assert.equal(oct.bills.filter((b) => b.kind === 'saving').length, 2);
  assert.equal(oct.bills.find((b) => b.name === 'Holiday').amount_cents, 8333);
  assert.equal(oct.bills.find((b) => b.name === 'Holiday').is_expense, false);
  assert.equal(oct.bills.find((b) => b.name === 'Xmas').is_expense, true);
  assert.equal(oct.totals.bills_cents, 8333 + 5000);
  assert.equal(oct.totals.savings_cents, 8333 * 2);
  assert.equal(oct.accounts[0].deposit_cents, Math.ceil(200000 / 12) + 5000);
  // Fortnightly pay averaged over a monthly budget: 3000 × 26 ÷ 12.
  assert.equal(oct.incomes[0].amount_cents, 650000);
  assert.equal(oct.totals.income_cents, 750000);
  const nov = run(1);
  assert.equal(nov.totals.income_cents, 650000);
  assert.equal(nov.bills.some((b) => b.name === 'Gym'), false);
  assert.equal(budget.perCycleCents(exps[0], budget.payCycle('fortnightly')), 100000 / 26);
});

test('what an account should hold today', () => {
  const pc = budget.payCycle('fortnightly');
  // $50 a fortnight towards a $1,300 yearly bill due in two cycles (cycles start 6 Jan, 20 Jan; bill 2 Feb).
  const bill = { id: 1, active: 1, account_id: 1, frequency: 'yearly', amount_cents: 130000, day_of_month: 2, start_month: 2 };
  const saving = { id: 2, active: 1, account_id: 1, kind: 'saving', frequency: 'fortnightly', amount_cents: 2000, day_offset: 0 };
  const opts = { today: '2026-01-10', anchor: '2026-01-06', payCycle: pc };
  // Per-cycle: 1300 / 26 = $50. Deposits on 20 Jan and 3 Feb... only 20 Jan is before the 2 Feb bill.
  let [acct] = budget.heldEstimates([bill, saving], [{ id: 1 }], opts);
  assert.equal(acct.held_cents, 130000 - 5000);
  // A $100 fortnightly bill paid with its own $100 a fortnight needs only the next one held.
  const rent = { id: 3, active: 1, account_id: 2, frequency: 'fortnightly', amount_cents: 10000, day_offset: 7 };
  [, acct] = budget.heldEstimates([rent], [{ id: 1 }, { id: 2 }], opts);
  assert.equal(acct.held_cents, 10000); // 13 Jan comes out before the 20 Jan deposit
  // Bills more than 12 months away aren't counted.
  const later = { ...bill, start_date: '2027-03-01' };
  [acct] = budget.heldEstimates([later], [{ id: 1 }], opts);
  assert.equal(acct.held_cents, 0);
});

test("deposits for a bill that hasn't started yet don't count towards what's held before it starts", () => {
  const pc = budget.payCycle('fortnightly');
  const opts = { today: '2026-01-10', anchor: '2026-01-06', payCycle: pc };
  const bill = { id: 1, active: 1, account_id: 1, frequency: 'yearly', amount_cents: 130000, day_of_month: 2, start_month: 2 };
  const later = { id: 2, active: 1, account_id: 1, frequency: 'monthly', amount_cents: 50000, day_of_month: 15, start_date: '2026-08-01' };
  const [alone] = budget.heldEstimates([bill], [{ id: 1 }], opts);
  const [both] = budget.heldEstimates([bill, later], [{ id: 1 }], opts);
  assert.equal(both.held_cents, alone.held_cents);
});

test('dates must be real and between 1900 and 2199', () => {
  assert.equal(budget.isValidDate('2026-02-28'), true);
  assert.equal(budget.isValidDate('2026-02-30'), false);
  assert.equal(budget.isValidDate('0100-01-01'), false);
  assert.equal(budget.isValidDate('2200-01-01'), false);
  assert.equal(budget.isValidDate('1900-01-01'), true);
});

test('unknown pay frequencies and rounding fall back to the defaults', () => {
  assert.deepEqual(budget.payCycle('constructor'), { frequency: 'fortnightly', days: 14 });
  assert.deepEqual(budget.payCycle('toString'), { frequency: 'fortnightly', days: 14 });
  assert.equal(budget.roundUp(29301, 'toString'), 29301);
});

test('ended income leaves the current cycle, and savings are kept apart from bills per account', () => {
  const c = budget.buildCycle({ anchor: '2026-10-06', index: 0, today: '2026-10-11',
    expenses: [{ id: 1, active: 1, kind: 'saving', frequency: 'fortnightly', day_offset: 0, amount_cents: 2000, account_id: 1, name: 'Save' }],
    accounts: [{ id: 1 }], incomes: [{ id: 1, name: 'Old job', after_tax_cents: 100000, end_date: '2026-10-08' },
      { id: 2, name: 'Pay', after_tax_cents: 200000 }], rules: { rounding: 'exact', buffer_percent: 0 } });
  assert.deepEqual(c.incomes.map((i) => i.name), ['Pay']);
  assert.deepEqual([c.accounts[0].bills_cents, c.accounts[0].savings_cents, c.accounts[0].spare_cents], [0, 2000, 0]);
  // A temporary bill that ends before it next comes out isn't saved for.
  const gone = budget.buildCycle({ anchor: '2026-10-06', index: 0, today: '2026-10-07', accounts: [{ id: 1 }], incomes: [],
    expenses: [{ id: 1, active: 1, frequency: 'monthly', day_of_month: 15, amount_cents: 5000, account_id: 1, end_date: '2026-10-10', name: 'Gym' }],
    rules: { rounding: 'exact', buffer_percent: 0 } });
  assert.equal(gone.accounts[0].deposit_cents, 0);
  assert.equal(gone.bills.length, 0);
  const past = budget.buildCycle({ anchor: '2026-09-22', index: 0, today: '2026-10-11', expenses: [], accounts: [],
    incomes: [{ id: 1, name: 'Old job', after_tax_cents: 100000, end_date: '2026-10-08' }] });
  assert.equal(past.incomes.length, 1);
});

test('savings that come round less often than the cycle show their share each cycle', () => {
  const c = budget.buildCycle({ anchor: '2026-10-06', index: 0, today: '2026-10-11', accounts: [{ id: 1 }], incomes: [],
    expenses: [{ id: 1, active: 1, kind: 'saving', show_as_expense: 1, frequency: 'yearly', day_of_month: 1, start_month: 3, amount_cents: 40000, account_id: 1, name: 'Car' }],
    rules: { rounding: 'up5', buffer_percent: 0 } });
  assert.deepEqual(c.bills.map((b) => [b.date, b.amount_cents, b.is_expense]), [['2026-10-06', 1538, true]]);
  assert.equal(c.accounts[0].deposit_cents, 2000);
});

test('loan pays the scheduled repayment until the budgeted one starts, and has a timeline', () => {
  const loan = { id: 1, name: 'Car', principal_cents: 1200000, interest_rate: 0, start_date: '2026-01-01', term_months: 12,
    repayment_frequency: 'monthly', repayment_cents: 100000, budget_cents: 50000, budget_frequency: 'fortnightly', budget_date: '2026-07-03' };
  const mid = budget.simulateLoan(loan, '2026-07-02');
  assert.equal(mid.paid_cents, 600000); // Feb to Jul, monthly
  const t = budget.loanTimeline(loan, '2026-10-11');
  assert.ok(t.points.length >= 10);
  assert.deepEqual(t.points[0], { month: '2026-01', balance_cents: 1200000, paid_cents: 0, interest_cents: 0, interest_total_cents: 0 });
  assert.equal(t.points[1].paid_cents, 100000); // 1 Feb repayment
  assert.equal(t.points.reduce((sum, p) => sum + p.paid_cents, 0), 1200000);
  assert.equal(t.interest_to_date_cents, 0);
  assert.ok(t.payoff_date);
});

test('interest before a statement balance is estimated from the start date', () => {
  const loan = { id: 1, name: 'Home', principal_cents: 50000000, interest_rate: 6, start_date: '2020-01-01', term_months: 360,
    repayment_frequency: 'monthly', balance_cents: 45000000, balance_date: '2026-10-01' };
  const t = budget.loanTimeline(loan, '2026-10-11');
  assert.ok(t.history.interest_cents > 15000000, String(t.history.interest_cents)); // ~6 years of 6% on ~$480k
  assert.ok(Math.abs(t.history.estimated_balance_cents - 45000000) < 2000000);
  assert.equal(t.interest_to_date_cents, t.history.interest_cents + t.interest_since_cents);
  assert.equal(t.points[0].month, '2020-01');
  const est = budget.loanEstimates(loan, '2026-10-11');
  assert.equal(est.estimated_interest_paid_cents, t.interest_to_date_cents);
});

test('next date respects today, start and end dates', () => {
  const rent = { frequency: 'monthly', day_of_month: 11 };
  assert.equal(budget.nextDate(rent, '2026-10-11'), '2026-10-11'); // due today counts
  assert.equal(budget.nextDate(rent, '2026-10-12'), '2026-11-11');
  assert.equal(budget.nextDate({ ...rent, start_date: '2027-01-01' }, '2026-10-12'), '2027-01-11');
  assert.equal(budget.nextDate({ ...rent, end_date: '2026-11-01' }, '2026-10-12'), null);
  assert.equal(budget.nextDate({ frequency: 'fortnightly', day_offset: 3 }, '2026-10-12', '2026-10-01'), '2026-10-18');
});

test('paid so far counts dates before today, and per-cycle savings by cycle', () => {
  assert.equal(budget.yearStart('2026-10-11', 'financial'), '2026-07-01');
  assert.equal(budget.yearStart('2026-03-11', 'financial'), '2025-07-01');
  assert.equal(budget.yearStart('2026-10-11', 'calendar'), '2026-01-01');
  const rent = { frequency: 'monthly', day_of_month: 11, amount_cents: 10000 };
  // Jul, Aug, Sep 11 (today's isn't counted yet).
  assert.deepEqual(budget.paidBetween(rent, '2026-07-01', '2026-10-11'), { count: 3, cents: 30000 });
  assert.deepEqual(budget.paidBetween({ ...rent, start_date: '2026-09-01' }, '2026-07-01', '2026-10-11'), { count: 1, cents: 10000 });
  const pc = budget.payCycle('fortnightly');
  const saving = { kind: 'saving', frequency: 'yearly', amount_cents: 26000, yearly_cents: 26000, day_of_month: 1, start_month: 1 };
  const r = budget.paidBetween(saving, '2026-07-01', '2026-10-11', { anchor: '2026-07-06', payCycle: pc });
  assert.equal(r.count, 7); // 6 Jul … 28 Sep
  assert.equal(r.cents, 7000);
});

test('paid so far uses the price in force on each date', () => {
  // $100 a month from January, $120 from 1 September: Jul + Aug at $100, Sep + Oct at $120.
  const bill = { frequency: 'monthly', day_of_month: 1, amount_cents: 12000 };
  const history = [
    { id: 1, field: 'amount_cents', on_date: '2026-01-01', value: 10000, frequency: 'monthly' },
    { id: 2, field: 'amount_cents', on_date: '2026-09-01', value: 12000, frequency: 'monthly' },
  ];
  assert.deepEqual(budget.paidBetween(bill, '2026-07-01', '2026-10-15', { history }), { count: 4, cents: 44000 });
  assert.deepEqual(budget.paidBetween(bill, '2026-07-01', '2026-10-15'), { count: 4, cents: 48000 }); // no history: today's price
  // Added in March with payments from January: its first amount covers the months before.
  assert.deepEqual(budget.paidBetween(bill, '2026-01-01', '2026-04-15', { history: [{ ...history[0], on_date: '2026-03-10' }] }), { count: 4, cents: 40000 });
  // A change of how often it's paid: $300 quarterly (Jan, Apr) then $100 monthly from 1 June.
  const q = { frequency: 'monthly', day_of_month: 1, start_month: 1, amount_cents: 10000 };
  const hq = [
    { id: 1, field: 'amount_cents', on_date: '2026-01-01', value: 30000, frequency: 'quarterly' },
    { id: 2, field: 'amount_cents', on_date: '2026-06-01', value: 10000, frequency: 'monthly' },
  ];
  assert.deepEqual(budget.paidBetween(q, '2026-01-01', '2026-08-15', { history: hq }), { count: 5, cents: 90000 });
  // Other fields' history is ignored.
  assert.deepEqual(budget.paidBetween(bill, '2026-07-01', '2026-10-15', { history: [{ id: 3, field: 'interest_rate', on_date: '2026-08-01', value: 5 }] }), { count: 4, cents: 48000 });
});

test('days a month does not have move to its last day', () => {
  const rent = { frequency: 'monthly', day_of_month: 31 };
  assert.deepEqual(budget.occurrences(rent, '2026-01-01', '2026-06-30'),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
  // Leap years keep the 29th; the 30th lands on the 29th.
  assert.deepEqual(budget.occurrences({ frequency: 'monthly', day_of_month: 30 }, '2028-02-01', '2028-03-31'), ['2028-02-29', '2028-03-30']);
  assert.deepEqual(budget.occurrences({ frequency: 'monthly', day_of_month: 29 }, '2027-02-01', '2027-03-31'), ['2027-02-28', '2027-03-29']);
  // Quarterly on the 31st, from February.
  assert.deepEqual(budget.occurrences({ frequency: 'quarterly', day_of_month: 31, start_month: 2 }, '2026-01-01', '2026-12-31'),
    ['2026-02-28', '2026-05-31', '2026-08-31', '2026-11-30']);
  // Moving doesn't drift: after February it's back on the 31st.
  assert.equal(budget.nextDate(rent, '2026-03-01'), '2026-03-31');
  assert.equal(budget.movedFrom(rent, '2026-02-28'), 31);
  assert.equal(budget.movedFrom(rent, '2026-03-31'), null);
  assert.equal(budget.movedFrom({ frequency: 'fortnightly', day_of_month: 31 }, '2026-02-28'), null);
  // A monthly loan repayment from the 31st follows the same rule.
  const loan = { id: 1, name: 'L', principal_cents: 1000000, interest_rate: 6, start_date: '2026-01-31', term_months: 24,
    repayment_frequency: 'monthly', repayment_cents: 50000, scheduled_date: '2026-01-31' };
  assert.equal(budget.nextDue(loan, '2027-02-01').date, '2027-02-28');
  assert.equal(budget.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(budget.addMonths('2028-01-31', 1), '2028-02-29');
  // The Overview flags the moved bill.
  const c = budget.buildCycle({ anchor: '2027-02-22', index: 0, today: '2027-02-22', accounts: [], incomes: [],
    expenses: [{ id: 1, name: 'Rent', amount_cents: 100, frequency: 'monthly', day_of_month: 31, active: 1 }] });
  assert.equal(c.bills[0].date, '2027-02-28');
  assert.equal(c.bills[0].moved_from_day, 31);
});

test('an offset balance cuts the interest from the statement on, not before it', () => {
  const loan = { id: 1, name: 'Home', principal_cents: 50000000, interest_rate: 6, start_date: '2020-01-01', term_months: 360,
    repayment_frequency: 'monthly', balance_cents: 45000000, balance_date: '2026-10-01' };
  const plain = budget.loanTimeline(loan, '2027-10-01');
  const offset = budget.loanTimeline({ ...loan, offset_cents: 5000000 }, '2027-10-01');
  assert.equal(offset.history.interest_cents, plain.history.interest_cents);
  // A year with $50k offset at 6% saves about $3,000 of interest.
  const saved = plain.interest_since_cents - offset.interest_since_cents;
  assert.ok(saved > 280000 && saved < 320000, String(saved));
  assert.ok(offset.payoff_date < plain.payoff_date);
});

test('minimum balance follows the standard schedule and reaches zero at the end', () => {
  const loan = { principal_cents: 2000000, interest_rate: 8, start_date: '2024-02-01', term_months: 60, repayment_frequency: 'monthly' };
  const r = budget.minimumBalance(loan, '2026-10-13'); // 32 repayments made
  assert.equal(r.repayments, 32);
  assert.equal(r.repayment_cents, 40553);
  assert.equal(r.balance_cents, 1032670); // checked by stepping month by month
  assert.equal(budget.minimumBalance(loan, '2029-02-01').balance_cents, 0);
  assert.equal(budget.minimumBalance({ ...loan, term_months: null }, '2026-01-01'), null);
  const f = budget.minimumBalance({ ...loan, repayment_frequency: 'fortnightly', interest_rate: 0 }, '2024-03-01'); // 2 fortnights in
  assert.equal(f.repayments, 2);
  assert.equal(f.balance_cents, Math.round(2000000 - (2000000 / 130) * 2));
});

test('the balance before a statement follows the repayments down to it', () => {
  // The next due date is in the future, but repayments were made since the start.
  const loan = { id: 1, name: 'Car', principal_cents: 2000000, interest_rate: 8, term_months: 60, repayment_frequency: 'monthly',
    start_date: '2023-06-01', scheduled_date: '2026-10-20' };
  const min = budget.minimumBalance(loan, '2026-10-13');
  const t = budget.loanTimeline({ ...loan, balance_cents: min.balance_cents, balance_date: '2026-10-13' }, '2026-10-13');
  const past = t.points.filter((p) => p.month < '2026-10');
  for (let i = 1; i < past.length; i++) assert.ok(past[i].balance_cents < past[i - 1].balance_cents);
  assert.ok(Math.abs(past.at(-1).balance_cents - min.balance_cents) < 50000); // meets the statement, no sudden drop
});

test('what to keep in an account, its lowest day and the big bills ahead', () => {
  const pc = budget.payCycle('fortnightly');
  const anchor = '2026-10-16';
  const bills = [
    { id: 1, active: 1, account_id: 1, name: 'Groceries', frequency: 'fortnightly', amount_cents: 25000, day_offset: 2 },
    { id: 2, active: 1, account_id: 1, name: 'Rates', frequency: 'yearly', amount_cents: 200000, day_of_month: 1, start_month: 11 },
  ];
  const held = (today) => budget.heldEstimates(bills, [{ id: 1 }], { today, anchor, payCycle: pc })[0];
  // The payday after the rates: this fortnight's $250 plus one pay's share of the rates ($2,000 / 26).
  assert.equal(held('2026-11-13').held_cents, 32692);
  // Half way through the year, half the rates.
  assert.equal(held('2027-05-01').held_cents, 125000);
  const before = held('2026-10-17');
  assert.equal(before.low_on, '2026-11-01');
  assert.equal(before.low_after, 'Rates');
  assert.deepEqual(before.ahead.map((b) => [b.name, b.date]), [['Rates', '2026-11-01']]);
});
