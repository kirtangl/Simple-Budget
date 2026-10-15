'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const { resetPassword } = require('../src/auth');

// Pins the server's clock for tests whose data is tied to particular dates.
// Only Date is faked, so timers and network calls carry on as normal.
function onDay(t, day) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(`${day}T12:00:00`) });
}

// Logs in with the default password and sets a new one, unless told not to.
async function withServer(options, fn) {
  const app = createApp({ db: openDatabase(':memory:'), ...options });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  try {
    if (!options.raw) {
      await call('POST', '/login', { password: 'simplebudget' });
      await call('POST', '/password', { password: 'household-pw' });
    }
    await fn(call);
  } finally { server.close(); }
}

test('first run: default password, then a new one is required', () => withServer({ raw: true }, async (call) => {
  let r = await call('GET', '/session');
  assert.deepEqual(r.body, { loggedIn: false, mustChangePassword: true, defaultPassword: 'simplebudget' });
  assert.equal((await call('GET', '/data')).status, 401);
  assert.equal((await call('POST', '/login', { password: 'nope' })).status, 401);
  r = await call('POST', '/login', { password: 'simplebudget' });
  assert.equal(r.body.mustChangePassword, true);
  // Everything else is blocked until a new password is chosen.
  assert.equal((await call('GET', '/data')).status, 403);
  assert.equal((await call('POST', '/password', { password: 'short' })).status, 400);
  assert.equal((await call('POST', '/password', { password: 'simplebudget' })).status, 400);
  assert.equal((await call('POST', '/password', { password: 'our-new-pw' })).status, 200);
  assert.equal((await call('GET', '/data')).status, 200);
  r = await call('GET', '/session');
  assert.deepEqual(r.body, { loggedIn: true, mustChangePassword: false });
}));

test('changing the password needs the current one and logs out other devices', () => withServer({}, async (call) => {
  assert.equal((await call('POST', '/password', { current: 'wrong', password: 'another-pw' })).status, 400);
  assert.equal((await call('POST', '/password', { current: 'household-pw', password: 'another-pw' })).status, 200);
  assert.equal((await call('GET', '/data')).status, 200); // this device got a fresh cookie
  await call('POST', '/logout');
  assert.equal((await call('POST', '/login', { password: 'household-pw' })).status, 401);
  assert.equal((await call('POST', '/login', { password: 'another-pw' })).status, 200);
}));

test('categories are seeded and expenses drive account deposits', () => withServer({}, async (call) => {
  const { body: data } = await call('GET', '/data');
  assert.ok(data.categories.length >= 7);
  assert.ok(data.categories[0].subcategories.length > 0);

  await call('PUT', '/settings', { pay_anchor_date: '2026-10-06' });
  const acct = (await call('POST', '/accounts', { name: 'Bills', bsb: '000-001', account_number: '12345' })).body;
  const exp = await call('POST', '/expenses', { name: 'Internet', amount_cents: 7910, frequency: 'monthly', day_of_month: 14, account_id: acct.id });
  assert.equal(exp.status, 201);
  await call('POST', '/incomes', { name: 'Pay', after_tax_cents: 300000 });

  const { body: cycle } = await call('GET', '/cycle?offset=0');
  const row = cycle.accounts.find((a) => a.account_id === acct.id);
  assert.equal(row.deposit_cents, 4000); // $36.51 a fortnight rounds up to $40
  assert.equal(cycle.totals.income_cents, 300000);
}));

test('validation errors are friendly', () => withServer({}, async (call) => {
  let r = await call('POST', '/expenses', { name: '', amount_cents: 100, frequency: 'monthly' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Name is required/);
  r = await call('POST', '/expenses', { name: 'X', amount_cents: 100, frequency: 'daily' });
  assert.equal(r.status, 400);
  r = await call('POST', '/expenses', { name: 'X', amount_cents: 100, frequency: 'monthly', account_id: 999 });
  assert.equal(r.status, 400);
  r = await call('PUT', '/settings', { pay_anchor_date: '2026-02-30' });
  assert.equal(r.status, 400);
}));

test('goals and debts are stored separately', () => withServer({}, async (call) => {
  await call('POST', '/goals', { kind: 'goal', group_name: 'Wishlist', name: 'Holiday', target_cents: 500000 });
  await call('POST', '/goals', { kind: 'debt', group_name: 'Loans', name: 'Car', target_cents: 1000000, current_cents: 250000 });
  const { body } = await call('GET', '/goals');
  assert.deepEqual(body.map((g) => g.kind).sort(), ['debt', 'goal']);
}));

test('deposit settings are saved and used', () => withServer({}, async (call) => {
  const acct = (await call('POST', '/accounts', { name: 'Direct' })).body;
  await call('POST', '/expenses', { name: 'Bill', amount_cents: 30100, frequency: 'fortnightly', day_offset: 0, account_id: acct.id });
  let r = await call('PUT', '/settings', { rounding: 'up10', buffer_percent: 10 });
  assert.equal(r.body.rounding, 'up10');
  assert.equal(r.body.buffer_percent, 10);
  const { body: cycle } = await call('GET', '/cycle?offset=0');
  assert.equal(cycle.accounts[0].deposit_cents, 34100);
  r = await call('PUT', '/settings', { buffer_percent: 25 });
  assert.equal(r.status, 400);
  r = await call('PUT', '/settings', { rounding: 'up7' });
  assert.equal(r.status, 400);
}));

test('backup round trip restores everything with the same numbers', () => withServer({}, async (call) => {
  await call('PUT', '/settings', { pay_anchor_date: '2026-10-06', rounding: 'up5', buffer_percent: 10 });
  const acct = (await call('POST', '/accounts', { name: 'Direct', bsb: '000-002' })).body;
  const payee = (await call('POST', '/payees', { name: 'Telstra' })).body;
  const { body: data } = await call('GET', '/data');
  const cat = data.categories.find((c) => c.name === 'Home & Utilities');
  const sub = cat.subcategories.find((s) => s.name === 'Internet');
  await call('POST', '/expenses', { name: 'Internet', amount_cents: 7910, frequency: 'monthly', day_of_month: 14,
    account_id: acct.id, payee_id: payee.id, category_id: cat.id, subcategory_id: sub.id });
  await call('POST', '/incomes', { name: 'Pay', after_tax_cents: 300000 });
  await call('POST', '/goals', { kind: 'debt', name: 'Car', target_cents: 100000 });
  const before = (await call('GET', '/cycle?offset=0')).body;
  const { body: backup } = await call('GET', '/export');
  assert.equal(backup.format_version, 2);

  await withServer({}, async (call2) => {
    const r = await call2('POST', '/import', backup);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.warnings, []);
    const after = (await call2('GET', '/cycle?offset=0')).body;
    assert.deepEqual(after.totals, before.totals);
    const { body: d } = await call2('GET', '/data');
    const e = d.expenses[0];
    assert.equal(d.accounts.find((a) => a.id === e.account_id).bsb, '000-002');
    assert.equal(d.payees.find((p) => p.id === e.payee_id).name, 'Telstra');
    assert.equal(d.categories.flatMap((c) => c.subcategories).find((s) => s.id === e.subcategory_id).name, 'Internet');
    assert.equal(d.settings.rounding, 'up5');
    assert.equal(d.settings.buffer_percent, 10);
    // Restoring twice replaces rather than duplicates.
    await call2('POST', '/import', backup);
    assert.equal((await call2('GET', '/data')).body.expenses.length, 1);
  });
}));

test('older or partial backups restore with defaults, newer ones are refused', () => withServer({}, async (call) => {
  // Looks like a file from an older version: no goals or settings sections,
  // a missing optional field, an unknown field, and one broken row.
  const old = {
    app: 'simple-budget', format_version: 1,
    accounts: [{ id: 7, name: 'Bills', some_future_field: 'ignored' }],
    expenses: [
      { id: 1, name: 'Rates', amount_cents: 20000, frequency: 'fortnightly', account_id: 7 },
      { id: 2, name: 'Broken', frequency: 'monthly' },
    ],
  };
  await call('POST', '/goals', { kind: 'goal', name: 'Holiday' });
  const r = await call('POST', '/import', old);
  assert.equal(r.status, 200);
  assert.equal(r.body.warnings.length, 1);
  assert.match(r.body.warnings[0], /Broken/);
  const { body: d } = await call('GET', '/data');
  assert.equal(d.expenses.length, 1);
  assert.equal(d.expenses[0].active, 1); // default filled in
  assert.equal(d.expenses[0].account_id, d.accounts[0].id);
  assert.equal(d.goals.length, 1); // section not in the file is left alone
  assert.ok(d.categories.length > 0); // so are the default categories

  assert.equal((await call('POST', '/import', { ...old, format_version: 99 })).status, 400);
  assert.equal((await call('POST', '/import', { hello: 'world' })).status, 400);
}));

test('income can be left out of the budget pool', () => withServer({}, async (call) => {
  const acct = (await call('POST', '/accounts', { name: 'Direct' })).body;
  await call('POST', '/expenses', { name: 'Bill', amount_cents: 30000, frequency: 'fortnightly', day_offset: 0, account_id: acct.id });
  const pay = (await call('POST', '/incomes', { name: 'Pay', after_tax_cents: 200000 })).body;
  const side = (await call('POST', '/incomes', { name: 'Side job', after_tax_cents: 50000, include_in_budget: false })).body;
  assert.equal(pay.include_in_budget, 1); // defaults to in the budget
  assert.equal(side.include_in_budget, 0);
  let { body: c } = await call('GET', '/cycle?offset=0');
  assert.equal(c.totals.income_cents, 200000);
  assert.equal(c.totals.other_income_cents, 50000);
  assert.equal(c.totals.remaining_cents, 200000 - 30000);
  assert.deepEqual(c.incomes.map((i) => i.in_budget), [true, false]);

  // Editing something else leaves the flag alone; switching it moves the money.
  await call('PATCH', `/incomes/${side.id}`, { name: 'Side gig' });
  await call('PATCH', `/incomes/${side.id}`, { include_in_budget: true });
  ({ body: c } = await call('GET', '/cycle?offset=0'));
  assert.equal(c.totals.income_cents, 250000);
  assert.equal(c.totals.other_income_cents, 0);

  // Backups from before this option restore with income in the budget.
  const r = await call('POST', '/import', { app: 'simple-budget', format_version: 1, incomes: [{ id: 3, name: 'Old pay', after_tax_cents: 100000 }] });
  assert.equal(r.status, 200);
  const { body: d } = await call('GET', '/data');
  assert.equal(d.incomes[0].include_in_budget, 1);
}));

test('BSB and account numbers are checked and tidied', () => withServer({}, async (call) => {
  let r = await call('POST', '/accounts', { name: 'A', bsb: '062000', account_number: '1234 5678' });
  assert.equal(r.status, 201);
  assert.equal(r.body.bsb, '062-000');
  assert.equal(r.body.account_number, '12345678');
  r = await call('PATCH', `/accounts/${r.body.id}`, { bsb: '062-001' });
  assert.equal(r.body.bsb, '062-001');
  for (const bsb of ['06200', '0620001', '06a-000']) {
    r = await call('POST', '/accounts', { name: 'B', bsb });
    assert.equal(r.status, 400, bsb);
    assert.match(r.body.error, /BSB/);
  }
  r = await call('POST', '/accounts', { name: 'B', account_number: '123456789012345678901' });
  assert.equal(r.status, 400);
  r = await call('POST', '/accounts', { name: 'B', account_number: '12AB' });
  assert.match(r.body.error, /numbers only/);

  // A backup with an old, badly formatted BSB keeps the account and its expenses.
  r = await call('POST', '/import', { app: 'simple-budget', format_version: 1,
    accounts: [{ id: 1, name: 'Old', bsb: '12-34', account_number: '999' }],
    expenses: [{ id: 1, name: 'Rent', amount_cents: 100, frequency: 'fortnightly', account_id: 1 }] });
  assert.equal(r.status, 200);
  assert.match(r.body.warnings[0], /BSB/);
  const { body: d } = await call('GET', '/data');
  assert.equal(d.accounts[0].bsb, null);
  assert.equal(d.accounts[0].account_number, '999');
  assert.equal(d.expenses[0].account_id, d.accounts[0].id);
}));

test('goals and debts keep their dates', () => withServer({}, async (call) => {
  const debt = (await call('POST', '/goals', { kind: 'debt', name: 'Car loan', start_date: '2024-03-01', target_date: '2027-06-30', target_firm: true })).body;
  assert.equal(debt.start_date, '2024-03-01');
  assert.equal(debt.target_firm, 1);
  const goal = (await call('POST', '/goals', { kind: 'goal', name: 'Holiday', target_date: '2027-01-01' })).body;
  assert.equal(goal.target_firm, 0);
  assert.equal((await call('POST', '/goals', { kind: 'goal', name: 'X', target_date: 'soon' })).status, 400);
  const { body: backup } = await call('GET', '/export');
  await call('POST', '/import', backup);
  const { body: d } = await call('GET', '/data');
  const car = d.goals.find((g) => g.name === 'Car loan');
  assert.deepEqual([car.start_date, car.target_date, car.target_firm], ['2024-03-01', '2027-06-30', 1]);
}));

test('goal categories have colours, rename with their goals, and restore from backups', () => withServer({}, async (call) => {
  const grp = (await call('POST', '/goal_groups', { kind: 'goal', name: 'Wishlist', color: '#ff0000' })).body;
  assert.equal((await call('POST', '/goal_groups', { kind: 'goal', name: 'wishlist' })).status, 400); // same name, any case
  assert.equal((await call('POST', '/goal_groups', { kind: 'debt', name: 'Wishlist' })).status, 201); // debts are separate
  const acct = (await call('POST', '/accounts', { name: 'Savings' })).body;
  const g = (await call('POST', '/goals', { kind: 'goal', name: 'TV', group_name: 'Wishlist', account_id: acct.id })).body;
  await call('POST', '/goals', { kind: 'debt', name: 'Loan', group_name: 'Wishlist' });

  await call('PATCH', `/goal_groups/${grp.id}`, { name: 'Wants' });
  let { body: d } = await call('GET', '/data');
  assert.equal(d.goals.find((x) => x.id === g.id).group_name, 'Wants');
  assert.equal(d.goals.find((x) => x.name === 'Loan').group_name, 'Wishlist'); // the debt category is untouched

  const { body: backup } = await call('GET', '/export');
  await call('DELETE', `/goal_groups/${grp.id}`);
  ({ body: d } = await call('GET', '/data'));
  assert.equal(d.goals.find((x) => x.id === g.id).group_name, null);

  const r = await call('POST', '/import', backup);
  assert.equal(r.status, 200);
  ({ body: d } = await call('GET', '/data'));
  assert.equal(d.goal_groups.find((x) => x.kind === 'goal').color, '#ff0000');
  const tv = d.goals.find((x) => x.name === 'TV');
  assert.equal(tv.group_name, 'Wants');
  assert.equal(tv.account_id, d.accounts[0].id);
}));

test('money can be added to and taken from a goal', () => withServer({}, async (call) => {
  const g = (await call('POST', '/goals', { kind: 'goal', name: 'Holiday', target_cents: 50000 })).body;
  let r = await call('POST', `/goals/${g.id}/adjust`, { amount_cents: 10000 });
  assert.equal(r.body.current_cents, 10000);
  r = await call('POST', `/goals/${g.id}/adjust`, { amount_cents: 10000 });
  assert.equal(r.body.current_cents, 20000);
  r = await call('POST', `/goals/${g.id}/adjust`, { amount_cents: -5000 });
  assert.equal(r.body.current_cents, 15000);
  r = await call('POST', `/goals/${g.id}/adjust`, { amount_cents: -20000 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /only \$150\.00/);
  assert.equal((await call('POST', `/goals/${g.id}/adjust`, { amount_cents: 0 })).status, 400);
  assert.equal((await call('POST', '/goals/999/adjust', { amount_cents: 100 })).status, 404);
}));

test('savings count towards deposits but not expenses, loans add repayments', (t) => { onDay(t, '2026-10-15'); return withServer({}, async (call) => {
  await call('PUT', '/settings', { pay_anchor_date: '2026-10-06', rounding: 'exact' });
  const acct = (await call('POST', '/accounts', { name: 'Savings' })).body;
  await call('POST', '/incomes', { name: 'Pay', after_tax_cents: 300000 });
  await call('POST', '/expenses', { name: 'Rent', amount_cents: 100000, frequency: 'fortnightly', day_offset: 0, account_id: acct.id });
  const s = (await call('POST', '/expenses', { name: 'Rainy day', kind: 'saving', amount_cents: 20000, frequency: 'fortnightly', day_offset: 0, account_id: acct.id, goal_cents: 100000 })).body;
  assert.equal(s.kind, 'saving');
  const loan = (await call('POST', '/loans', { name: 'Car', principal_cents: 2600000, interest_rate: 0, term_months: 12,
    repayment_frequency: 'fortnightly', start_date: '2026-01-06', account_id: acct.id })).body;
  let { body: d } = await call('GET', '/data');
  assert.equal(d.loans[0].calculated_repayment_cents, 100000); // $26,000 over 26 repayments, no interest
  assert.equal(d.loans[0].per_pay_cents, 100000);
  let { body: c } = await call('GET', '/cycle?offset=0');
  assert.equal(c.accounts[0].deposit_cents, 220000); // rent + saving + loan
  assert.equal(c.totals.savings_cents, 20000);
  assert.equal(c.totals.bills_cents, 200000); // rent + loan, not the saving
  assert.ok(c.bills.some((b) => b.kind === 'loan' && b.loan_id === loan.id));

  // Leaving the loan out of the budget removes its repayments.
  await call('PATCH', `/loans/${loan.id}`, { include_in_budget: false });
  ({ body: c } = await call('GET', '/cycle?offset=0'));
  assert.equal(c.accounts[0].deposit_cents, 120000);

  const { body: t } = await call('GET', '/trends?months=3');
  assert.equal(t.months.length, 3);
  assert.ok(t.months.every((m) => m.savings_cents > 0 && m.income_cents > 0));

  const { body: calc } = await call('GET', '/loan-calculator?amount_cents=1000000&rate=0&years=1&frequency=monthly&limit_percent=70');
  assert.equal(calc.repayment_cents, Math.round(1000000 / 12));
  assert.ok(calc.max_loan_cents > 0);

  // Weekly pay halves the per-pay amounts.
  await call('PUT', '/settings', { pay_frequency: 'weekly' });
  ({ body: d } = await call('GET', '/data'));
  assert.equal(d.settings.pay_frequency, 'weekly');
  assert.equal(d.expenses.find((e) => e.name === 'Rent').per_pay_cents, 50000);
  assert.equal((await call('PUT', '/settings', { pay_frequency: 'daily' })).status, 400);
  assert.equal((await call('PUT', '/settings', { pay_frequency: 'custom', pay_custom_days: 0 })).status, 400);

  // Backups carry loans and the pay frequency.
  const { body: backup } = await call('GET', '/export');
  assert.equal(backup.loans.length, 1);
  assert.equal(backup.settings.pay_frequency, 'weekly');
  await call('POST', '/import', backup);
  ({ body: d } = await call('GET', '/data'));
  assert.equal(d.loans[0].account_id, d.accounts[0].id);
}); });

test('monthly budget with fortnightly pay, yearly savings and budgeted loan repayments', (t) => { onDay(t, '2026-10-15'); return withServer({}, async (call) => {
  await call('PUT', '/settings', { pay_anchor_date: '2026-10-01', rounding: 'exact', pay_frequency: 'monthly' });
  const acct = (await call('POST', '/accounts', { name: 'Bills' })).body;
  const pay = (await call('POST', '/incomes', { name: 'Pay', after_tax_cents: 300000, frequency: 'fortnightly' })).body;
  assert.equal(pay.frequency, 'fortnightly');
  assert.equal((await call('POST', '/incomes', { name: 'Odd', after_tax_cents: 1, frequency: 'daily' })).status, 400);
  const s = (await call('POST', '/expenses', { name: 'Holiday', kind: 'saving', yearly_cents: 120000, amount_cents: 1, frequency: 'weekly', account_id: acct.id })).body;
  assert.equal(s.frequency, 'yearly');
  assert.equal(s.amount_cents, 120000);
  assert.equal(s.show_as_expense, 0);
  await call('POST', '/loans', { name: 'Car', repayment_frequency: 'monthly', repayment_cents: 140000, scheduled_date: '2026-10-15',
    budget_frequency: 'fortnightly', budget_cents: 70000, budget_date: '2026-10-02', account_id: acct.id });
  let { body: d } = await call('GET', '/data');
  assert.equal(d.expenses[0].per_pay_cents, 10000);
  assert.equal(d.loans[0].budgeted.per_month_cents, 151667);
  assert.equal(d.loans[0].per_pay_cents, 151667);
  let { body: c } = await call('GET', '/cycle?offset=0');
  assert.equal(c.totals.income_cents, 650000);
  assert.equal(c.totals.savings_cents, 10000);
  assert.equal(c.bills.filter((b) => b.kind === 'loan').length, 3); // 2, 16 and 30 Oct
  assert.equal(c.totals.bills_cents, 210000);
  await call('PATCH', `/expenses/${s.id}`, { show_as_expense: true });
  ({ body: c } = await call('GET', '/cycle?offset=0'));
  assert.equal(c.totals.bills_cents, 220000);
  // Temporary expenses stop after their end date.
  await call('POST', '/expenses', { name: 'Course', amount_cents: 5000, frequency: 'monthly', day_of_month: 5, end_date: '2026-10-31' });
  ({ body: c } = await call('GET', '/cycle?offset=1'));
  assert.ok(!c.bills.some((b) => b.name === 'Course'));
  // Backups keep it all.
  const { body: backup } = await call('GET', '/export');
  await call('POST', '/import', backup);
  ({ body: d } = await call('GET', '/data'));
  assert.equal(d.loans[0].budget_cents, 70000);
  assert.equal(d.expenses.find((e) => e.name === 'Holiday').yearly_cents, 120000);
  assert.equal(d.incomes[0].frequency, 'fortnightly');
}); });

test('no duplicate names, and payees keep their payment details', () => withServer({}, async (call) => {
  await call('POST', '/payees', { name: 'Telstra' });
  let r = await call('POST', '/payees', { name: ' telstra ' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already exists/);
  const p = (await call('POST', '/payees', { name: 'Landlord', pay_type: 'transfer', bsb: '062000', account_number: '1234 5678', account_name: 'J Smith' })).body;
  assert.equal(p.bsb, '062-000');
  assert.equal(p.account_number, '12345678');
  r = await call('PATCH', `/payees/${p.id}`, { name: 'TELSTRA' });
  assert.equal(r.status, 400);
  r = await call('PATCH', `/payees/${p.id}`, { name: 'Landlord' }); // its own name is fine
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/payees', { name: 'X', pay_type: 'cash' })).status, 400);
  const cat = (await call('GET', '/data')).body.categories[0];
  assert.equal((await call('POST', '/categories', { name: cat.name.toUpperCase() })).status, 400);
  assert.equal((await call('POST', '/subcategories', { category_id: cat.id, name: cat.subcategories[0].name })).status, 400);
  // Moving a sub category into a category that already has one by that name.
  const other = (await call('POST', '/categories', { name: 'Odds and ends' })).body;
  const stray = (await call('POST', '/subcategories', { category_id: other.id, name: cat.subcategories[0].name.toLowerCase() })).body;
  r = await call('PATCH', `/subcategories/${stray.id}`, { category_id: cat.id });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already exists/);
}));

test('editing just one date is checked against the saved one', () => withServer({}, async (call) => {
  const e = (await call('POST', '/expenses', { name: 'Course', amount_cents: 20000, frequency: 'monthly', start_date: '2026-03-01', end_date: '2026-12-31' })).body;
  let r = await call('PATCH', `/expenses/${e.id}`, { end_date: '2026-01-31' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'The end date should be after the start date.');
  r = await call('PATCH', `/expenses/${e.id}`, { start_date: '2027-01-01' });
  assert.equal(r.status, 400);
  r = await call('PATCH', `/expenses/${e.id}`, { end_date: '2026-06-30' });
  assert.equal(r.status, 200);
  const i = (await call('POST', '/incomes', { name: 'Contract', after_tax_cents: 100000, start_date: '2026-03-01' })).body;
  assert.equal((await call('PATCH', `/incomes/${i.id}`, { end_date: '2026-02-01' })).status, 400);
}));

test('payees keep a policy number and can be paid by direct debit; bills report what has been paid', () => withServer({}, async (call) => {
  const p = await call('POST', '/payees', { name: 'Insurer', pay_type: 'direct_debit', policy_number: 'POL-123', reference: 'DD9' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.policy_number, 'POL-123');
  assert.equal(p.body.pay_type, 'direct_debit');
  const e = await call('POST', '/expenses', { name: 'Cover', amount_cents: 5000, frequency: 'monthly', day_of_month: 1, payee_id: p.body.id });
  const d = await call('GET', `/expenses/${e.body.id}/details`);
  assert.equal(d.status, 200);
  assert.equal(d.body.paid_fytd.cents, d.body.paid_fytd.count * 5000);
  assert.ok(d.body.paid_ytd.from.endsWith('-01-01'));
  assert.equal((await call('GET', '/expenses/9999/details')).status, 404);
}));

test('extra logins: each has its own password and theme, and the password says who you are', () => withServer({}, async (call) => {
  let r = await call('POST', '/logins', { name: 'Sam', password: 'household-pw' });
  assert.equal(r.status, 400); // each login needs its own password
  assert.equal((await call('POST', '/logins', { name: 'Sam', password: 'sams-pw-1', colour: 'pink' })).status, 400);
  r = await call('POST', '/logins', { name: 'Sam', password: 'sams-pw-1', colour: '#FF8800' });
  assert.equal(r.status, 201);
  assert.equal(r.body.colour, '#ff8800');
  const sam = r.body;
  assert.equal((await call('PUT', '/me/theme', { theme: 'custom', custom_theme: { bg: '#000000', brand: '#ff00aa' } })).status, 200);
  assert.equal((await call('PUT', '/me/theme', { theme: 'custom', custom_theme: { bg: 'red' } })).status, 400);
  assert.equal((await call('PUT', '/me/theme', { theme: 'nope' })).status, 400);

  await call('POST', '/logout');
  assert.equal((await call('POST', '/login', { password: 'sams-pw-1' })).status, 200);
  r = await call('GET', '/me');
  assert.deepEqual(r.body, { id: sam.id, name: 'Sam', main: false, colour: '#ff8800', theme: 'system', custom_theme: null });
  assert.equal((await call('GET', '/data')).status, 200); // same household data
  await call('PUT', '/me/theme', { theme: 'warm' });
  r = await call('GET', '/logins');
  assert.deepEqual(r.body.map((l) => [l.name, l.you]), [['Main', false], ['Sam', true]]);
  assert.equal((await call('DELETE', `/logins/${sam.id}`)).status, 400); // not the one you're using
  assert.equal((await call('POST', '/password', { current: 'sams-pw-1', password: 'sams-pw-2' })).status, 200);

  await call('POST', '/logout');
  await call('POST', '/login', { password: 'household-pw' });
  r = await call('GET', '/me');
  assert.equal(r.body.theme, 'custom');
  assert.deepEqual(r.body.custom_theme, { bg: '#000000', brand: '#ff00aa' });
  assert.equal((await call('PATCH', '/logins/0', { name: 'Alex', colour: '#00aaff' })).status, 200);
  assert.equal((await call('GET', '/me')).body.colour, '#00aaff');
  assert.equal((await call('DELETE', '/logins/0')).status, 400);
  assert.equal((await call('DELETE', `/logins/${sam.id}`)).status, 200);
  await call('POST', '/logout');
  assert.equal((await call('POST', '/login', { password: 'sams-pw-2' })).status, 401);
}));

test('version: shown before login, tagged as test or beta when set', () => withServer({}, async (call) => {
  const { version } = require('../package.json');
  const before = process.env.APP_CHANNEL;
  try {
    delete process.env.APP_CHANNEL;
    let r = await call('GET', '/version');
    assert.equal(r.status, 200);
    assert.equal(r.body.version, version);
    assert.equal(r.body.channel, /-beta/i.test(version) ? 'beta' : '');
    process.env.APP_CHANNEL = 'Test';
    r = await call('GET', '/version');
    assert.equal(r.body.channel, 'test');
  } finally {
    if (before === undefined) delete process.env.APP_CHANNEL; else process.env.APP_CHANNEL = before;
  }
}));

test('two copies on one host keep their own logins', async () => {
  const jar = new Map(); // one browser: cookies are shared across ports on a host
  const start = async () => {
    const server = createApp({ db: openDatabase(':memory:') }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (method, path, body) => {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';'); const i = pair.indexOf('=');
        const v = pair.slice(i + 1);
        if (v) jar.set(pair.slice(0, i), v); else jar.delete(pair.slice(0, i));
      }
      return { status: res.status, body: await res.json() };
    };
    return { server, call };
  };
  const live = await start();
  const testCopy = await start();
  try {
    for (const { call } of [live, testCopy]) {
      await call('POST', '/login', { password: 'simplebudget' });
      await call('POST', '/password', { password: 'household-pw' });
    }
    assert.equal((await live.call('GET', '/me')).status, 200);
    assert.equal((await testCopy.call('GET', '/me')).status, 200);
  } finally { live.server.close(); testCopy.server.close(); }
});

test('updates: version order and picking the newest release from GitHub', async () => {
  const { compareVersions } = require('../src/updates');
  assert.ok(compareVersions('0.5.1', '0.5.0') > 0);
  assert.ok(compareVersions('v0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('0.6.0-beta.1', '0.6.0') < 0);
  assert.ok(compareVersions('0.6.0-beta.2', '0.6.0-beta.10') < 0);
  assert.ok(compareVersions('0.6.0-beta.1', '0.5.1') > 0);
  assert.equal(compareVersions('v0.5.1', '0.5.1'), 0);

  const { version } = require('../package.json');
  const releases = [
    { tag_name: 'v0.1.0', name: 'Old', body: '', html_url: 'u0', draft: false, prerelease: false },
    { tag_name: 'v99.0.0-beta.1', name: 'Beta', body: '', html_url: 'u2', draft: false, prerelease: true },
    { tag_name: 'v98.0.0', name: 'New', body: '- **Big** change', html_url: 'u1', published_at: '2026-10-20T00:00:00Z', draft: false, prerelease: false },
    { tag_name: 'v100.0.0', name: 'Draft', body: '', html_url: 'u3', draft: true, prerelease: false },
  ];
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => releases }; };
  await withServer({ fetchImpl }, async (call) => {
    let r = await call('GET', '/updates');
    assert.equal(r.status, 200);
    assert.equal(r.body.current, version);
    assert.equal(r.body.latest.version, '98.0.0'); // no drafts, and no betas on a release copy
    assert.equal(r.body.available, true);
    await call('GET', '/updates');
    assert.equal(calls, 1); // remembered between checks
    r = await call('POST', '/updates/check');
    assert.equal(calls, 2);
  });
  const token = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await withServer({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) }, async (call) => {
      const r = await call('GET', '/updates');
      assert.equal(r.body.available, false);
      assert.match(r.body.error, /GITHUB_TOKEN/); // says to add a token
    });
  } finally { if (token !== undefined) process.env.GITHUB_TOKEN = token; }
});

test('updates: "Update now" backs up the data and asks the updater to install it', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-update-'));
  const releases = [{ tag_name: 'v98.0.0', name: 'New', body: '', html_url: 'https://github.com/x/y', draft: false, prerelease: false }];
  const asked = [];
  let updaterStatus = 202;
  const fetchImpl = async (url, opts = {}) => {
    if (url.startsWith('http://updater')) {
      asked.push({ url, auth: opts.headers && opts.headers.Authorization, method: opts.method });
      return { ok: updaterStatus < 300, status: updaterStatus, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => releases };
  };
  const before = { url: process.env.UPDATER_URL, token: process.env.UPDATER_TOKEN };
  try {
    // Without an updater, the app says to use the terminal.
    delete process.env.UPDATER_URL;
    await withServer({ fetchImpl, dataDir }, async (call) => {
      assert.equal((await call('GET', '/updates')).body.can_install, false);
      assert.equal((await call('POST', '/updates/install')).status, 400);
    });
    process.env.UPDATER_URL = 'http://updater:8080';
    process.env.UPDATER_TOKEN = 'shh';
    await withServer({ fetchImpl, dataDir }, async (call) => {
      assert.equal((await call('GET', '/updates')).body.can_install, true);
      updaterStatus = 429;
      assert.equal((await call('POST', '/updates/install')).status, 409);
      updaterStatus = 202;
      const r = await call('POST', '/updates/install');
      assert.equal(r.status, 200);
      assert.equal(r.body.version, '98.0.0');
      assert.match(r.body.backup, /^budget-before-v98\.0\.0-.*\.db$/);
      assert.ok(fs.existsSync(path.join(dataDir, 'backups', r.body.backup)));
      assert.deepEqual(asked.at(-1), { url: 'http://updater:8080/v1/update?async=true', auth: 'Bearer shh', method: 'POST' });
      assert.equal((await call('GET', '/updates')).body.installing.version, '98.0.0');
      // Only the main login can install.
      await call('POST', '/logins', { name: 'Sam', password: 'sams-password' });
      await call('POST', '/logout');
      await call('POST', '/login', { password: 'sams-password' });
      assert.equal((await call('POST', '/updates/install')).status, 403);
    });
  } finally {
    if (before.url === undefined) delete process.env.UPDATER_URL; else process.env.UPDATER_URL = before.url;
    if (before.token === undefined) delete process.env.UPDATER_TOKEN; else process.env.UPDATER_TOKEN = before.token;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('updates: the releases offered follow IMAGE_TAG, so Update now can install them', async () => {
  const { createUpdates } = require('../src/updates');
  const releases = [
    { tag_name: 'v1.0.0', name: '1.0.0', html_url: 'https://github.com/x/y', draft: false, prerelease: false },
    { tag_name: 'v1.1.0-beta.1', name: 'beta', html_url: 'https://github.com/x/y', draft: false, prerelease: true },
  ];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => releases });
  const make = (imageTag, channel = 'test', url = 'http://updater:8080') => createUpdates({
    version: '0.9.0', fetchImpl, settings: () => ({ channel, repo: 'x/y', token: '' }), updater: () => ({ url, token: 't', imageTag }),
  });
  // A Test copy on the standard image is only offered what that image gets: full releases.
  let u = make('latest');
  await u.check();
  assert.deepEqual([u.view().track, u.view().latest.version, u.view().can_install], ['releases', '1.0.0', true]);
  // On the beta image it's offered the beta.
  u = make('beta', '');
  await u.check();
  assert.deepEqual([u.view().track, u.view().latest.version], ['beta', '1.1.0-beta.1']);
  // A fixed version can't be moved by Update now.
  u = make('0.9.0');
  await u.check();
  assert.equal(u.view().track, 'pinned');
  assert.equal(u.view().can_install, false);
  await assert.rejects(u.install(), /IMAGE_TAG/);
  // Without the updater (updated by hand), the build tag decides as before.
  u = make('latest', 'test', '');
  await u.check();
  assert.deepEqual([u.view().track, u.view().latest.version], ['beta', '1.1.0-beta.1']);
});

test('backups: listed, made by hand, and restored without touching logins', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-backups-'));
  try {
    await withServer({ dataDir }, async (call) => {
      let r = await call('GET', '/backups');
      assert.equal(r.body.available, true);
      assert.deepEqual(r.body.backups, []);
      await call('POST', '/payees', { name: 'Before' });
      await call('PUT', '/settings', { buffer_percent: 5 });
      r = await call('POST', '/backups');
      assert.match(r.body.created, /^budget-manual-.*\.db$/);
      assert.equal(r.body.backups[0].kind, 'manual');
      assert.ok(r.body.backups[0].size > 0);
      const manual = r.body.created;
      // Changes after the backup, including a new login, which a restore leaves alone.
      await call('POST', '/payees', { name: 'After' });
      await call('PUT', '/settings', { buffer_percent: 10 });
      await call('POST', '/logins', { name: 'Sam', password: 'sams-password' });
      assert.equal((await call('POST', '/backups/restore', { name: '../budget.db' })).status, 404);
      r = await call('POST', '/backups/restore', { name: manual });
      assert.equal(r.status, 200);
      assert.match(r.body.backup, /^budget-before-restore-/); // what was there is saved first
      const data = (await call('GET', '/data')).body;
      assert.deepEqual(data.payees.map((p) => p.name), ['Before']);
      assert.equal(data.settings.buffer_percent, 5);
      assert.equal((await call('GET', '/me')).status, 200); // still logged in
      assert.ok((await call('GET', '/logins')).body.some((l) => l.name === 'Sam'));
      // Automatic backups keep the newest five; manual ones stay.
      for (let i = 0; i < 6; i += 1) await call('POST', '/backups/restore', { name: manual });
      r = await call('GET', '/backups');
      assert.equal(r.body.backups.filter((b) => b.kind === 'restore').length, 5);
      assert.ok(r.body.backups.some((b) => b.name === manual));
      // Restoring the oldest one kept doesn't tidy that one away.
      const oldest = r.body.backups.filter((b) => b.kind === 'restore').at(-1).name;
      assert.equal((await call('POST', '/backups/restore', { name: oldest })).status, 200);
      assert.ok((await call('GET', '/backups')).body.backups.some((b) => b.name === oldest));
      // Only the main login can restore.
      await call('POST', '/logout');
      await call('POST', '/login', { password: 'sams-password' });
      assert.equal((await call('POST', '/backups/restore', { name: manual })).status, 403);
    });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('updates: preferences, versions behind, and the welcome after an update', async () => {
  const releases = [
    { tag_name: 'v99.1.0', name: '99.1', body: 'New: two', html_url: 'https://github.com/x/y', draft: false, prerelease: false },
    { tag_name: 'v99.2.0-beta.1', name: 'b', body: '', html_url: 'https://github.com/x/y', draft: false, prerelease: true },
    { tag_name: 'v99.0.0', name: '99.0', body: 'Fixed: one', html_url: 'https://github.com/x/y', draft: false, prerelease: false },
  ];
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => releases }; };
  const url = process.env.UPDATER_URL;
  delete process.env.UPDATER_URL;
  try {
    await withServer({ fetchImpl }, async (call) => {
      let r = await call('GET', '/updates');
      assert.equal(r.body.behind, 2);
      assert.deepEqual(r.body.releases.map((x) => x.version), ['99.1.0', '99.0.0']);
      assert.equal(r.body.beta, false);
      assert.ok(r.body.installed_at);
      assert.equal(r.body.just_updated, null); // a fresh install isn't an update
      r = await call('PUT', '/updates/prefs', { beta: true });
      assert.equal(r.body.latest.version, '99.2.0-beta.1');
      assert.equal(r.body.behind, 3);
      r = await call('PUT', '/updates/prefs', { auto_check: false });
      assert.equal(r.body.auto_check, false);
      assert.equal((await call('PUT', '/updates/prefs', { beta: 'yes' })).status, 400);
    });
    // With the updater, IMAGE_TAG decides and the switch is locked.
    process.env.UPDATER_URL = 'http://updater:8080';
    await withServer({ fetchImpl }, async (call) => {
      assert.equal((await call('GET', '/updates')).body.beta_locked, true);
      assert.equal((await call('PUT', '/updates/prefs', { beta: true })).status, 400);
    });
  } finally { if (url === undefined) delete process.env.UPDATER_URL; else process.env.UPDATER_URL = url; }
  // The first start on a newer version welcomes it, until dismissed.
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO settings (key, value) VALUES ('installed_version', '0.0.1')").run();
  await withServer({ fetchImpl, db }, async (call) => {
    let r = await call('GET', '/updates');
    assert.equal(r.body.just_updated.from, '0.0.1');
    r = await call('POST', '/updates/dismiss');
    assert.equal(r.body.just_updated, null);
  });
});

test('a release image reports its own version (APP_VERSION), e.g. a beta built from a branch', () => {
  const { execFileSync } = require('node:child_process');
  const ask = (v) => execFileSync(process.execPath, ['-e', `
    const { createApp } = require('./src/server'); const { openDatabase } = require('./src/db');
    const s = createApp({ db: openDatabase(':memory:') }).listen(0, async () => {
      const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/version'); console.log(JSON.stringify(await r.json())); s.close();
    });`], { env: { ...process.env, APP_VERSION: v, APP_CHANNEL: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.deepEqual(JSON.parse(ask('v99.1.0-beta.2')), { version: '99.1.0-beta.2', channel: 'beta' });
  assert.equal(JSON.parse(ask('not a version')).version, require('../package.json').version);
});

test('updates: a release whose image is still being built is shown, but not installed yet', async () => {
  const { createUpdates } = require('../src/updates');
  let built = false;
  const asked = [];
  const fetchImpl = async (url, opts = {}) => {
    asked.push(url);
    if (url.startsWith('https://ghcr.io/token')) return { ok: true, status: 200, json: async () => ({ token: 'anon' }) };
    if (url.startsWith('https://ghcr.io/v2/')) return { ok: built, status: built ? 200 : 404 };
    if (url.startsWith('http://updater')) return { ok: true, status: 202 };
    return { ok: true, status: 200, json: async () => [{ tag_name: 'v1.0.0', name: '1', html_url: 'https://github.com/x/y', draft: false, prerelease: false }] };
  };
  const u = createUpdates({ version: '0.9.0', fetchImpl, settings: () => ({ channel: '', repo: 'Owner/Repo', token: '' }), updater: () => ({ url: 'http://updater:8080', token: 't', imageTag: 'latest' }) });
  await u.check();
  assert.equal(u.view().building, true);
  assert.ok(asked.includes('https://ghcr.io/v2/owner/repo/manifests/1.0.0'));
  await assert.rejects(u.install(), /still being built/);
  built = true;
  const r = await u.install();
  assert.equal(r.version, '1.0.0');
  assert.equal(u.view().building, false);
});

test('updates: wait a day, how often to check, and how many backups to keep', async () => {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const releases = [
    { tag_name: 'v99.2.0', name: 'new', body: '', html_url: 'https://github.com/x/y', draft: false, prerelease: false, published_at: hoursAgo(2) },
    { tag_name: 'v99.1.0', name: 'older', body: '', html_url: 'https://github.com/x/y', draft: false, prerelease: false, published_at: hoursAgo(48) },
  ];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => releases });
  const url = process.env.UPDATER_URL;
  delete process.env.UPDATER_URL;
  try {
    await withServer({ fetchImpl }, async (call) => {
      let r = await call('GET', '/updates');
      assert.deepEqual([r.body.latest.version, r.body.behind, r.body.waiting, r.body.interval_hours, r.body.wait_day], ['99.2.0', 2, null, 6, false]);
      r = await call('PUT', '/updates/prefs', { wait_day: true, interval_hours: 12 });
      // The two-hour-old release waits; the older one is offered meanwhile.
      assert.deepEqual([r.body.latest.version, r.body.behind, r.body.waiting.version, r.body.interval_hours], ['99.1.0', 1, '99.2.0', 12]);
      assert.equal(Date.parse(r.body.waiting.offer_at), Date.parse(releases[0].published_at) + 24 * 3600e3);
      assert.equal((await call('PUT', '/updates/prefs', { interval_hours: 5 })).status, 400);
      assert.equal((await call('PUT', '/updates/prefs', { backups_keep: 7 })).status, 400);
      assert.equal((await call('PUT', '/updates/prefs', { backups_keep: 10 })).status, 200);
    });
  } finally { if (url === undefined) delete process.env.UPDATER_URL; else process.env.UPDATER_URL = url; }
  // Automatic backups past the chosen number are removed; manual ones stay.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-keep-'));
  try {
    await withServer({ dataDir }, async (call) => {
      await call('PUT', '/updates/prefs', { backups_keep: 10 });
      const manual = (await call('POST', '/backups')).body.created;
      for (let i = 0; i < 12; i += 1) await call('POST', '/backups/restore', { name: manual });
      const r = await call('GET', '/backups');
      assert.equal(r.body.keep, 10);
      assert.equal(r.body.backups.filter((b) => b.kind === 'restore').length, 10);
      assert.ok(r.body.backups.some((b) => b.name === manual));
    });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('goals belong to whoever added them, can be shared, and become shared when a login goes', () => withServer({}, async (call) => {
  const sam = (await call('POST', '/logins', { name: 'Sam', password: 'sams-pw-1' })).body;
  const mine = (await call('POST', '/goals', { kind: 'goal', name: 'Bike' })).body;
  assert.equal(mine.owner_id, 0); // the main login added it
  const shared = (await call('POST', '/goals', { kind: 'goal', name: 'Holiday', owner_id: null })).body;
  assert.equal(shared.owner_id, null);
  await call('POST', '/logout');
  await call('POST', '/login', { password: 'sams-pw-1' });
  const sams = (await call('POST', '/goals', { kind: 'debt', name: 'Phone' })).body;
  assert.equal(sams.owner_id, sam.id);
  assert.equal((await call('PATCH', `/goals/${mine.id}`, { name: 'Road bike' })).body.owner_id, 0); // editing keeps the owner
  await call('POST', '/logout');
  await call('POST', '/login', { password: 'household-pw' });
  assert.equal((await call('DELETE', `/logins/${sam.id}`)).status, 200);
  assert.equal((await call('GET', '/goals')).body.find((g) => g.id === sams.id).owner_id, null);
}));

test('expense amounts and loan figures are logged as they change', () => withServer({}, async (call) => {
  const e = (await call('POST', '/expenses', { name: 'Health insurance', amount_cents: 20000, frequency: 'monthly' })).body;
  await call('PATCH', `/expenses/${e.id}`, { name: 'Health cover' }); // not an amount change
  await call('PATCH', `/expenses/${e.id}`, { amount_cents: 25000 });
  await call('PATCH', `/expenses/${e.id}`, { amount_cents: 24000 }); // same day: replaces the 250
  let h = (await call('GET', `/history/expense/${e.id}`)).body;
  assert.deepEqual(h.map((r) => r.value), [20000, 24000]);
  assert.equal((await call('GET', `/expenses/${e.id}/details`)).body.history.length, 2);
  const due = (await call('PATCH', `/expenses/${e.id}`, { review_date: '2026-01-01', review_snooze: '2026-01-08' })).body;
  assert.equal(due.review_date, '2026-01-01');
  assert.equal((await call('PATCH', `/expenses/${e.id}`, { review_date: 'soon' })).status, 400);

  const l = (await call('POST', '/loans', { name: 'Car', repayment_cents: 50000, repayment_frequency: 'monthly', balance_cents: 1000000, balance_date: '2026-01-31', interest_rate: 6.5 })).body;
  await call('PATCH', `/loans/${l.id}`, { balance_cents: 950000, balance_date: '2026-03-31', interest_rate: 6.25 });
  h = (await call('GET', `/history/loan/${l.id}`)).body;
  assert.deepEqual(h.filter((r) => r.field === 'balance_cents').map((r) => [r.on_date, r.value]), [['2026-01-31', 1000000], ['2026-03-31', 950000]]);
  assert.deepEqual(h.filter((r) => r.field === 'interest_rate').map((r) => r.value), [6.5, 6.25]);
  await call('DELETE', `/expenses/${e.id}`);
  assert.deepEqual((await call('GET', `/history/expense/${e.id}`)).body, []);
}));

test('a new price can start today, be backdated or wait for a future date', () => withServer({}, async (call) => {
  const e = (await call('POST', '/expenses', { name: 'Home insurance', amount_cents: 150000, frequency: 'yearly', review_date: '2026-01-01' })).body;
  let r = await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 160000, from: '2025-07-01', review_date: '2099-07-01' });
  assert.equal(r.body.amount_cents, 160000);
  assert.equal(r.body.review_date, '2099-07-01');
  let h = (await call('GET', `/history/expense/${e.id}`)).body;
  assert.deepEqual(h.map((x) => [x.on_date, x.value]).at(-1), ['2025-07-01', 160000]);
  r = await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 175000, from: '2099-01-01' });
  assert.equal(r.body.amount_cents, 160000); // not yet
  assert.deepEqual([r.body.pending_cents, r.body.pending_from], [175000, '2099-01-01']);
  // A price dated today or earlier changes it now and keeps the future price.
  r = await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 165000, from: '2026-01-01' });
  assert.equal(r.body.amount_cents, 165000);
  assert.deepEqual([r.body.pending_cents, r.body.pending_from], [175000, '2099-01-01']);
  r = await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 166000 });
  assert.deepEqual([r.body.amount_cents, r.body.pending_cents], [166000, 175000]);
  // Only another future price replaces it.
  r = await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 180000, from: '2098-06-01' });
  assert.deepEqual([r.body.amount_cents, r.body.pending_cents, r.body.pending_from], [166000, 180000, '2098-06-01']);
  // $0 is a price like any other (the edit form allows it too); a missing one isn't.
  r = await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 0 });
  assert.deepEqual([r.status, r.body.amount_cents], [200, 0]);
  assert.equal((await call('POST', `/expenses/${e.id}/amount`, {})).body.error, 'Enter the new amount.');
  assert.equal((await call('POST', `/expenses/${e.id}/amount`, { amount_cents: -5 })).body.error, "Amount can't be negative.");
  assert.equal((await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 5, from: 'soon' })).body.error.startsWith('Date must be a date'), true);
}));

test('back-dated prices slot into the history, and a mistake can be removed', () => withServer({}, async (call) => {
  const e = (await call('POST', '/expenses', { name: 'Phone', amount_cents: 5000, frequency: 'monthly' })).body;
  await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 4500, from: '2025-01-01' }); // starting amount becomes "before then"
  await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 5500 }); // today
  let r = await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 4800, from: '2025-06-01' });
  assert.equal(r.body.amount_cents, 5500); // a newer price is still the current one
  let h = (await call('GET', `/history/expense/${e.id}`)).body;
  assert.deepEqual(h.map((x) => [x.on_date, x.value]).slice(0, 3), [['2024-12-31', 5000], ['2025-01-01', 4500], ['2025-06-01', 4800]]);
  assert.equal(h.at(-1).value, 5500);
  // Removing the newest puts the bill back to the one before.
  const del = await call('DELETE', `/history/expense/${e.id}/${h.at(-1).id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.length, 3);
  assert.equal((await call('GET', `/expenses/${e.id}/details`)).body.amount_cents, 4800);
  // Removing an older one leaves the current amount alone.
  await call('DELETE', `/history/expense/${e.id}/${h[1].id}`);
  assert.equal((await call('GET', `/expenses/${e.id}/details`)).body.amount_cents, 4800);
  h = (await call('GET', `/history/expense/${e.id}`)).body;
  await call('DELETE', `/history/expense/${e.id}/${h[0].id}`);
  h = (await call('GET', `/history/expense/${e.id}`)).body;
  assert.equal(h.length, 1);
  assert.equal((await call('DELETE', `/history/expense/${e.id}/${h[0].id}`)).status, 400); // the only one left
  assert.equal((await call('DELETE', `/history/loan/${e.id}/${h[0].id}`)).status, 404);
}));

test('a loan balance update keeps the estimate it replaced, and a past loan can be estimated', () => withServer({}, async (call) => {
  const loan = { name: 'Car', principal_cents: 3000000, interest_rate: 7, start_date: '2024-01-01', term_months: 60, repayment_frequency: 'monthly' };
  const est = (await call('POST', '/loans/estimate-balance', loan)).body;
  assert.ok(est.balance_cents > 0 && est.balance_cents < 3000000);
  assert.equal(est.repayment_cents, 59404); // $30,000 at 7% over 60 months
  const l = (await call('POST', '/loans', loan)).body;
  const r = await call('POST', `/loans/${l.id}/balance`, { balance_cents: 2000000, balance_date: '2025-06-30', interest_rate: 6.5 });
  assert.equal(r.status, 200);
  const h = (await call('GET', `/history/loan/${l.id}`)).body;
  const bal = h.find((x) => x.field === 'balance_cents');
  assert.equal(bal.on_date, '2025-06-30');
  assert.ok(bal.before_value > 2000000); // the estimate from the start date
  assert.deepEqual(h.filter((x) => x.field === 'interest_rate').map((x) => [x.on_date, x.value]).at(-1), ['2025-06-30', 6.5]);
  assert.equal((await call('POST', `/loans/${l.id}/balance`, { balance_cents: 1, balance_date: '2999-01-01' })).status, 400);
}));

test('a future price needs both its amount and its date, and a bad one never breaks the app', (t) => {
  onDay(t, '2026-10-15');
  return withServer({}, async (call) => {
    const e = (await call('POST', '/expenses', { name: 'Insurance', amount_cents: 10000, frequency: 'monthly' })).body;
    assert.equal((await call('PATCH', `/expenses/${e.id}`, { pending_from: '2026-01-01' })).status, 400);
    assert.equal((await call('PATCH', `/expenses/${e.id}`, { pending_cents: 12000 })).status, 400);
    assert.equal((await call('POST', '/expenses', { name: 'Odd', amount_cents: 1, frequency: 'monthly', pending_from: '2026-11-01' })).status, 400);
    // A future price takes over on its day.
    assert.equal((await call('PATCH', `/expenses/${e.id}`, { pending_cents: 12000, pending_from: '2026-10-20' })).status, 200);
    assert.equal((await call('GET', '/data')).body.expenses[0].amount_cents, 10000);
    t.mock.timers.setTime(Date.parse('2026-10-21T12:00:00'));
    const now = (await call('GET', '/data')).body.expenses[0];
    assert.deepEqual([now.amount_cents, now.pending_cents, now.pending_from], [12000, null, null]);
    const h = (await call('GET', `/history/expense/${e.id}`)).body;
    assert.deepEqual(h.map((x) => [x.on_date, x.value]).at(-1), ['2026-10-20', 12000]);
    // A backup with half a future price restores the bill without it, and the app keeps working.
    const { body: backup } = await call('GET', '/export');
    backup.expenses[0].pending_from = '2026-01-01';
    const r = await call('POST', '/import', backup);
    assert.equal(r.status, 200);
    assert.match(r.body.warnings.join(' '), /future price of expense "Insurance"/);
    assert.equal((await call('GET', '/data')).status, 200);
    assert.equal((await call('GET', '/cycle?offset=0')).status, 200);
  });
});

test('removing the newest history entry puts back the amount and how often it was paid', () => withServer({}, async (call) => {
  const e = (await call('POST', '/expenses', { name: 'Rates', amount_cents: 10000, frequency: 'monthly', day_of_month: 1 })).body;
  await call('PATCH', `/expenses/${e.id}`, { amount_cents: 30000, frequency: 'quarterly' });
  let h = (await call('GET', `/history/expense/${e.id}`)).body;
  await call('DELETE', `/history/expense/${e.id}/${h.at(-1).id}`);
  let row = (await call('GET', '/data')).body.expenses[0];
  assert.deepEqual([row.amount_cents, row.frequency], [10000, 'monthly']);

  const l = (await call('POST', '/loans', { name: 'Car', principal_cents: 3000000, interest_rate: 6, term_months: 60,
    repayment_frequency: 'monthly', repayment_cents: 140000, start_date: '2025-01-01' })).body;
  await call('PATCH', `/loans/${l.id}`, { repayment_cents: 65000, repayment_frequency: 'fortnightly' });
  h = (await call('GET', `/history/loan/${l.id}`)).body.filter((x) => x.field === 'repayment_cents');
  await call('DELETE', `/history/loan/${l.id}/${h.at(-1).id}`);
  row = (await call('GET', '/data')).body.loans[0];
  assert.deepEqual([row.repayment_cents, row.repayment_frequency], [140000, 'monthly']);
}));

test("restoring a backup keeps each bill's own history and never picks up another's", () => withServer({}, async (call) => {
  const ins = (await call('POST', '/expenses', { name: 'Insurance', amount_cents: 150000, frequency: 'yearly' })).body;
  await call('POST', `/expenses/${ins.id}/amount`, { amount_cents: 140000, from: '2025-01-01' });
  await call('PATCH', `/expenses/${ins.id}`, { amount_cents: 160000 });
  await call('POST', '/expenses', { name: 'Phone', amount_cents: 5000, frequency: 'monthly' });
  await call('POST', '/loans', { name: 'Car', principal_cents: 2000000, interest_rate: 5, term_months: 60, repayment_cents: 40000, start_date: '2025-01-01' });
  const { body: backup } = await call('GET', '/export');
  const insHistory = (await call('GET', `/history/expense/${ins.id}`)).body.map((x) => [x.on_date, x.value]);
  assert.ok(insHistory.length >= 3);

  // Restoring a different file: its bills reuse the old ids but start with only their own amounts.
  let r = await call('POST', '/import', { app: 'simple-budget', format_version: 1,
    expenses: [{ id: 7, name: 'Netflix', amount_cents: 2299, frequency: 'monthly' }, { id: 8, name: 'Water', amount_cents: 9000, frequency: 'quarterly' }] });
  assert.equal(r.status, 200);
  let d = (await call('GET', '/data')).body;
  for (const e of d.expenses) {
    const h = (await call('GET', `/history/expense/${e.id}`)).body;
    assert.deepEqual(h.map((x) => x.value), [e.amount_cents]);
  }
  // Loans weren't in that file, so their history stays.
  assert.ok((await call('GET', `/history/loan/${d.loans[0].id}`)).body.length > 0);

  // Restoring the real backup brings each bill's history back with it.
  r = await call('POST', '/import', backup);
  assert.deepEqual(r.body.warnings, []);
  d = (await call('GET', '/data')).body;
  const back = d.expenses.find((e) => e.name === 'Insurance');
  assert.deepEqual((await call('GET', `/history/expense/${back.id}`)).body.map((x) => [x.on_date, x.value]), insHistory);
  const phone = d.expenses.find((e) => e.name === 'Phone');
  assert.deepEqual((await call('GET', `/history/expense/${phone.id}`)).body.map((x) => x.value), [5000]);
}));

test('history in a backup file is checked before it is restored', () => withServer({}, async (call) => {
  const r = await call('POST', '/import', { app: 'simple-budget', format_version: 2,
    expenses: [{ id: 1, name: 'Gym', amount_cents: 6000, frequency: 'monthly' }],
    amount_history: [
      { kind: 'expense', item_id: 1, field: 'amount_cents', on_date: '2025-01-01', value: 5000, frequency: 'monthly' },
      { kind: 'expense', item_id: 1, field: 'amount_cents', on_date: '2025-06-01', value: 5500, frequency: 'sometimes' },
      { kind: 'expense', item_id: 1, field: 'amount_cents', on_date: '2025-07-01', value: 1.5, frequency: 'monthly' },
      { kind: 'expense', item_id: 9, field: 'amount_cents', on_date: '2025-07-01', value: 100, frequency: 'monthly' },
      { kind: 'goal', item_id: 1, field: 'amount_cents', on_date: '2025-07-01', value: 100 },
    ] });
  assert.equal(r.status, 200);
  assert.match(r.body.warnings.join(' '), /Left out 4 history entries/);
  const id = (await call('GET', '/data')).body.expenses[0].id;
  assert.deepEqual((await call('GET', `/history/expense/${id}`)).body.map((x) => [x.on_date, x.value]), [['2025-01-01', 5000]]);
}));

test('a password reset only holds the main login, and shows the password in the terminal, not the page', async () => {
  const db = openDatabase(':memory:');
  await withServer({ db }, async (call) => {
    await call('POST', '/logins', { name: 'Sam', password: 'sams-password' });
    await call('POST', '/logout');
    assert.equal(resetPassword(db).password, 'simplebudget');
    let r = await call('GET', '/session');
    assert.deepEqual(r.body, { loggedIn: false, mustChangePassword: false }); // no hint after a reset
    // Other logins carry on as normal.
    assert.equal((await call('POST', '/login', { password: 'sams-password' })).body.mustChangePassword, false);
    assert.equal((await call('GET', '/data')).status, 200);
    assert.equal((await call('GET', '/session')).body.mustChangePassword, false);
    await call('POST', '/logout');
    // The main login chooses a new password first.
    assert.equal((await call('POST', '/login', { password: 'simplebudget' })).body.mustChangePassword, true);
    assert.equal((await call('GET', '/data')).status, 403);
    assert.equal((await call('POST', '/password', { password: 'brand-new-pw' })).status, 200);
    assert.equal((await call('GET', '/data')).status, 200);
  });
});

test('START_PASSWORD in .env is the starting password, with nothing shown on the login page', async () => {
  const db = openDatabase(':memory:');
  const env = { START_PASSWORD: 'our-start-pw' };
  resetPassword(db, { fresh: true, env });
  await withServer({ db, raw: true }, async (call) => {
    assert.deepEqual((await call('GET', '/session')).body, { loggedIn: false, mustChangePassword: false });
    assert.equal((await call('POST', '/login', { password: 'simplebudget' })).status, 401);
    assert.equal((await call('POST', '/login', { password: 'our-start-pw' })).body.mustChangePassword, false);
    assert.equal((await call('GET', '/data')).status, 200);
  });
  // Too short to use: the default instead.
  assert.equal(resetPassword(db, { env: { START_PASSWORD: 'short' } }).password, 'simplebudget');
});

test("any login can manage the others, but only Main sets Main's password", () => withServer({}, async (call) => {
  const sam = (await call('POST', '/logins', { name: 'Sam', password: 'sams-password' })).body;
  await call('POST', '/logout');
  await call('POST', '/login', { password: 'sams-password' });
  assert.equal((await call('PATCH', '/logins/0', { password: 'taken-over-pw' })).status, 403);
  assert.equal((await call('PATCH', '/logins/0', { name: 'Kim' })).status, 200);
  assert.equal((await call('DELETE', '/logins/0')).status, 400);
  const alex = (await call('POST', '/logins', { name: 'Alex', password: 'alexs-password' })).body;
  assert.equal((await call('PATCH', `/logins/${alex.id}`, { password: 'alexs-new-pw' })).status, 200);
  assert.equal((await call('POST', '/import', { app: 'simple-budget', format_version: 2, payees: [] })).status, 403);
  await call('POST', '/logout');
  assert.equal((await call('POST', '/login', { password: 'household-pw' })).status, 200);
  assert.equal((await call('PATCH', `/logins/${sam.id}`, { password: 'sams-new-pw' })).status, 200);
  assert.equal((await call('POST', '/logins', { name: 'Jo', password: 'short' })).status, 400); // 8 characters at least
}));

test('guesses sent all at once are counted before they are checked', () => withServer({ raw: true }, async (call) => {
  const results = await Promise.all(Array.from({ length: 20 }, () => call('POST', '/login', { password: 'wrong-guess' })));
  const wrong = results.filter((r) => r.status === 401).length;
  assert.ok(wrong <= 5, `${wrong} guesses were checked`);
  assert.equal(results.filter((r) => r.status === 429).length, 20 - wrong);
  assert.equal((await call('POST', '/login', { password: 'simplebudget' })).status, 200);
}));

test('the current password can only be guessed a few times', () => withServer({}, async (call) => {
  const tries = [];
  for (let i = 0; i < 6; i += 1) tries.push((await call('POST', '/password', { current: `wrong-${i}`, password: 'another-pw' })).status);
  assert.deepEqual(tries, [400, 400, 400, 400, 400, 429]);
}));

test('changes from other sites are refused, logins must be JSON, and API answers are not cached', () => withServer({}, async (call) => {
  assert.equal((await call('POST', '/payees', { name: 'Evil' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('POST', '/payees', { name: 'Evil' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('POST', '/payees', { name: 'Sibling' }, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await call('POST', '/payees', { name: 'Ours' }, { 'sec-fetch-site': 'same-origin' })).status, 201);
  assert.equal((await call('POST', '/login', { password: 'x' }, { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await call('GET', '/data')).headers.get('cache-control'), 'no-store');
}));

test('restoring part of a backup keeps the other rows linked by name', () => withServer({}, async (call) => {
  const cats = (await call('GET', '/categories')).body;
  const acct = (await call('POST', '/accounts', { name: 'Bills' })).body;
  await call('POST', '/expenses', { name: 'Phone', amount_cents: 5000, frequency: 'monthly', category_id: cats[0].id, account_id: acct.id });
  await call('POST', '/expenses', { name: 'Gym', amount_cents: 3000, frequency: 'monthly', category_id: cats[1].id });
  const r = await call('POST', '/import', { app: 'simple-budget', format_version: 2,
    categories: [{ id: 50, name: cats[0].name.toUpperCase(), subcategories: [] }] });
  assert.equal(r.status, 200);
  const d = (await call('GET', '/data')).body;
  const phone = d.expenses.find((e) => e.name === 'Phone');
  assert.equal(d.categories.find((c) => c.id === phone.category_id).name, cats[0].name.toUpperCase());
  assert.equal(phone.account_id, acct.id); // accounts weren't in the file, so untouched
  assert.equal(d.expenses.find((e) => e.name === 'Gym').category_id, null);
  assert.match(r.body.warnings.join(' '), new RegExp(`"Gym" is no longer linked to the category "${cats[1].name}"`));
}));

test('backups: a file restore saves what was there first, and manual backups are capped and can be deleted', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-backups-'));
  try {
    await withServer({ dataDir }, async (call) => {
      await call('POST', '/payees', { name: 'Before' });
      const r = await call('POST', '/import', { app: 'simple-budget', format_version: 2, payees: [{ id: 1, name: 'After' }] });
      assert.match(r.body.backup, /^budget-before-restore-/);
      let made;
      for (let i = 0; i < 20; i += 1) made = (await call('POST', '/backups')).body.created;
      assert.equal((await call('POST', '/backups')).status, 409);
      const left = (await call('DELETE', `/backups/${made}`)).body.backups;
      assert.ok(!left.some((b) => b.name === made));
      assert.equal((await call('POST', '/backups')).status, 200);
      assert.equal((await call('DELETE', '/backups/..%2Fbudget.db')).status, 404);
    });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('paid this year counts each payment at the price it was then', (t) => { onDay(t, '2026-10-15'); return withServer({}, async (call) => {
  const e = (await call('POST', '/expenses', { name: 'Gym', amount_cents: 10000, frequency: 'monthly', day_of_month: 1 })).body;
  await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 10000, from: '2026-01-01' });
  await call('POST', `/expenses/${e.id}/amount`, { amount_cents: 12000, from: '2026-09-01' });
  const d = (await call('GET', `/expenses/${e.id}/details`)).body;
  assert.deepEqual([d.paid_fytd.count, d.paid_fytd.cents], [4, 44000]); // Jul, Aug at $100; Sep, Oct at $120
}); });

test('every page gets the Overview deposit, leaving out a loan whose term has ended', (t) => { onDay(t, '2026-10-15'); return withServer({}, async (call) => {
  await call('PUT', '/settings', { pay_anchor_date: '2026-10-06', rounding: 'exact' });
  const acct = (await call('POST', '/accounts', { name: 'Bills' })).body;
  await call('POST', '/expenses', { name: 'Rent', amount_cents: 100000, frequency: 'fortnightly', account_id: acct.id });
  await call('POST', '/expenses', { name: 'Course', amount_cents: 5000, frequency: 'fortnightly', account_id: acct.id, start_date: '2026-10-16' });
  await call('POST', '/incomes', { name: 'Pay', after_tax_cents: 300000, frequency: 'weekly' });
  // A three-year car loan that ended in 2025 but was never ticked Paid off.
  await call('POST', '/loans', { name: 'Car', principal_cents: 3000000, interest_rate: 7, start_date: '2022-06-01', term_months: 36, repayment_frequency: 'monthly', account_id: acct.id });
  const d = (await call('GET', '/data')).body;
  const c = (await call('GET', '/cycle')).body;
  assert.equal(d.deposits[acct.id], c.accounts.find((a) => a.account_id === acct.id).deposit_cents);
  assert.equal(d.deposits[acct.id], 105000); // rent, plus the course that starts part way through this cycle
  assert.deepEqual([d.loans[0].in_deposit, d.loans[0].per_pay_cents], [false, 0]);
  assert.equal(d.expenses.find((e) => e.name === 'Course').in_deposit, true);
  assert.equal(d.incomes[0].per_cycle_cents, 600000);
}); });

test('paying extra on a loan is worked out on the server, from the same estimate', (t) => { onDay(t, '2026-10-15'); return withServer({}, async (call) => {
  const l = (await call('POST', '/loans', { name: 'Home', principal_cents: 50000000, interest_rate: 6, start_date: '2024-01-15', term_months: 360, repayment_frequency: 'monthly' })).body;
  const d = (await call('GET', `/loans/${l.id}/details`)).body;
  assert.ok(d.rate_rise_cents > 0);
  const none = (await call('GET', `/loans/${l.id}/extra?cents=0`)).body;
  assert.equal(none.payoff_date, d.estimated_payoff_date);
  const some = (await call('GET', `/loans/${l.id}/extra?cents=2500`)).body;
  assert.equal(some.base.payoff_date, d.estimated_payoff_date);
  assert.ok(some.payoff_date <= d.estimated_payoff_date); // even $25 never makes it later
  assert.ok(some.interest_cents < some.base.interest_cents);
  assert.match(some.points[0][0], /^\d{4}-\d{2}$/);
  assert.equal((await call('GET', `/loans/${l.id}/extra?cents=-5`)).status, 400);
}); });

test('loan dates and list sizes are kept within reason', (t) => { onDay(t, '2026-10-15'); return withServer({}, async (call) => {
  let r = await call('POST', '/loans', { name: 'Ancient', principal_cents: 100000, start_date: '1900-01-01', term_months: 600 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "Start date can't be more than 60 years ago.");
  const l = (await call('POST', '/loans', { name: 'Car', principal_cents: 100000, start_date: '1967-01-01', term_months: 12 })).body;
  assert.equal((await call('PATCH', `/loans/${l.id}`, { balance_cents: 5, balance_date: '1950-01-01' })).status, 400);
  assert.equal((await call('POST', `/loans/${l.id}/balance`, { balance_cents: 5, balance_date: '1950-01-01' })).status, 400);
  assert.equal((await call('POST', '/loans/estimate-balance', { principal_cents: 5, start_date: '1901-01-01' })).status, 400);
  // A backup with too many rows is refused before anything changes.
  const many = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, name: `Loan ${i}` }));
  r = await call('POST', '/import', { app: 'simple-budget', format_version: 2, loans: many });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^That backup has more loans than Simple Budget can keep \(500\)/);
  assert.equal((await call('GET', '/loans')).body.length, 1);
  // A loan in a backup dated too far back is left out with a warning.
  r = await call('POST', '/import', { app: 'simple-budget', format_version: 2, loans: [{ id: 1, name: 'Old', start_date: '1901-01-01' }, { id: 2, name: 'New' }] });
  assert.equal(r.body.counts.loans, 1);
  assert.match(r.body.warnings.join(' '), /Old.*60 years/);
}); });

test('a list that is full says so', () => withServer({}, async (call) => {
  for (let i = 0; i < 200; i += 1) await call('POST', '/incomes', { name: `Pay ${i}`, after_tax_cents: 100 });
  const r = await call('POST', '/incomes', { name: 'One more', after_tax_cents: 100 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "That's more incomes than Simple Budget can keep (200).");
}));
