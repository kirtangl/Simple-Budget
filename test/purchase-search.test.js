'use strict';

// The Purchases page: search, warranty dots and the CSV export. Made-up household and shops.
const test = require('node:test');
const assert = require('node:assert/strict');
const budget = require('../src/budget');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');

// ---------- Warranty dots ----------

test('a warranty ends the day before the same date, and an extended one runs on from it', () => {
  assert.equal(budget.warrantyEnd('2026-10-25', 1, 'years'), '2027-10-24');
  assert.equal(budget.warrantyEnd('2026-10-25', 6, 'months'), '2027-04-24');
  assert.equal(budget.warrantyEnd('2026-10-25', 30, 'days'), '2026-11-23');
  assert.equal(budget.warrantyEnd('2026-10-25', null, 'years'), null);
  const p = { warranty_start: '2026-10-25', warranty_length: 2, warranty_unit: 'years' };
  assert.equal(budget.purchaseWarrantyEnd(p), '2028-10-24');
  assert.equal(budget.purchaseWarrantyEnd({ ...p, ext_length: 3, ext_unit: 'years' }), '2031-10-24');
  // Only an extended warranty: it runs from the start.
  assert.equal(budget.purchaseWarrantyEnd({ warranty_start: '2026-10-25', ext_length: 1, ext_unit: 'years' }), '2027-10-24');
  assert.equal(budget.purchaseWarrantyEnd({}), null);
});

test('the dot turns amber 3 months before the end, orange the day after, and red a year after', () => {
  const end = '2027-01-31';
  assert.equal(budget.warrantyStatus(end, '2026-10-30'), 'green');
  assert.equal(budget.warrantyStatus(end, '2026-10-31'), 'amber'); // 3 months to go
  assert.equal(budget.warrantyStatus(end, '2027-01-31'), 'amber'); // the last day it covers
  assert.equal(budget.warrantyStatus(end, '2027-02-01'), 'orange');
  assert.equal(budget.warrantyStatus(end, '2028-01-31'), 'orange'); // a year after
  assert.equal(budget.warrantyStatus(end, '2028-02-01'), 'red');
  assert.equal(budget.warrantyStatus(null, '2026-10-30'), null);
  // Short months: 3 months before 31 May is 28 Feb.
  assert.equal(budget.warrantyStatus('2027-05-31', '2027-02-27'), 'green');
  assert.equal(budget.warrantyStatus('2027-05-31', '2027-02-28'), 'amber');
});

test('existing purchases get their warranty end when the app updates', () => {
  const db = openDatabase(':memory:');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'purchases_type'").get());
  // Undo the migration's own fill, then run it again as an older database would.
  db.prepare("INSERT INTO purchases (name, amount_cents, purchased_at, clears_at, warranty_start, warranty_length, warranty_unit, ext_length, ext_unit, created_at, updated_at) VALUES ('Fridge', 99900, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-10', 2, 'years', 1, 'years', 'x', 'x')").run();
  require('../src/db').AFTER_MIGRATION[32](db);
  assert.equal(db.prepare("SELECT warranty_end FROM purchases WHERE name = 'Fridge'").get().warranty_end, '2029-01-09');
});

// ---------- Through the API ----------

async function withServer(fn) {
  const db = openDatabase(':memory:');
  const server = createApp({ db }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  const raw = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const call = async (method, p, body) => { const res = await raw(method, p, body); return { status: res.status, body: await res.json() }; };
  const login = async (password) => { await call('POST', '/logout'); return call('POST', '/login', { password }); };
  try {
    await call('POST', '/login', { password: 'simplebudget' });
    await call('POST', '/password', { password: 'household-pw' });
    await fn(call, { db, login, raw });
  } finally { server.close(); }
}
const search = (call, params = {}) => call('GET', `/purchases/search?${new URLSearchParams(params)}`);
const localNoon = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d, 12).toISOString(); };

test('filters combine, Not tracked stays out unless asked, and results page newest first', () => withServer(async (call) => {
  const acct = (await call('POST', '/accounts', { name: 'Everyday' })).body;
  const other = (await call('POST', '/accounts', { name: 'Bills' })).body;
  const types = Object.fromEntries((await call('GET', '/data')).body.purchase_types.map((t) => [t.name, t.id]));
  const add = (name, extra) => call('POST', '/purchases', { name, amount_cents: 1000, account_id: acct.id, purchased_at: localNoon('2026-08-01'), ...extra });
  await add('Laptop stand', { type_id: types['Work expense'], tax_deductible: true, shop: 'Example Office', purchased_at: localNoon('2026-07-05') });
  await add('Desk lamp', { type_id: types['Work expense'], notes: 'for the study', purchased_at: localNoon('2026-06-30'), account_id: other.id });
  await add('Glasses', { type_id: types.Medical, serial: 'XR-100', purchased_at: localNoon('2026-09-12') });
  await add('Milk', {}); // Not tracked

  let r = await search(call);
  assert.deepEqual(r.body.items.map((p) => p.name), ['Glasses', 'Laptop stand', 'Desk lamp']); // newest first, no Milk
  assert.deepEqual([r.body.count, r.body.total_cents], [3, 3000]);
  assert.equal((await search(call, { untracked: 1 })).body.count, 4);
  assert.deepEqual((await search(call, { types: `${types.Medical}` })).body.items.map((p) => p.name), ['Glasses']);
  assert.deepEqual((await search(call, { types: `${types.Medical}`, untracked: 1 })).body.items.map((p) => p.name), ['Glasses', 'Milk']);
  assert.deepEqual((await search(call, { tax: 1 })).body.items.map((p) => p.name), ['Laptop stand']);
  // Text looks in the name, shop, notes and serial; every word has to match.
  assert.deepEqual((await search(call, { q: 'office' })).body.items.map((p) => p.name), ['Laptop stand']);
  assert.deepEqual((await search(call, { q: 'STUDY' })).body.items.map((p) => p.name), ['Desk lamp']);
  assert.deepEqual((await search(call, { q: 'xr-1' })).body.items.map((p) => p.name), ['Glasses']);
  assert.equal((await search(call, { q: 'lamp office' })).body.count, 0);
  assert.equal((await search(call, { q: '%' })).body.count, 0); // a wildcard is just a character
  // Dates are whole local days: this financial year starts 1 July.
  assert.deepEqual((await search(call, { from: '2026-07-01', to: '2027-06-30' })).body.items.map((p) => p.name), ['Glasses', 'Laptop stand']);
  assert.deepEqual((await search(call, { from: '2025-07-01', to: '2026-06-30' })).body.items.map((p) => p.name), ['Desk lamp']);
  assert.deepEqual((await search(call, { to: '2026-07-05' })).body.items.map((p) => p.name), ['Laptop stand', 'Desk lamp']);
  assert.equal((await search(call, { from: 'soon' })).status, 400);
  assert.deepEqual((await search(call, { account: other.id })).body.items.map((p) => p.name), ['Desk lamp']);
  assert.deepEqual((await search(call, { account: other.id, types: `${types.Medical}` })).body.count, 0);
  // Paging: one page at a time, with the total of everything that matches.
  r = await search(call, { limit: 2 });
  assert.deepEqual([r.body.items.length, r.body.count], [2, 3]);
  assert.deepEqual((await search(call, { limit: 2, offset: 2 })).body.items.map((p) => p.name), ['Desk lamp']);
}));

test('the warranty filter matches the dots', () => withServer(async (call) => {
  const acct = (await call('POST', '/accounts', { name: 'Everyday' })).body;
  const [type] = (await call('GET', '/data')).body.purchase_types;
  const d = new Date();
  const ymd = (y, m, day) => new Date(Date.UTC(d.getFullYear() + y, d.getMonth() + m, d.getDate() + day)).toISOString().slice(0, 10);
  // A 1-day warranty ends on its start day, so the start is the end.
  const add = (name, end) => call('POST', '/purchases', { name, amount_cents: 1000, account_id: acct.id, purchased_at: localNoon(ymd(-2, 0, 0)), type_id: type.id,
    ...(end ? { warranty_start: end, warranty_length: 1, warranty_unit: 'days' } : {}) });
  await add('Green', ymd(0, 6, 0));
  await add('Amber', ymd(0, 1, 0));
  await add('Orange', ymd(0, -6, 0));
  await add('Red', ymd(-2, 0, 0));
  await add('None', null);
  const names = async (warranty) => (await search(call, { warranty })).body.items.map((p) => p.name).sort();
  assert.deepEqual(await names('green'), ['Green']);
  assert.deepEqual(await names('amber'), ['Amber']);
  assert.deepEqual(await names('orange'), ['Orange']);
  assert.deepEqual(await names('red'), ['Red']);
  assert.deepEqual(await names('none'), ['None']);
  assert.deepEqual(await names('covered'), ['Amber', 'Green']);
  for (const p of (await search(call)).body.items) assert.equal(p.warranty_status, p.name === 'None' ? null : p.name.toLowerCase());
  // The purchase itself carries its dot too.
  const one = (await search(call, { warranty: 'amber' })).body.items[0];
  assert.equal((await call('GET', `/purchases/${one.id}`)).body.warranty_status, 'amber');
}));

test("another login's private purchases never show on the Purchases page or in the export", () => withServer(async (call, { login, raw }) => {
  const acct = (await call('POST', '/accounts', { name: 'Everyday' })).body;
  const [type] = (await call('GET', '/data')).body.purchase_types;
  await call('POST', '/logins', { name: 'Sam', password: 'sams-password' });
  const base = { amount_cents: 5000, account_id: acct.id, purchased_at: localNoon('2026-09-01'), type_id: type.id };
  await call('POST', '/purchases', { ...base, name: 'Surprise gift', private: true, shop: 'Example Toys' });
  await call('POST', '/purchases', { ...base, name: 'My headphones' });
  await call('POST', '/purchases', { ...base, name: 'Doormat', owner_id: null });

  assert.equal((await search(call)).body.count, 3);
  assert.deepEqual((await search(call, { who: 'mine' })).body.items.map((p) => p.name).sort(), ['My headphones', 'Surprise gift']);
  assert.deepEqual((await search(call, { who: 'shared' })).body.items.map((p) => p.name), ['Doormat']);

  await login('sams-password');
  let r = await search(call);
  assert.deepEqual(r.body.items.map((p) => p.name).sort(), ['Doormat', 'My headphones']);
  assert.equal(r.body.total_cents, 10000);
  assert.equal((await search(call, { q: 'surprise' })).body.count, 0);
  assert.equal((await search(call, { q: 'toys' })).body.count, 0);
  assert.deepEqual((await search(call, { who: 'others' })).body.items.map((p) => p.name), ['My headphones']);
  assert.equal((await search(call, { who: 'mine' })).body.count, 0);
  const csv = await (await raw('GET', '/purchases/export.csv')).text();
  assert.ok(!csv.includes('Surprise'));
  assert.ok(csv.includes('My headphones'));
}));

test('the CSV export has the filtered rows, and nothing a spreadsheet would run', () => withServer(async (call, { raw }) => {
  const acct = (await call('POST', '/accounts', { name: 'Everyday' })).body;
  const types = Object.fromEntries((await call('GET', '/data')).body.purchase_types.map((t) => [t.name, t.id]));
  const base = { account_id: acct.id, purchased_at: localNoon('2026-09-01'), type_id: types['Work expense'], tax_deductible: true };
  await call('POST', '/purchases', { ...base, name: 'Monitor, 27"', amount_cents: 32950, shop: 'Example Office', warranty_start: '2026-09-01', warranty_length: 1, warranty_unit: 'years' });
  await call('POST', '/purchases', { ...base, name: '=HYPERLINK("x")', amount_cents: 100 });
  await call('POST', '/purchases', { ...base, name: 'Gift card', amount_cents: 5000, tax_deductible: false, type_id: types.Gift });
  const res = await raw('GET', '/purchases/export.csv?tax=1');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="simple-budget-purchases-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = (await res.text()).replace(/^\ufeff/, '').trim().split('\r\n');
  assert.equal(lines.length, 3); // the heading and the two tax deductible ones
  assert.match(lines[0], /^Date,Name,Amount,Account/);
  assert.ok(lines.some((l) => l.startsWith('2026-09-01,"Monitor, 27""",329.50,Everyday,Example Office,,,Work expense,Yes,Main,')));
  assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""x"")"`)));
  assert.ok(lines.find((l) => l.includes('Monitor')).includes('2027-08-31'));
}));

test('10,000 purchases: searches stay quick and match a plain filter of every row', () => withServer(async (call, { db, raw }) => {
  const accts = [(await call('POST', '/accounts', { name: 'Everyday' })).body.id, (await call('POST', '/accounts', { name: 'Bills' })).body.id];
  const types = (await call('GET', '/data')).body.purchase_types.map((t) => t.id);
  const shops = ['Example Hardware', 'Sample Chemist', 'Demo Electronics', 'Corner Grocer', 'Test Books'];
  const things = ['drill', 'bandages', 'cable', 'apples', 'novel', 'kettle', 'battery', 'shirt'];
  // A made-up household's three years of purchases, spread by a fixed pattern (no randomness).
  const rows = [];
  const start = Date.UTC(2023, 9, 1);
  const insert = db.prepare(`INSERT INTO purchases (name, amount_cents, account_id, purchased_at, clears_at, shop, type_id, tax_deductible, owner_id, private,
    warranty_start, warranty_length, warranty_unit, warranty_end, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  for (let i = 0; i < 10000; i++) {
    const at = new Date(start + i * 9.3 * 3600e3).toISOString();
    const warranty = i % 4 === 0 ? at.slice(0, 10) : null;
    const p = { name: `${things[i % things.length]} ${i}`, amount_cents: 100 + ((i * 37) % 50000), account_id: accts[i % 2], purchased_at: at, shop: shops[i % shops.length],
      type_id: i % 5 === 0 ? null : types[i % types.length], tax_deductible: i % 7 === 0 ? 1 : 0, owner_id: i % 3 === 0 ? null : 0, private: i % 11 === 0 && i % 3 !== 0 ? 1 : 0,
      warranty_start: warranty, warranty_length: warranty ? 1 + (i % 3) : null, warranty_unit: 'years' };
    p.warranty_end = budget.purchaseWarrantyEnd(p);
    insert.run(p.name, p.amount_cents, p.account_id, at, at, p.shop, p.type_id, p.tax_deductible, p.owner_id, p.private,
      p.warranty_start, p.warranty_length, p.warranty_unit, p.warranty_end, 0, at, at);
    rows.push(p);
  }
  db.exec('COMMIT');

  const today = budget.localDateOf(new Date().toISOString());
  const checks = [
    [{}, (p) => p.type_id != null],
    [{ untracked: 1 }, () => true],
    [{ types: `${types[1]},${types[2]}`, tax: 1 }, (p) => [types[1], types[2]].includes(p.type_id) && p.tax_deductible],
    [{ q: 'drill hardware' }, (p) => p.type_id != null && p.name.includes('drill') && p.shop.includes('Hardware')],
    [{ from: '2024-07-01', to: '2025-06-30', account: accts[1] }, (p) => p.type_id != null && p.account_id === accts[1]
      && budget.localDateOf(p.purchased_at) >= '2024-07-01' && budget.localDateOf(p.purchased_at) <= '2025-06-30'],
    [{ warranty: 'covered', untracked: 1 }, (p) => p.warranty_end && p.warranty_end >= today],
    [{ who: 'shared', q: 'kettle' }, (p) => p.type_id != null && p.owner_id === null && p.name.includes('kettle')],
  ];
  for (const [params, keep] of checks) {
    const want = rows.filter(keep);
    const t0 = performance.now();
    const r = await search(call, { ...params, limit: 50 });
    const ms = performance.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(r.body.count, want.length, JSON.stringify(params));
    assert.equal(r.body.total_cents, want.reduce((s, p) => s + p.amount_cents, 0), JSON.stringify(params));
    assert.equal(r.body.items.length, Math.min(50, want.length));
    // Newest first.
    assert.deepEqual(r.body.items.map((p) => p.purchased_at), [...r.body.items.map((p) => p.purchased_at)].sort().reverse());
    assert.ok(ms < 500, `${JSON.stringify(params)} took ${Math.round(ms)}ms`);
  }
  // The deepest page, and the whole export, are quick too.
  let t0 = performance.now();
  const last = await search(call, { untracked: 1, limit: 100, offset: 9900 });
  assert.equal(last.body.items.length, 100);
  assert.ok(performance.now() - t0 < 500);
  t0 = performance.now();
  const csv = await (await raw('GET', '/purchases/export.csv?untracked=1')).text();
  assert.equal(csv.trim().split('\r\n').length, 10001);
  assert.ok(performance.now() - t0 < 3000);
}));

test('the search lines and the dots agree on every day for three years', () => {
  const ends = ['2027-01-31', '2027-02-28', '2027-05-31', '2027-11-30', '2028-02-29', '2028-03-01', '2027-08-15'];
  for (let day = '2026-06-01'; day <= '2029-06-01'; day = budget.addDays(day, 1)) {
    const cut = budget.warrantyCuts(day);
    for (const end of ends) {
      const bySearch = end > cut.amber ? 'green' : end >= cut.today ? 'amber' : end >= cut.orange ? 'orange' : 'red';
      assert.equal(bySearch, budget.warrantyStatus(end, day), `${end} on ${day}`);
    }
  }
});
