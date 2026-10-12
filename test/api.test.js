'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');

// Logs in with the default password and sets a new one, unless told not to.
async function withServer(options, fn) {
  const app = createApp({ db: openDatabase(':memory:'), ...options });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
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
  assert.equal(backup.format_version, 1);

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

test('savings count towards deposits but not expenses, loans add repayments', () => withServer({}, async (call) => {
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
}));

test('monthly budget with fortnightly pay, yearly savings and budgeted loan repayments', () => withServer({}, async (call) => {
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
}));

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
