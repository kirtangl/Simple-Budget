'use strict';

// All money is stored as integer cents to avoid floating point rounding.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  `
  CREATE TABLE accounts (
    id              INTEGER PRIMARY KEY,
    name            TEXT    NOT NULL,
    nickname        TEXT,
    institution     TEXT,
    type            TEXT,
    owner           TEXT,
    bsb             TEXT,
    account_number  TEXT,
    color           TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE payees (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    reference  TEXT,
    notes      TEXT
  );

  CREATE TABLE categories (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    color       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE subcategories (
    id           INTEGER PRIMARY KEY,
    category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL
  );

  -- Bills / regular expenses. Schedule fields depend on frequency:
  --   weekly:       day_offset 0-6 days after the pay cycle start
  --   fortnightly:  day_offset 0-13 days after the pay cycle start
  --   monthly+:     day_of_month 1-31 (clamped to the month's last day),
  --                 and for longer frequencies start_month 1-12 anchors which months.
  CREATE TABLE expenses (
    id              INTEGER PRIMARY KEY,
    name            TEXT    NOT NULL,
    amount_cents    INTEGER NOT NULL,
    frequency       TEXT    NOT NULL CHECK (frequency IN
                      ('weekly', 'fortnightly', 'monthly', 'bimonthly', 'quarterly', 'semiannual', 'yearly')),
    day_offset      INTEGER,
    day_of_month    INTEGER,
    start_month     INTEGER,
    payee_id        INTEGER REFERENCES payees(id) ON DELETE SET NULL,
    category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    subcategory_id  INTEGER REFERENCES subcategories(id) ON DELETE SET NULL,
    account_id      INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    reference       TEXT,
    notes           TEXT,
    active          INTEGER NOT NULL DEFAULT 1
  );

  -- Income sources, an amount each pay. Only after-tax is required.
  CREATE TABLE incomes (
    id                 INTEGER PRIMARY KEY,
    name               TEXT    NOT NULL,
    payer              TEXT,
    after_tax_cents    INTEGER NOT NULL,
    before_tax_cents   INTEGER,
    super_cents        INTEGER,
    start_date         TEXT,
    end_date           TEXT
  );

  -- Goals and debts share one table, split by kind and grouped by group_name.
  CREATE TABLE goals (
    id             INTEGER PRIMARY KEY,
    kind           TEXT    NOT NULL CHECK (kind IN ('goal', 'debt')),
    group_name     TEXT,
    name           TEXT    NOT NULL,
    target_cents   INTEGER,
    current_cents  INTEGER NOT NULL DEFAULT 0,
    notes          TEXT,
    done           INTEGER NOT NULL DEFAULT 0,
    sort_order     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: income can be left out of the budget (the pool that pays the expenses).
  `
  ALTER TABLE incomes ADD COLUMN include_in_budget INTEGER NOT NULL DEFAULT 1;
  `,
  // 3: dates on goals and debts. start_date is when a debt began; target_firm
  // marks a target date that must be met rather than one to aim for.
  `
  ALTER TABLE goals ADD COLUMN start_date TEXT;
  ALTER TABLE goals ADD COLUMN target_date TEXT;
  ALTER TABLE goals ADD COLUMN target_firm INTEGER NOT NULL DEFAULT 0;
  `,
  // 4: colours for goal and debt categories, and the account a goal is saved in.
  `
  CREATE TABLE goal_groups (
    id     INTEGER PRIMARY KEY,
    kind   TEXT NOT NULL CHECK (kind IN ('goal', 'debt')),
    name   TEXT NOT NULL,
    color  TEXT,
    UNIQUE (kind, name COLLATE NOCASE)
  );
  ALTER TABLE goals ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
  `,
  // 5: how a payee is paid (BPAY, bank transfer or other) and the details for it.
  `
  ALTER TABLE payees ADD COLUMN pay_type TEXT;
  ALTER TABLE payees ADD COLUMN biller_code TEXT;
  ALTER TABLE payees ADD COLUMN bank TEXT;
  ALTER TABLE payees ADD COLUMN bsb TEXT;
  ALTER TABLE payees ADD COLUMN account_number TEXT;
  ALTER TABLE payees ADD COLUMN account_name TEXT;
  `,
  // 6: savings live alongside expenses (kind = 'saving', with an optional goal),
  // and loans get their own table.
  `
  ALTER TABLE expenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense';
  ALTER TABLE expenses ADD COLUMN goal_cents INTEGER;
  CREATE TABLE loans (
    id                  INTEGER PRIMARY KEY,
    name                TEXT    NOT NULL,
    lender              TEXT,
    account_id          INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    category_id         INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    principal_cents     INTEGER,
    interest_rate       REAL,
    start_date          TEXT,
    term_months         INTEGER,
    repayment_frequency TEXT    NOT NULL DEFAULT 'monthly',
    repayment_cents     INTEGER,
    balance_cents       INTEGER,
    balance_date        TEXT,
    interest_day        INTEGER,
    include_in_budget   INTEGER NOT NULL DEFAULT 1,
    paid_off            INTEGER NOT NULL DEFAULT 0,
    notes               TEXT
  );
  `,
  // 7: loans split the lender's scheduled repayment (repayment_*, scheduled_date)
  // from what is actually budgeted (budget_*); savings can have a yearly target
  // split across each budget cycle and can count as expenses; expenses and
  // savings can be temporary; incomes say how often they're paid.
  `
  ALTER TABLE loans ADD COLUMN scheduled_date TEXT;
  ALTER TABLE loans ADD COLUMN budget_frequency TEXT;
  ALTER TABLE loans ADD COLUMN budget_cents INTEGER;
  ALTER TABLE loans ADD COLUMN budget_date TEXT;
  ALTER TABLE expenses ADD COLUMN yearly_cents INTEGER;
  ALTER TABLE expenses ADD COLUMN show_as_expense INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE expenses ADD COLUMN start_date TEXT;
  ALTER TABLE expenses ADD COLUMN end_date TEXT;
  ALTER TABLE incomes ADD COLUMN frequency TEXT NOT NULL DEFAULT 'fortnightly';
  `,
  // 8: incomes get a colour, used in the cash flow chart.
  `
  ALTER TABLE incomes ADD COLUMN color TEXT;
  `,
  // 9: payees get the account or policy number the biller knows you by.
  `
  ALTER TABLE payees ADD COLUMN policy_number TEXT;
  `,
  // 10: loans get a rate type (and when a fixed rate ends), an offset balance,
  // a monthly fee and a note on early repayment or break fees.
  `
  ALTER TABLE loans ADD COLUMN rate_type TEXT;
  ALTER TABLE loans ADD COLUMN fixed_until TEXT;
  ALTER TABLE loans ADD COLUMN offset_cents INTEGER;
  ALTER TABLE loans ADD COLUMN monthly_fee_cents INTEGER;
  ALTER TABLE loans ADD COLUMN break_fees TEXT;
  `,
  // 11: extra household logins. Each has its own password and its own theme.
  // The original household password (in settings) stays as the main login.
  `
  CREATE TABLE logins (
    id            INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    theme         TEXT,
    custom_theme  TEXT
  );
  `,
  // 12: each login's own colour for the account icon, kept whatever the theme.
  `
  ALTER TABLE logins ADD COLUMN colour TEXT;
  `,
  // 13: who a goal or debt belongs to (a login id; 0 is the main login). Empty means shared.
  `
  ALTER TABLE goals ADD COLUMN owner_id INTEGER;
  `,
];

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      if (i === 0) seed(db);
    });
  }
  return db;
}

const DEFAULT_CATEGORIES = {
  'Financial Commitments': ['Mortgage / Rent', 'Personal Loan', 'Other Loans', 'Credit Cards',
    'Super Contributions', 'Savings', 'Emergency Fund', 'Other Financial'],
  'Home & Utilities': ['Council Rates', 'Home Insurance', 'Home Maintenance', 'Furniture / Appliances',
    'Income Protection', 'Other Home', 'Electricity', 'Gas / Water', 'Internet', 'Phone & Mobile', 'Other Utilities'],
  'Education & Health': ['School', 'Childcare', 'Uniforms', 'Sporting & Hobbies', 'Other Education',
    'Health Insurance', 'Life Insurance', 'Medical & Dental', 'Vet', 'Other Health'],
  'Groceries & Shopping': ['Groceries', 'Childcare Products', 'Hair Etc', 'Other Shopping'],
  'Vehicles & Transport': ['Car Insurance', 'Car Maintenance', 'Car Registration', 'Licence', 'Petrol',
    'Public Transport', 'Other Vehicle'],
  'Entertainment & Hobbies': ['Holidays', 'Parties', 'Movies & Music', 'Hobbies', 'Subscriptions', 'Other Entertainment'],
  'Uncategorised': ['Uncategorised'],
};

const CATEGORY_COLORS = ['#2563eb', '#0d9488', '#9333ea', '#16a34a', '#ea580c', '#db2777', '#64748b'];

function seed(db) {
  const addCat = db.prepare('INSERT INTO categories (name, color, sort_order) VALUES (?, ?, ?)');
  const addSub = db.prepare('INSERT INTO subcategories (category_id, name) VALUES (?, ?)');
  Object.entries(DEFAULT_CATEGORIES).forEach(([name, subs], i) => {
    const { lastInsertRowid } = addCat.run(name, CATEGORY_COLORS[i % CATEGORY_COLORS.length], i);
    for (const sub of subs) addSub.run(lastInsertRowid, sub);
  });
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

module.exports = { openDatabase, transaction, getSetting, setSetting };
