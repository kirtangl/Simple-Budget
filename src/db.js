'use strict';

// All money is stored as integer cents to avoid floating point rounding.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// An account with no colour of its own is shown in the palette colour for its place in the list
// (public/app.js PALETTE). This saves that colour on it, so moving or removing an account
// doesn't hand the others new colours.
const ACCOUNT_PALETTE = ['#0f766e', '#2563eb', '#9333ea', '#ea580c', '#db2777', '#16a34a', '#ca8a04', '#0891b2', '#64748b', '#dc2626'];
const FILL_ACCOUNT_COLOURS = `
  WITH placed AS (SELECT id, (ROW_NUMBER() OVER (ORDER BY sort_order, name COLLATE NOCASE) - 1) % ${ACCOUNT_PALETTE.length} AS i FROM accounts)
  UPDATE accounts SET color = CASE (SELECT i FROM placed WHERE placed.id = accounts.id)
    ${ACCOUNT_PALETTE.map((c, i) => `WHEN ${i} THEN '${c}'`).join(' ')} END
  WHERE color IS NULL OR color = '';
`;
const fillAccountColours = (db) => db.exec(FILL_ACCOUNT_COLOURS);

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
  // 14: price reviews on expenses, and a log of amounts over time for expenses and loans.
  // Each change is one row per field; a second change on the same day replaces the first.
  `
  ALTER TABLE expenses ADD COLUMN review_date TEXT;
  ALTER TABLE expenses ADD COLUMN review_snooze TEXT;
  CREATE TABLE amount_history (
    id         INTEGER PRIMARY KEY,
    kind       TEXT    NOT NULL CHECK (kind IN ('expense', 'loan')),
    item_id    INTEGER NOT NULL,
    field      TEXT    NOT NULL,
    on_date    TEXT    NOT NULL,
    value      NUMERIC NOT NULL,
    frequency  TEXT,
    login_id   INTEGER
  );
  CREATE INDEX amount_history_item ON amount_history (kind, item_id, field, on_date);
  INSERT INTO amount_history (kind, item_id, field, on_date, value, frequency)
    SELECT 'expense', id, 'amount_cents', date('now', 'localtime'), amount_cents, frequency FROM expenses;
  INSERT INTO amount_history (kind, item_id, field, on_date, value, frequency)
    SELECT 'loan', id, 'repayment_cents', date('now', 'localtime'), repayment_cents, repayment_frequency FROM loans WHERE repayment_cents IS NOT NULL;
  INSERT INTO amount_history (kind, item_id, field, on_date, value)
    SELECT 'loan', id, 'balance_cents', coalesce(balance_date, date('now', 'localtime')), balance_cents FROM loans WHERE balance_cents IS NOT NULL;
  INSERT INTO amount_history (kind, item_id, field, on_date, value)
    SELECT 'loan', id, 'interest_rate', date('now', 'localtime'), interest_rate FROM loans WHERE interest_rate IS NOT NULL;
  `,
  // 15: a price change set for a future date waits in pending_* until then, and a
  // balance update keeps what the estimate was just before it (before_value).
  `
  ALTER TABLE expenses ADD COLUMN pending_cents INTEGER;
  ALTER TABLE expenses ADD COLUMN pending_from TEXT;
  ALTER TABLE amount_history ADD COLUMN before_value NUMERIC;
  `,
  // 16: who made each history change was recorded but never shown, and wasn't cleared when
  // a login was removed. It's no longer kept (the column stays, empty).
  `
  UPDATE amount_history SET login_id = NULL;
  `,
  // 17: "Log out everywhere" bumps a login's session_gen, which every login cookie is signed with.
  `
  ALTER TABLE logins ADD COLUMN session_gen INTEGER NOT NULL DEFAULT 0;
  `,
  // 18: accounts keep the colour they're shown in now, whatever order they're put in later.
  FILL_ACCOUNT_COLOURS,
  // 19: the shopping list. Locations are the household's stores (a chain and a suburb). A product's
  // spot at a location is a numbered aisle or one of that location's named sections, or "not sold here".
  // Prices are per chain. A list item with no owner is on the shared list, otherwise on that login's own.
  `
  CREATE TABLE shop_locations (
    id INTEGER PRIMARY KEY,
    store TEXT NOT NULL CHECK (store IN ('woolworths', 'coles', 'aldi')),
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (store, name COLLATE NOCASE)
  );
  CREATE TABLE shop_sections (
    id INTEGER PRIMARY KEY,
    location_id INTEGER NOT NULL REFERENCES shop_locations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    UNIQUE (location_id, name COLLATE NOCASE)
  );
  CREATE TABLE shop_products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE shop_prices (
    product_id INTEGER NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
    store TEXT NOT NULL CHECK (store IN ('woolworths', 'coles', 'aldi')),
    price_cents INTEGER NOT NULL,
    PRIMARY KEY (product_id, store)
  );
  CREATE TABLE shop_spots (
    product_id INTEGER NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES shop_locations(id) ON DELETE CASCADE,
    aisle INTEGER,
    section_id INTEGER REFERENCES shop_sections(id) ON DELETE CASCADE,
    missing INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, location_id)
  );
  CREATE TABLE shop_items (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
    owner_id INTEGER,
    qty INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX shop_items_owner ON shop_items (owner_id);
  `,
];

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  // reset-password.js opens its own connection while the app runs: wait for a save to finish rather than fail.
  db.exec('PRAGMA busy_timeout = 5000;');
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
    // SQLite may have rolled back already (a full disk, say); the first error is the one that matters.
    try { db.exec('ROLLBACK'); } catch { /* nothing left to roll back */ }
    throw err;
  }
}

// Settings are read many times a request, so their statements are prepared once per database.
const settingStatements = new WeakMap();
function settingStatement(db, which) {
  if (!settingStatements.has(db)) {
    settingStatements.set(db, {
      get: db.prepare('SELECT value FROM settings WHERE key = ?'),
      set: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    });
  }
  return settingStatements.get(db)[which];
}

function getSetting(db, key) {
  const row = settingStatement(db, 'get').get(key);
  return row ? row.value : undefined;
}

function setSetting(db, key, value) {
  settingStatement(db, 'set').run(key, value);
}

module.exports = { openDatabase, transaction, getSetting, setSetting, fillAccountColours };
