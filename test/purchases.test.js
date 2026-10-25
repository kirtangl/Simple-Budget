'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const budget = require('../src/budget');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');

// Fortnights from Tue 6 Oct 2026: 6–19 Oct, then 20 Oct – 2 Nov. Made-up household.
const ANCHOR = '2026-10-06';
const accounts = [{ id: 1, name: 'Everyday' }, { id: 2, name: 'Bills' }];
const expenses = [{ id: 1, name: 'Groceries', account_id: 1, frequency: 'fortnightly', active: 1, amount_cents: 30000, day_offset: 2 }];
// A moment on the server's own clock, like 18 Oct at 6pm.
const at = (date, hour, min = 0) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d, hour, min).toISOString(); };
let nextId = 1;
const buy = (purchasedAt, mode, extra = {}) => {
  const p = { id: nextId++, name: 'Kettle', amount_cents: 8000, account_id: 1, purchased_at: purchasedAt, clear_mode: mode, exclude: 0, private: 0, ...extra };
  p.clears_at = mode === 'custom' ? extra.clears_at : budget.clearsAtFor(purchasedAt, mode);
  return p;
};
const cycle = (index, oneoffs, now) => budget.buildCycle({ anchor: ANCHOR, index, today: budget.localDateOf(now), expenses, accounts, incomes: [], oneoffs, now });
const everyday = (c) => c.accounts.find((a) => a.account_id === 1);
const held = (pending, today) => budget.heldEstimates(expenses, accounts, { today, anchor: ANCHOR, pending })[0];

test('a once-off never changes the deposit; it lowers Left over (Extra) in the fortnight it was bought', () => {
  const now = at('2026-10-10', 11);
  const before = everyday(cycle(0, [], now));
  const c = cycle(0, [buy(at('2026-10-10', 10), 'instant')], now);
  const a = everyday(c);
  assert.equal(a.deposit_cents, before.deposit_cents);
  assert.equal(a.spare_cents, before.spare_cents - 8000);
  assert.equal(a.oneoff_cents, 8000);
  assert.equal(a.bills_cents, before.bills_cents); // the bills themselves are unchanged
  assert.equal(c.totals.bills_cents, cycle(0, [], now).totals.bills_cents + 8000);
  assert.equal(c.totals.oneoffs_cents, 8000);
});

test('Instant is paid straight away and never shows in the next fortnight', () => {
  const p = buy(at('2026-10-19', 22), 'instant');
  const [row] = cycle(0, [p], at('2026-10-19', 22, 30)).bills.filter((b) => b.kind === 'oneoff');
  assert.equal(row.status, 'paid');
  assert.equal(row.counted, true);
  assert.equal(cycle(1, [p], at('2026-10-21', 9)).bills.some((b) => b.kind === 'oneoff'), false);
  assert.deepEqual(budget.pendingAt([p], at('2026-10-19', 22, 30)), []);
});

test('24h is pending until a day later, and Keep in account holds it until then', () => {
  const p = buy(at('2026-10-10', 10), '24h');
  assert.equal(p.clears_at, at('2026-10-11', 10));
  let [row] = cycle(0, [p], at('2026-10-10', 12)).bills.filter((b) => b.kind === 'oneoff');
  assert.equal(row.status, 'pending');
  [row] = cycle(0, [p], at('2026-10-11', 11)).bills.filter((b) => b.kind === 'oneoff');
  assert.equal(row.status, 'paid');

  const base = held([], '2026-10-10').held_cents;
  const waiting = held(budget.pendingAt([p], at('2026-10-10', 12)), '2026-10-10');
  assert.equal(waiting.held_cents, base + 8000);
  assert.equal(waiting.pending_cents, 8000);
  assert.equal(held(budget.pendingAt([p], at('2026-10-11', 11)), '2026-10-11').pending_cents, 0);
});

test('48h added 30 hours before the fortnight ends: counted once, greyed in the next, and held until it clears', () => {
  // The fortnight ends at midnight going into Tue 20 Oct; 30 hours before is Sun 18 Oct, 6pm.
  const p = buy(at('2026-10-18', 18), '48h');
  assert.equal(p.clears_at, at('2026-10-20', 18));

  const now = at('2026-10-19', 9);
  const first = cycle(0, [p], now);
  const [row] = first.bills.filter((b) => b.kind === 'oneoff');
  assert.deepEqual([row.date, row.status, row.counted, row.carried], ['2026-10-18', 'pending', true, false]);
  assert.equal(everyday(first).spare_cents, everyday(cycle(0, [], now)).spare_cents - 8000);

  // In the next fortnight it shows by the day it clears, greyed, and isn't counted again.
  const later = at('2026-10-20', 9);
  const second = cycle(1, [p], later);
  const [carried] = second.bills.filter((b) => b.kind === 'oneoff');
  assert.deepEqual([carried.date, carried.bought_on, carried.status, carried.counted, carried.carried, carried.is_expense],
    ['2026-10-20', '2026-10-18', 'pending', false, true, false]);
  assert.equal(everyday(second).spare_cents, everyday(cycle(1, [], later)).spare_cents);
  assert.equal(everyday(second).oneoff_cents, 0);
  assert.equal(second.totals.bills_cents, cycle(1, [], later).totals.bills_cents);

  // Keep in account holds it across both fortnights, until 6pm on the 20th.
  assert.equal(held(budget.pendingAt([p], now), '2026-10-19').held_cents, held([], '2026-10-19').held_cents + 8000);
  assert.equal(held(budget.pendingAt([p], later), '2026-10-20').pending_cents, 8000);
  assert.equal(held(budget.pendingAt([p], at('2026-10-20', 19)), '2026-10-20').pending_cents, 0);
  // Once it's cleared, it shows as paid in the new fortnight.
  assert.equal(cycle(1, [p], at('2026-10-20', 19)).bills.find((b) => b.kind === 'oneoff').status, 'paid');
});

test('a custom clearing time across the fortnight boundary', () => {
  const p = buy(at('2026-10-15', 14), 'custom', { clears_at: at('2026-10-21', 9) });
  const first = cycle(0, [p], at('2026-10-16', 9)).bills.find((b) => b.kind === 'oneoff');
  assert.deepEqual([first.status, first.counted, first.clears_at], ['pending', true, at('2026-10-21', 9)]);
  const second = cycle(1, [p], at('2026-10-22', 9)).bills.find((b) => b.kind === 'oneoff');
  assert.deepEqual([second.date, second.status, second.carried, second.counted], ['2026-10-21', 'paid', true, false]);
  assert.equal(budget.pendingAt([p], at('2026-10-20', 12)).length, 1);
  // One that clears within its own fortnight doesn't show in the next.
  const soon = buy(at('2026-10-15', 14), 'custom', { clears_at: at('2026-10-17', 9) });
  assert.equal(cycle(1, [soon], at('2026-10-22', 9)).bills.some((b) => b.kind === 'oneoff'), false);
});

test("an excluded once-off is only a record: no change to Left over or Keep in account", () => {
  const p = buy(at('2026-10-18', 18), '48h', { exclude: 1 });
  const now = at('2026-10-19', 9);
  const c = cycle(0, [p], now);
  const row = c.bills.find((b) => b.kind === 'oneoff');
  assert.deepEqual([row.excluded, row.counted, row.is_expense], [true, false, false]);
  assert.equal(everyday(c).spare_cents, everyday(cycle(0, [], now)).spare_cents);
  assert.equal(c.totals.bills_cents, cycle(0, [], now).totals.bills_cents);
  assert.deepEqual(budget.pendingAt([p], now), []);
  // And it isn't carried into the next fortnight.
  assert.equal(cycle(1, [p], at('2026-10-20', 9)).bills.some((b) => b.kind === 'oneoff'), false);
});

test('purchases and tracked types come from a migration, with the four starting types', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(db.prepare('SELECT name FROM purchase_types ORDER BY sort_order').all().map((t) => t.name), ['Personal', 'Work expense', 'Medical', 'Gift']);
  const cols = db.prepare('PRAGMA table_info(purchases)').all().map((c) => c.name);
  for (const c of ['purchased_at', 'clears_at', 'clear_mode', 'exclude', 'private', 'owner_id', 'warranty_start', 'ext_provider', 'keep_forever', 'tax_deductible']) assert.ok(cols.includes(c), c);
  assert.throws(() => db.prepare("INSERT INTO purchases (name, amount_cents, purchased_at, clears_at, clear_mode, created_at, updated_at) VALUES ('x', 1, 'a', 'a', 'weekly', 'a', 'a')").run());
});

// ---------- Through the API ----------

async function withServer(fn) {
  const db = openDatabase(':memory:');
  const server = createApp({ db }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  const login = async (password) => { await call('POST', '/logout'); return call('POST', '/login', { password }); };
  try {
    await call('POST', '/login', { password: 'simplebudget' });
    await call('POST', '/password', { password: 'household-pw' });
    await fn(call, { db, login });
  } finally { server.close(); }
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();

test('adding, editing and deleting a once-off, with its clearing time worked out', () => withServer(async (call) => {
  const acct = (await call('POST', '/accounts', { name: 'Everyday' })).body;
  let r = await call('POST', '/purchases', { name: 'Headphones', amount_cents: 12900, account_id: acct.id, purchased_at: hoursAgo(1), clear_mode: '24h' });
  assert.equal(r.status, 201);
  const p = r.body;
  assert.equal(Date.parse(p.clears_at) - Date.parse(p.purchased_at), 24 * 3600e3);
  assert.equal(p.owner_id, 0); // the main login's own unless it's set to Shared
  let data = (await call('GET', '/data')).body;
  assert.deepEqual(data.oneoffs.map((b) => [b.name, b.status, b.counted]), [['Headphones', 'pending', true]]);
  assert.equal(data.purchase_types.length, 4);

  // Keep in account holds it while it's pending.
  const c = (await call('GET', '/cycle?offset=0')).body;
  const a = c.accounts.find((x) => x.account_id === acct.id);
  assert.equal(a.pending_cents, 12900);
  assert.ok(a.held_cents >= 12900);
  assert.equal(a.spare_cents, a.deposit_cents - 12900);

  r = await call('PATCH', `/purchases/${p.id}`, { clear_mode: 'instant', shop: 'Example Electronics', warranty_start: '2026-10-25', warranty_length: 1, warranty_unit: 'years' });
  assert.equal(r.status, 200);
  assert.equal(r.body.clears_at, r.body.purchased_at);
  assert.equal(r.body.shop, 'Example Electronics');
  assert.equal((await call('GET', '/cycle?offset=0')).body.accounts.find((x) => x.account_id === acct.id).pending_cents, 0);

  // What a once-off has to have, and what it can't be.
  const good = { name: 'Mug', amount_cents: 1500, account_id: acct.id, purchased_at: hoursAgo(1) };
  assert.equal((await call('POST', '/purchases', { ...good, amount_cents: 0 })).status, 400);
  assert.equal((await call('POST', '/purchases', { ...good, account_id: 999 })).status, 400);
  assert.equal((await call('POST', '/purchases', { ...good, clear_mode: 'custom' })).status, 400);
  assert.equal((await call('POST', '/purchases', { ...good, clear_mode: 'custom', clears_at: hoursAgo(5) })).status, 400);
  assert.equal((await call('POST', '/purchases', { ...good, link: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call('POST', '/purchases', { ...good, purchased_at: 'soon' })).status, 400);
  // A goal is only kept for one that isn't counted.
  const goal = (await call('POST', '/goals', { kind: 'goal', name: 'New console', target_cents: 70000 })).body;
  assert.equal((await call('POST', '/purchases', { ...good, goal_id: goal.id })).body.goal_id, null);
  assert.equal((await call('POST', '/purchases', { ...good, exclude: true, goal_id: goal.id })).body.goal_id, goal.id);

  assert.equal((await call('DELETE', `/purchases/${p.id}`)).status, 200);
  data = (await call('GET', '/data')).body;
  assert.equal(data.oneoffs.some((b) => b.name === 'Headphones'), false);
  assert.equal((await call('GET', `/purchases/${p.id}`)).status, 404);
}));

test('the Private tick hides a once-off from the other login, but their deposits still include it', () => withServer(async (call, { login }) => {
  const acct = (await call('POST', '/accounts', { name: 'Everyday' })).body;
  await call('POST', '/logins', { name: 'Sam', password: 'sams-password' });
  const secret = (await call('POST', '/purchases', { name: 'Birthday present', amount_cents: 6000, account_id: acct.id, purchased_at: hoursAgo(2), clear_mode: '48h', private: true, shop: 'Example Toys' })).body;
  await call('POST', '/purchases', { name: 'Bin bags', amount_cents: 900, account_id: acct.id, purchased_at: hoursAgo(2), owner_id: null });
  const mine = (await call('GET', '/data')).body.oneoffs;
  assert.deepEqual(mine.map((b) => b.name).sort(), ['Bin bags', 'Birthday present']);

  await login('sams-password');
  const theirs = (await call('GET', '/data')).body.oneoffs;
  assert.equal(theirs.some((b) => b.purchase_id === secret.id), false);
  assert.ok(theirs.some((b) => b.name === 'Bin bags'));
  assert.equal((await call('GET', `/purchases/${secret.id}`)).status, 404);
  assert.equal((await call('PATCH', `/purchases/${secret.id}`, { name: 'Peek' })).status, 404);
  assert.equal((await call('DELETE', `/purchases/${secret.id}`)).status, 404);
  // The money left the account either way, so Sam's numbers include it.
  const c = (await call('GET', '/cycle?offset=0')).body;
  const a = c.accounts.find((x) => x.account_id === acct.id);
  assert.equal(a.oneoff_cents, 6900);
  assert.equal(a.pending_cents, 6000); // Keep in account still holds it, without naming it
  assert.deepEqual(c.bills.filter((b) => b.kind === 'oneoff').map((b) => b.name), ['Bin bags']);
  assert.ok(!JSON.stringify(c).includes('Birthday'));

  await login('household-pw');
  assert.equal((await call('GET', `/purchases/${secret.id}`)).body.name, 'Birthday present');
}));

test('a removed login’s private once-offs become shared, so nobody loses sight of them', () => withServer(async (call, { db, login }) => {
  const acct = (await call('POST', '/accounts', { name: 'Everyday' })).body;
  await call('POST', '/logins', { name: 'Sam', password: 'sams-password' });
  const samId = db.prepare("SELECT id FROM logins WHERE name = 'Sam'").get().id;
  await login('sams-password');
  const p = (await call('POST', '/purchases', { name: 'Book', amount_cents: 2500, account_id: acct.id, purchased_at: hoursAgo(1), private: true })).body;
  await login('household-pw');
  assert.equal((await call('GET', `/purchases/${p.id}`)).status, 404);
  assert.equal((await call('DELETE', `/logins/${samId}`)).status, 200);
  const after = (await call('GET', `/purchases/${p.id}`)).body;
  assert.deepEqual([after.owner_id, after.private], [null, 0]);
}));

test('once-offs and tracked types go in the backup, and an older backup leaves them alone', () => withServer(async (call) => {
  const acct = (await call('POST', '/accounts', { name: 'Everyday' })).body;
  const cat = (await call('POST', '/categories', { name: 'Home' })).body;
  const sub = (await call('POST', '/subcategories', { name: 'Kitchen', category_id: cat.id })).body;
  const type = (await call('POST', '/purchase_types', { name: 'Hobby', sort_order: 5 })).body;
  await call('POST', '/purchases', { name: 'Toaster', amount_cents: 4900, account_id: acct.id, purchased_at: hoursAgo(3), clear_mode: '48h',
    category_id: cat.id, subcategory_id: sub.id, type_id: type.id, tax_deductible: true, warranty_length: 2, warranty_unit: 'years', private: true });
  const file = (await call('GET', '/export')).body;
  assert.equal(file.purchases.length, 1);
  assert.ok(file.purchase_types.some((t) => t.name === 'Hobby'));

  // Restoring the file puts them back, linked to the restored account, category and type.
  await call('DELETE', `/purchase_types/${type.id}`);
  let r = await call('POST', '/import', file);
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.purchases, 1);
  const p = (await call('GET', '/data')).body.oneoffs[0];
  const full = (await call('GET', `/purchases/${p.purchase_id}`)).body;
  const data = (await call('GET', '/data')).body;
  assert.equal(full.account_id, data.accounts[0].id);
  assert.equal(full.category_id, data.categories.find((c) => c.name === 'Home').id);
  assert.equal(full.subcategory_id, data.categories.find((c) => c.name === 'Home').subcategories[0].id);
  assert.equal(data.purchase_types.find((t) => t.id === full.type_id).name, 'Hobby');
  assert.deepEqual([full.clear_mode, full.tax_deductible, full.private, full.owner_id, full.warranty_length], ['48h', 1, 1, 0, 2]);
  assert.equal(full.clears_at, file.purchases[0].clears_at);

  // A backup from before 0.9.14 has no once-offs: they're kept, and stay on their account (matched by name).
  const old = { ...file };
  delete old.purchases;
  delete old.purchase_types;
  r = await call('POST', '/import', old);
  assert.equal(r.status, 200);
  const kept = (await call('GET', '/data')).body;
  assert.equal(kept.oneoffs.length, 1);
  assert.equal((await call('GET', `/purchases/${kept.oneoffs[0].purchase_id}`)).body.account_id, kept.accounts[0].id);
  assert.ok(kept.purchase_types.some((t) => t.name === 'Hobby'));
}));
