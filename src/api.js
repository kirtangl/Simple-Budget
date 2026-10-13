'use strict';

const express = require('express');
const { transaction, getSetting, setSetting } = require('./db');
const budget = require('./budget');

class BadRequest extends Error {}

// Field types used to validate request bodies.
const T = {
  text: (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' && typeof v !== 'number') throw new BadRequest('must be text');
    const s = String(v).trim();
    return s === '' ? null : s.slice(0, 500);
  },
  int: (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new BadRequest('must be a whole number');
    return n;
  },
  cents: (v) => {
    const n = T.int(v);
    if (n !== null && Math.abs(n) > 1e12) throw new BadRequest('is too large');
    return n;
  },
  // Money that can't be below zero, like a balance held in an offset account.
  positiveCents: (v) => {
    const n = T.cents(v);
    if (n !== null && n < 0) throw new BadRequest("can't be negative");
    return n;
  },
  // A colour from the colour picker, like #2563eb. Anything else is dropped,
  // since it ends up in the page's styles.
  colour: (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : null),
  bool: (v) => {
    if (v === undefined || v === null) return null;
    if (v === 'false' || v === '0') return 0;
    return v ? 1 : 0;
  },
  date: (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (!budget.isValidDate(v)) throw new BadRequest('must be a date like 2026-10-06, between 1900 and 2199');
    return v;
  },
  // Australian BSB: six digits, stored as 000-000. Accepts 000000, 000-000 or 000 000.
  bsb: (v) => {
    const t = T.text(v);
    if (t === null) return null;
    const m = /^(\d{3})[-\s]?(\d{3})$/.exec(t);
    if (!m) throw new BadRequest('must be 6 digits, like 062-000');
    return `${m[1]}-${m[2]}`;
  },
  // Account numbers vary by country, so only check it's digits (spaces and dashes are dropped) and not too long.
  accountNumber: (v) => {
    const t = T.text(v);
    if (t === null) return null;
    const digits = t.replace(/[\s-]/g, '');
    if (!/^\d{1,20}$/.test(digits)) throw new BadRequest('must be numbers only, up to 20 digits');
    return digits;
  },
  enumOf: (...values) => (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (!values.includes(v)) throw new BadRequest(`must be one of ${values.join(', ')}`);
    return v;
  },
  // Interest rate as a percentage, e.g. 6.24.
  rate: (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new BadRequest('must be a percentage from 0 to 100');
    return n;
  },
  range: (min, max) => (v) => {
    const n = T.int(v);
    if (n !== null && (n < min || n > max)) throw new BadRequest(`must be between ${min} and ${max}`);
    return n;
  },
};

const LABELS = {
  name: 'Name', amount_cents: 'Amount', frequency: 'Frequency', after_tax_cents: 'After tax amount',
  category_id: 'Category', kind: 'Type', bsb: 'BSB', account_number: 'Account number',
  start_date: 'Start date', target_date: 'Target date', interest_rate: 'Interest rate', term_months: 'Term (months)',
  interest_day: 'Interest day', principal_cents: 'Amount borrowed', repayment_cents: 'Repayment', balance_cents: 'Balance',
};

// Each resource: table name, its fields with validators, and which are required.
const RESOURCES = {
  accounts: {
    fields: { name: T.text, nickname: T.text, institution: T.text, type: T.text, owner: T.text,
      bsb: T.bsb, account_number: T.accountNumber, color: T.colour, sort_order: T.int },
    required: ['name'],
    order: 'sort_order, name COLLATE NOCASE',
    unique: { label: 'An account' },
  },
  // How a bill is paid: BPAY (biller code + reference), bank transfer (bank
  // details + reference), or other (biller/reference in the reference field).
  payees: {
    fields: { name: T.text, reference: T.text, notes: T.text, pay_type: T.enumOf('bpay', 'transfer', 'direct_debit', 'other'), policy_number: T.text,
      biller_code: T.text, bank: T.text, bsb: T.bsb, account_number: T.accountNumber, account_name: T.text },
    required: ['name'],
    order: 'name COLLATE NOCASE',
    unique: { label: 'A payee' },
  },
  categories: {
    fields: { name: T.text, color: T.colour, sort_order: T.int },
    required: ['name'],
    order: 'sort_order, name COLLATE NOCASE',
    unique: { label: 'A category' },
  },
  subcategories: {
    fields: { category_id: T.int, name: T.text },
    required: ['category_id', 'name'],
    order: 'name COLLATE NOCASE',
    unique: { label: 'A sub category', within: 'category_id' },
  },
  expenses: {
    fields: {
      name: T.text, amount_cents: T.positiveCents, frequency: T.enumOf(...Object.keys(budget.FREQUENCIES)),
      day_offset: T.range(0, 13), day_of_month: T.range(1, 31), start_month: T.range(1, 12),
      payee_id: T.int, category_id: T.int, subcategory_id: T.int, account_id: T.int,
      reference: T.text, notes: T.text, active: T.bool,
      kind: T.enumOf('expense', 'saving'), goal_cents: T.positiveCents,
      yearly_cents: T.positiveCents, show_as_expense: T.bool, start_date: T.date, end_date: T.date,
    },
    required: ['name', 'amount_cents', 'frequency'],
    order: 'name COLLATE NOCASE',
    // A saving with a yearly target is stored as a yearly amount, so anything
    // that doesn't know about splitting still averages it the same way.
    normalize: (row) => {
      if (row.yearly_cents != null) Object.assign(row, { amount_cents: row.yearly_cents, frequency: 'yearly' });
      return row;
    },
  },
  incomes: {
    fields: { name: T.text, payer: T.text, after_tax_cents: T.positiveCents, before_tax_cents: T.positiveCents,
      super_cents: T.positiveCents, start_date: T.date, end_date: T.date, include_in_budget: T.bool,
      frequency: T.enumOf(...Object.keys(budget.INCOME_FREQUENCIES)), color: T.colour },
    required: ['name', 'after_tax_cents'],
    order: 'name COLLATE NOCASE',
  },
  goals: {
    fields: { kind: T.enumOf('goal', 'debt'), group_name: T.text, name: T.text, target_cents: T.positiveCents,
      current_cents: T.positiveCents, notes: T.text, done: T.bool, sort_order: T.int,
      start_date: T.date, target_date: T.date, target_firm: T.bool, account_id: T.int, owner_id: T.int },
    required: ['kind', 'name'],
    // A new goal belongs to whoever added it, unless the form says otherwise.
    owned: true,
    order: 'done, group_name COLLATE NOCASE, sort_order, name COLLATE NOCASE',
  },
  loans: {
    fields: { name: T.text, lender: T.text, account_id: T.int, category_id: T.int, principal_cents: T.positiveCents,
      interest_rate: T.rate, start_date: T.date, term_months: T.range(1, 600),
      repayment_frequency: T.enumOf(...Object.keys(budget.LOAN_FREQUENCIES)), repayment_cents: T.positiveCents,
      balance_cents: T.positiveCents, balance_date: T.date, interest_day: T.range(1, 31),
      include_in_budget: T.bool, paid_off: T.bool, notes: T.text, scheduled_date: T.date,
      budget_frequency: T.enumOf(...Object.keys(budget.LOAN_FREQUENCIES)), budget_cents: T.positiveCents, budget_date: T.date,
      rate_type: T.enumOf('variable', 'fixed'), fixed_until: T.date, offset_cents: T.positiveCents, monthly_fee_cents: T.positiveCents, break_fees: T.text },
    required: ['name'],
    order: 'paid_off, name COLLATE NOCASE',
    unique: { label: 'A loan' },
  },
  // Categories on the Goals and Debts tabs. Goals refer to them by name (goals.group_name).
  goal_groups: {
    fields: { kind: T.enumOf('goal', 'debt'), name: T.text, color: T.colour },
    required: ['kind', 'name'],
    order: 'kind, name COLLATE NOCASE',
    // Renaming a category moves its goals with it.
    afterUpdate: (db, before, after) => {
      if (before.name !== after.name) {
        db.prepare('UPDATE goals SET group_name = ? WHERE kind = ? AND group_name = ? COLLATE NOCASE').run(after.name, after.kind, before.name);
      }
    },
    // Deleting a category leaves its goals uncategorised.
    afterDelete: (db, before) => {
      db.prepare('UPDATE goals SET group_name = NULL WHERE kind = ? AND group_name = ? COLLATE NOCASE').run(before.kind, before.name);
    },
  },
};

function clean(resource, body, { partial }) {
  if (!body || typeof body !== 'object') throw new BadRequest('Expected a JSON body.');
  let out = {};
  for (const [key, check] of Object.entries(resource.fields)) {
    if (!(key in body)) continue;
    try {
      out[key] = check(body[key]);
    } catch (err) {
      if (err instanceof BadRequest) throw new BadRequest(`${LABELS[key] || key} ${err.message}.`);
      throw err;
    }
  }
  if (resource.normalize) out = resource.normalize(out);
  for (const key of resource.required) {
    if ((partial ? key in out : true) && (out[key] === null || out[key] === undefined)) {
      throw new BadRequest(`${LABELS[key] || key} is required.`);
    }
  }
  if (out.start_date && out.end_date && out.start_date > out.end_date) throw new BadRequest('The end date should be after the start date.');
  // Columns with NOT NULL defaults: don't write null over them.
  for (const key of ['current_cents', 'sort_order', 'active', 'done', 'include_in_budget', 'target_firm', 'kind', 'repayment_frequency', 'paid_off', 'show_as_expense', 'frequency']) {
    if (out[key] === null) delete out[key];
  }
  return out;
}

function today() {
  // Local date of the server, which is set by TZ in docker-compose.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function payAnchor(db) {
  return getSetting(db, 'pay_anchor_date') || today();
}

function payCycleOf(db) {
  return budget.payCycle(getSetting(db, 'pay_frequency') || 'fortnightly', getSetting(db, 'pay_custom_days'));
}

function heldBasis(db) {
  const b = getSetting(db, 'held_basis');
  return budget.HELD_BASES.includes(b) ? b : 'year';
}

function depositRules(db) {
  const rounding = getSetting(db, 'rounding');
  const buffer = Number(getSetting(db, 'buffer_percent'));
  return {
    rounding: Object.hasOwn(budget.ROUNDING, rounding) ? rounding : budget.DEFAULT_DEPOSIT_RULES.rounding,
    buffer_percent: Number.isFinite(buffer) ? buffer : budget.DEFAULT_DEPOSIT_RULES.buffer_percent,
  };
}

function createApi(db) {
  const router = express.Router();

  const list = (name) => db.prepare(`SELECT * FROM ${name} ORDER BY ${RESOURCES[name].order}`).all()
    .map((row) => ({ ...row }));

  function categoriesWithSubs() {
    const subs = list('subcategories');
    return list('categories').map((c) => ({ ...c, subcategories: subs.filter((s) => s.category_id === c.id) }));
  }

  function settings() {
    const pc = payCycleOf(db);
    return { pay_anchor_date: payAnchor(db), today: today(), pay_frequency: pc.frequency, pay_custom_days: pc.days,
      pays_per_year: budget.paysPerYear(pc), cycle_end: budget.cycleBounds(payAnchor(db), budget.cycleIndexFor(payAnchor(db), today(), pc), pc).end,
      held_basis: heldBasis(db), ...depositRules(db) };
  }

  // Loans with their estimates, and as expense-like rows for the pay-cycle maths.
  function loansWithEstimates() {
    return list('loans').map((l) => ({ ...l, ...budget.loanEstimates(l, today()) }));
  }
  function budgetRows() {
    const anchor = payAnchor(db);
    return [...list('expenses'), ...list('loans').map((l) => budget.loanAsExpense(l, anchor))];
  }

  // Everything the app needs to draw its lists, in one request.
  router.get('/data', (req, res) => {
    const pc = payCycleOf(db);
    res.json({
      settings: settings(),
      accounts: list('accounts'),
      payees: list('payees'),
      categories: categoriesWithSubs(),
      expenses: list('expenses').map((e) => ({ ...e, next_date: budget.nextDate(e, today(), payAnchor(db)), per_pay_cents: Math.round(budget.perCycleCents(e, pc)), per_pay_exact_cents: budget.perCycleCents(e, pc) })),
      loans: loansWithEstimates().map((l) => {
        const row = budget.loanAsExpense(l, payAnchor(db));
        return { ...l, per_pay_cents: row.active ? Math.round(budget.perPayCents(row, pc)) : 0, per_pay_exact_cents: row.active ? budget.perPayCents(row, pc) : 0 };
      }),
      incomes: list('incomes'),
      goals: list('goals'),
      goal_groups: list('goal_groups'),
    });
  });

  // One pay cycle. offset=0 is the cycle containing today, -1 the one before, etc.
  router.get('/cycle', (req, res) => {
    const offset = Number.parseInt(req.query.offset ?? '0', 10);
    if (!Number.isFinite(offset) || Math.abs(offset) > 2600) throw new BadRequest('Bad offset.');
    const anchor = payAnchor(db);
    const now = today();
    const pc = payCycleOf(db);
    const index = budget.cycleIndexFor(anchor, now, pc) + offset;
    const rows = budgetRows();
    const accounts = list('accounts');
    const cycle = budget.buildCycle({ anchor, index, today: now, expenses: rows, accounts, incomes: list('incomes'), rules: depositRules(db), payCycle: pc });
    // What each account should be holding: today for this cycle, or at the start of any other cycle shown.
    const heldOn = offset === 0 ? now : cycle.cycle.start;
    const held = new Map(budget.heldEstimates(rows, accounts, { today: heldOn, anchor, payCycle: pc, basis: heldBasis(db) })
      .map((h) => [h.account_id, h.held_cents]));
    cycle.accounts.forEach((a) => { a.held_cents = held.get(a.account_id) ?? 0; });
    res.json({ offset, held_basis: heldBasis(db), held_on: heldOn, ...cycle });
  });

  // Month-by-month totals for the next `months` months (Analytics → Annual trends).
  // Income is counted per pay cycle starting in the month; expenses on the day they come out.
  router.get('/trends', (req, res) => {
    const months = Math.min(Math.max(Number.parseInt(req.query.months ?? '12', 10) || 12, 1), 24);
    const anchor = payAnchor(db);
    const pc = payCycleOf(db);
    const rows = budgetRows().filter((e) => e.active);
    const incomes = list('incomes');
    const first = `${today().slice(0, 7)}-01`;
    const out = [];
    for (let i = 0; i < months; i += 1) {
      const start = budget.monthlyStart(first, i);
      const end = budget.addDays(budget.monthlyStart(first, i + 1), -1);
      const m = { month: start.slice(0, 7), income_cents: 0, other_income_cents: 0, expenses_cents: 0, savings_cents: 0, pays: 0 };
      for (let c = budget.cycleIndexFor(anchor, start, pc); ; c += 1) {
        const cycle = budget.cycleBounds(anchor, c, pc);
        if (cycle.start > end) break;
        if (cycle.start < start) continue;
        m.pays += 1;
        for (const inc of incomes) {
          if ((inc.start_date && inc.start_date > cycle.end) || (inc.end_date && inc.end_date < cycle.start)) continue;
          const amount = Math.round(budget.incomePerCycle(inc, pc));
          if (inc.include_in_budget === 0) m.other_income_cents += amount;
          else m.income_cents += amount;
        }
        // Yearly savings targets go in once per budget cycle.
        for (const e of rows.filter((r) => budget.isSplit(r) && budget.inRange(r, cycle))) {
          const amount = Math.round(budget.perCycleCents(e, pc));
          if (e.show_as_expense) m.expenses_cents += amount;
          else m.savings_cents += amount;
        }
      }
      for (const e of rows.filter((r) => !budget.isSplit(r))) {
        for (const date of budget.occurrences(e, start, end, anchor)) {
          if ((e.start_date && date < e.start_date) || (e.end_date && date > e.end_date)) continue;
          if (e.kind === 'saving' && !e.show_as_expense) m.savings_cents += e.amount_cents;
          else m.expenses_cents += e.amount_cents;
        }
      }
      m.surplus_cents = m.income_cents - m.expenses_cents - m.savings_cents;
      out.push(m);
    }
    res.json({ months: out });
  });

  // Loan calculator: repayment for an amount, and the most you could borrow while
  // keeping all commitments under a share of income. Estimates only.
  // One loan with its balance over time, for the detail popup.
  // One expense with what has come out so far this financial and calendar year.
  router.get('/expenses/:id/details', (req, res) => {
    const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(req.params.id));
    if (!e) return res.status(404).json({ error: 'Not found.' });
    const now = today();
    const opts = { anchor: payAnchor(db), payCycle: payCycleOf(db) };
    const fy = budget.yearStart(now, 'financial');
    const cy = budget.yearStart(now, 'calendar');
    res.json({ ...e, next_date: budget.nextDate(e, now, opts.anchor), spread: budget.spreadsEachCycle(e, opts.payCycle),
      paid_fytd: { from: fy, ...budget.paidBetween(e, fy, now, opts) },
      paid_ytd: { from: cy, ...budget.paidBetween(e, cy, now, opts) } });
  });

  router.get('/loans/:id/details', (req, res) => {
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(Number(req.params.id));
    if (!loan) return res.status(404).json({ error: 'Not found.' });
    const l = { ...loan };
    const now = today();
    const est = budget.loanEstimates(l, now);
    const timeline = budget.loanTimeline(l, now);
    // The bank's schedule from today: only the scheduled repayments, for comparing against the plan.
    const bankPoints = [];
    const bank = est.estimated_balance_cents > 0
      ? budget.simulateLoan({ ...l, balance_cents: est.estimated_balance_cents, balance_date: now, budget_cents: null, budget_frequency: null, budget_date: null }, null,
        (date, balance) => bankPoints.push([budget.addDays(date, -1).slice(0, 7), Math.round(Math.max(0, balance))]))
      : null;
    // Interest charged since 1 July (whole months so far).
    const fy = budget.yearStart(now, 'financial').slice(0, 7);
    const interestFy = timeline ? timeline.points.filter((p) => p.month >= fy && p.month < now.slice(0, 7)).reduce((t, p) => t + p.interest_cents, 0) : null;
    res.json({ ...l, ...est, timeline,
      bank: bank ? { points: bankPoints, interest_cents: bank.interest_cents, payoff_date: bank.paid_off ? bank.date : null } : null,
      interest_fy_cents: interestFy });
  });

  router.get('/loan-calculator', (req, res) => {
    const q = req.query;
    const freq = Object.hasOwn(budget.LOAN_FREQUENCIES, q.frequency) ? q.frequency : 'monthly';
    const perYear = budget.LOAN_FREQUENCIES[freq];
    const rate = T.rate(q.rate) ?? 0;
    const years = Number(q.years);
    if (!(years > 0 && years <= 50)) throw new BadRequest('Term must be between 1 and 50 years.');
    const periods = Math.round(years * perYear);
    const amount = T.cents(q.amount_cents);
    const limit = Math.min(Math.max(Number(q.limit_percent) || 70, 1), 100);

    // What this pay already commits: all the deposits (bills, savings, loans).
    const pc = payCycleOf(db);
    const anchor = payAnchor(db);
    const index = budget.cycleIndexFor(anchor, today(), pc);
    const bounds = budget.cycleBounds(anchor, index, pc);
    const cycle = budget.buildCycle({ anchor, index, today: today(), expenses: budgetRows(),
      accounts: list('accounts'), incomes: list('incomes'), rules: depositRules(db), payCycle: pc });
    const perPayToPerYear = budget.paysPerYear(pc);
    const incomeYear = cycle.totals.income_cents * perPayToPerYear;
    const committedYear = budgetRows().filter((e) => e.active && budget.inRange(e, bounds)).reduce((s, e) => s + budget.perPayCents(e, pc), 0) * perPayToPerYear;
    const spareRepayment = Math.max(0, ((incomeYear * limit) / 100 - committedYear) / perYear);
    res.json({
      repayment_cents: amount ? Math.round(budget.amortisedRepayment(amount, rate, perYear, periods)) : null,
      total_interest_cents: amount ? Math.round(budget.amortisedRepayment(amount, rate, perYear, periods) * periods - amount) : null,
      income_per_year_cents: Math.round(incomeYear),
      committed_per_year_cents: Math.round(committedYear),
      committed_percent: incomeYear ? Math.round((committedYear / incomeYear) * 1000) / 10 : null,
      limit_percent: limit,
      max_repayment_cents: Math.round(spareRepayment),
      max_loan_cents: Math.round(budget.maxPrincipal(spareRepayment, rate, perYear, periods)),
    });
  });

  router.get('/settings', (req, res) => res.json(settings()));

  router.put('/settings', (req, res) => {
    const body = req.body || {};
    const changes = {};
    if ('pay_anchor_date' in body) {
      changes.pay_anchor_date = T.date(body.pay_anchor_date);
      if (!changes.pay_anchor_date) throw new BadRequest('Pay day must be a date like 2026-10-06.');
    }
    if ('rounding' in body) {
      if (!Object.hasOwn(budget.ROUNDING, body.rounding)) throw new BadRequest('Rounding must be exact, up5 or up10.');
      changes.rounding = body.rounding;
    }
    if ('pay_frequency' in body) {
      if (!Object.hasOwn(budget.PAY_FREQUENCIES, body.pay_frequency)) throw new BadRequest('Pay frequency must be weekly, fortnightly, monthly or custom.');
      changes.pay_frequency = body.pay_frequency;
    }
    if ('pay_custom_days' in body && body.pay_custom_days !== null) {
      const days = Number(body.pay_custom_days);
      if (!Number.isInteger(days) || days < 1 || days > 366) throw new BadRequest('A custom pay cycle must be 1 to 366 days.');
      changes.pay_custom_days = String(days);
    }
    if ('held_basis' in body) {
      if (!budget.HELD_BASES.includes(body.held_basis)) throw new BadRequest('Look-ahead must be year, financial or calendar.');
      changes.held_basis = body.held_basis;
    }
    if ('buffer_percent' in body) {
      const pct = Number(body.buffer_percent);
      if (!Number.isInteger(pct) || pct < 0 || pct > 20) throw new BadRequest('Buffer must be a whole number from 0 to 20.');
      changes.buffer_percent = String(pct);
    }
    transaction(db, () => Object.entries(changes).forEach(([k, v]) => setSetting(db, k, v)));
    res.json(settings());
  });

  for (const [name, resource] of Object.entries(RESOURCES)) {
    const get = (id) => {
      const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id);
      return row ? { ...row } : null;
    };

    router.get(`/${name}`, (req, res) => res.json(name === 'categories' ? categoriesWithSubs() : list(name)));

    // Names must be unique (ignoring case) where the resource says so, e.g. no two payees called "Telstra".
    const checkUnique = (data, id) => {
      if (!resource.unique || !data.name) return;
      const { label, within } = resource.unique;
      const row = id ? get(id) : {};
      const scope = within ? (within in data ? data[within] : row[within]) : null;
      const clash = db.prepare(`SELECT id FROM ${name} WHERE name = ? COLLATE NOCASE AND id IS NOT ?${within ? ` AND ${within} = ?` : ''}`)
        .get(...[data.name, id ?? null, ...(within ? [scope] : [])]);
      if (clash) throw new BadRequest(`${label} called "${data.name}" already exists.`);
    };

    router.post(`/${name}`, (req, res) => {
      const data = clean(resource, req.body, { partial: false });
      if (resource.owned && !(req.body && 'owner_id' in req.body) && req.login) data.owner_id = req.login.id;
      checkUnique(data);
      const cols = Object.keys(data);
      const sql = `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      const { lastInsertRowid } = db.prepare(sql).run(...cols.map((c) => data[c]));
      res.status(201).json(get(lastInsertRowid));
    });

    router.patch(`/${name}/:id`, (req, res) => {
      const id = Number(req.params.id);
      if (!get(id)) return res.status(404).json({ error: 'Not found.' });
      const data = clean(resource, req.body, { partial: true });
      checkUnique(data, id);
      const cols = Object.keys(data);
      const before = get(id);
      transaction(db, () => {
        if (cols.length) {
          db.prepare(`UPDATE ${name} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
            .run(...cols.map((c) => data[c]), id);
        }
        if (resource.afterUpdate) resource.afterUpdate(db, before, get(id));
      });
      res.json(get(id));
    });

    router.delete(`/${name}/:id`, (req, res) => {
      const before = get(Number(req.params.id));
      if (!before) return res.status(404).json({ error: 'Not found.' });
      transaction(db, () => {
        db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(before.id);
        if (resource.afterDelete) resource.afterDelete(db, before);
      });
      res.json({ ok: true });
    });
  }

  // Add to or take from what's saved or paid off, e.g. { amount_cents: -10000 }.
  router.post('/goals/:id/adjust', (req, res) => {
    const id = Number(req.params.id);
    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    if (!goal) return res.status(404).json({ error: 'Not found.' });
    const amount = T.cents((req.body || {}).amount_cents);
    if (!amount) throw new BadRequest('Enter an amount to add or take away.');
    const next = goal.current_cents + amount;
    if (next < 0) throw new BadRequest(`There's only $${(goal.current_cents / 100).toFixed(2)} to take from.`);
    db.prepare('UPDATE goals SET current_cents = ? WHERE id = ?').run(next, id);
    res.json({ ...db.prepare('SELECT * FROM goals WHERE id = ?').get(id) });
  });

  // Save a new display order, e.g. { ids: [3, 1, 2] }.
  router.post('/:name/reorder', (req, res) => {
    const { name } = req.params;
    if (!['accounts', 'categories', 'goals'].includes(name)) return res.status(404).json({ error: 'Not found.' });
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids)) throw new BadRequest('Expected a list of ids.');
    const stmt = db.prepare(`UPDATE ${name} SET sort_order = ? WHERE id = ?`);
    transaction(db, () => ids.forEach((id, i) => stmt.run(i, Number(id))));
    res.json({ ok: true });
  });

  // Full backup as JSON. See the backup section below for the format.
  router.get('/export', (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="simple-budget-backup-${today()}.json"`);
    res.json(exportBackup(db));
  });

  // Restore a backup, replacing the data in every section the file contains.
  router.post('/import', (req, res) => {
    res.json(importBackup(db, req.body));
  });

  router.use((err, req, res, next) => {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err && /UNIQUE/.test(err.message)) return res.status(400).json({ error: 'That name is already used.' });
    if (err && /FOREIGN KEY/.test(err.message)) return res.status(400).json({ error: 'That refers to something that no longer exists.' });
    next(err);
  });

  return router;
}

// ---------- Backup and restore ----------
//
// A backup is a JSON file:
//   { app: 'simple-budget', format_version, exported_at, settings: {...},
//     accounts: [...], payees: [...], categories: [{..., subcategories: [...]}],
//     expenses: [...], incomes: [...], goals: [...], goal_groups: [...], loans: [...] }
//
// To keep old backups restorable as the app grows:
//   - Bump BACKUP_FORMAT_VERSION when the shape of the file changes, and add a
//     function to BACKUP_UPGRADES that turns version N into N + 1.
//   - Fields the file doesn't have get their normal defaults, and fields this
//     version doesn't know about are ignored.
//   - A section missing from the file (e.g. a table added in a later version)
//     is left as it is instead of being emptied.

const BACKUP_FORMAT_VERSION = 1;
const BACKUP_UPGRADES = {
  // 1: (data) => { ...change data to the version 2 shape...; return data; },
};
const BACKUP_SECTIONS = ['accounts', 'payees', 'categories', 'incomes', 'expenses', 'goals', 'goal_groups', 'loans'];
const BACKUP_SETTINGS = ['pay_anchor_date', 'pay_frequency', 'pay_custom_days', 'rounding', 'buffer_percent', 'held_basis'];

function exportBackup(db) {
  const all = (name) => db.prepare(`SELECT * FROM ${name} ORDER BY id`).all().map((row) => ({ ...row }));
  const subs = all('subcategories');
  const settings = {};
  for (const key of BACKUP_SETTINGS) {
    const value = getSetting(db, key);
    if (value !== undefined) settings[key] = key === 'buffer_percent' || key === 'pay_custom_days' ? Number(value) : value;
  }
  return {
    app: 'simple-budget',
    format_version: BACKUP_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    settings,
    accounts: all('accounts'),
    payees: all('payees'),
    categories: all('categories').map((c) => ({ ...c, subcategories: subs.filter((x) => x.category_id === c.id) })),
    expenses: all('expenses'),
    incomes: all('incomes'),
    goals: all('goals'),
    goal_groups: all('goal_groups'),
    loans: all('loans'),
  };
}

function importBackup(db, input) {
  if (!input || typeof input !== 'object' || input.app !== 'simple-budget') {
    throw new BadRequest("That file doesn't look like a Simple Budget backup.");
  }
  let data = structuredClone(input);
  let version = Number(data.format_version) || 1;
  if (!Number.isInteger(version) || version < 1) throw new BadRequest("That file doesn't look like a Simple Budget backup.");
  if (version > BACKUP_FORMAT_VERSION) {
    throw new BadRequest('That backup was made by a newer version of Simple Budget. Update the app, then try again.');
  }
  while (version < BACKUP_FORMAT_VERSION) data = BACKUP_UPGRADES[version++](data);

  const warnings = [];
  const counts = {};
  const idMaps = {}; // section -> Map(old id -> new id)

  const insert = (table, row) => {
    const cols = Object.keys(row);
    const sql = cols.length
      ? `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      : `INSERT INTO ${table} DEFAULT VALUES`;
    return Number(db.prepare(sql).run(...cols.map((c) => row[c])).lastInsertRowid);
  };

  // A reference points at a row from the file if that section was restored,
  // otherwise at an existing row with the same id, otherwise at nothing.
  const ref = (section, table, oldId) => {
    if (oldId === null || oldId === undefined) return null;
    if (idMaps[section]) return idMaps[section].get(Number(oldId)) ?? null;
    return db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(Number(oldId)) ? Number(oldId) : null;
  };

  const restoreRows = (section, rows, table, prepare) => {
    if (!Array.isArray(rows)) return;
    const map = new Map();
    let n = 0;
    rows.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push(`Skipped ${table.replace(/s$/, '').replace('_', ' ')} #${i + 1}: it isn't a valid entry.`);
        return;
      }
      try {
        const row = clean(RESOURCES[table], prepare ? prepare(raw) : raw, { partial: false });
        map.set(Number(raw.id), insert(table, row));
        n += 1;
      } catch (err) {
        if (!(err instanceof BadRequest) && !/UNIQUE/.test(err.message)) throw err;
        warnings.push(`Skipped ${table.replace(/s$/, '').replace('_', ' ')} ${raw && raw.name ? `"${raw.name}"` : `#${i + 1}`}: ${err instanceof BadRequest ? err.message : 'the name is already used.'}`);
      }
    });
    idMaps[section] = map;
    counts[table] = n;
  };

  transaction(db, () => {
    // Clear the sections the file contains. Expenses go first because they refer to the others.
    const present = BACKUP_SECTIONS.filter((s) => Array.isArray(data[s]));
    for (const section of ['expenses', 'loans', 'goals', 'goal_groups', 'incomes', 'categories', 'payees', 'accounts']) {
      if (present.includes(section)) db.exec(`DELETE FROM ${section}`);
    }
    if (present.includes('categories')) db.exec('DELETE FROM subcategories');

    // Bank details saved before they were checked may not fit the rules. Keep the
    // row and drop just the bad detail, rather than losing the expenses that use it.
    const dropBadBankDetails = (what) => (row) => {
      const out = { ...row };
      for (const [key, check] of [['bsb', T.bsb], ['account_number', T.accountNumber]]) {
        try { check(out[key]); } catch (err) {
          if (!(err instanceof BadRequest)) throw err;
          warnings.push(`Left out the ${LABELS[key]} of ${what} "${row.name}": ${err.message}.`);
          out[key] = null;
        }
      }
      return out;
    };
    restoreRows('accounts', data.accounts, 'accounts', dropBadBankDetails('account'));
    restoreRows('payees', data.payees, 'payees', dropBadBankDetails('payee'));
    restoreRows('categories', data.categories, 'categories');
    if (Array.isArray(data.categories)) {
      const subRows = data.categories.flatMap((c) => (Array.isArray(c && c.subcategories) ? c.subcategories : [])
        .filter((sub) => sub && typeof sub === 'object').map((sub) => ({ ...sub, category_id: c.id })));
      restoreRows('subcategories', subRows, 'subcategories', (sub) => ({ ...sub, category_id: idMaps.categories.get(Number(sub.category_id)) }));
    }
    restoreRows('incomes', data.incomes, 'incomes');
    restoreRows('goal_groups', data.goal_groups, 'goal_groups');
    restoreRows('loans', data.loans, 'loans', (l) => ({ ...l,
      account_id: ref('accounts', 'accounts', l.account_id), category_id: ref('categories', 'categories', l.category_id) }));
    restoreRows('goals', data.goals, 'goals', (g) => ({ ...g, account_id: ref('accounts', 'accounts', g.account_id) }));
    restoreRows('expenses', data.expenses, 'expenses', (e) => ({
      ...e,
      account_id: ref('accounts', 'accounts', e.account_id),
      payee_id: ref('payees', 'payees', e.payee_id),
      category_id: ref('categories', 'categories', e.category_id),
      subcategory_id: ref('subcategories', 'subcategories', e.subcategory_id),
    }));

    const s = data.settings && typeof data.settings === 'object' ? data.settings : {};
    if (budget.isValidDate(s.pay_anchor_date)) setSetting(db, 'pay_anchor_date', s.pay_anchor_date);
    if (Object.hasOwn(budget.ROUNDING, s.rounding)) setSetting(db, 'rounding', s.rounding);
    const pct = Number(s.buffer_percent);
    if (s.buffer_percent !== undefined && Number.isInteger(pct) && pct >= 0 && pct <= 20) setSetting(db, 'buffer_percent', String(pct));
    if (Object.hasOwn(budget.PAY_FREQUENCIES, s.pay_frequency)) setSetting(db, 'pay_frequency', s.pay_frequency);
    if (budget.HELD_BASES.includes(s.held_basis)) setSetting(db, 'held_basis', s.held_basis);
    const days = Number(s.pay_custom_days);
    if (Number.isInteger(days) && days >= 1 && days <= 366) setSetting(db, 'pay_custom_days', String(days));
  });

  return { ok: true, format_version: Number(input.format_version) || 1, counts, warnings };
}

module.exports = { createApi, today, exportBackup, importBackup, BACKUP_FORMAT_VERSION, BACKUP_SETTINGS };
