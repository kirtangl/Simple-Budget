'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');

// Logs in as main and sets a new password, then hands over a caller that keeps its cookie.
async function withServer(options, fn) {
  const app = createApp({ db: openDatabase(':memory:'), ...options });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const caller = () => {
    let cookie = '';
    return async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      if (headers['x-raw']) return { status: res.status, type: (res.headers.get('content-type') || '').split(';')[0], size: (await res.arrayBuffer()).byteLength };
      return { status: res.status, body: await res.json() };
    };
  };
  const call = caller();
  try {
    await call('POST', '/login', { password: 'simplebudget' });
    await call('POST', '/password', { password: 'household-pw' });
    await fn(call, caller);
  } finally { server.close(); }
}

// The built-in stores, by name.
const storesOf = async (call) => Object.fromEntries((await call('GET', '/shop')).body.stores.map((s) => [s.name, s.id]));
// A response that isn't JSON (a picture), through the same logged-in caller's cookie.
const fetchRaw = (call, path) => call('GET', path, undefined, { 'x-raw': '1' });

test('shopping: add by name, tick off, untick, and clear', () => withServer({}, async (call) => {
  let r = await call('POST', '/shop/items', { list: 'shared', name: '  Milk ' });
  assert.equal(r.status, 201);
  const milk = r.body.product_id;
  // The same name in other capitals is the same product, and adds to how many.
  r = await call('POST', '/shop/items', { list: 'shared', name: 'milk' });
  assert.deepEqual([r.status, r.body.product_id, r.body.qty], [200, milk, 2]);
  const bread = (await call('POST', '/shop/items', { list: 'shared', name: 'Bread' })).body;
  let shop = (await call('GET', '/shop?list=shared')).body;
  assert.deepEqual(shop.products.map((p) => p.name), ['Bread', 'Milk']);
  const milkItem = shop.items.find((i) => i.product_id === milk);

  // Ticked off: it stays on the list, marked done by whoever did it, and leaves the count.
  r = await call('PATCH', `/shop/items/${milkItem.id}`, { done: true });
  assert.ok(r.body.done_at);
  shop = (await call('GET', '/shop?list=shared')).body;
  assert.equal(shop.items.length, 2);
  assert.equal(shop.items.find((i) => i.id === milkItem.id).done_by_name, 'Main');
  assert.equal(shop.counts.shared, 1);
  // Unticked by mistake, then ticked again.
  r = await call('PATCH', `/shop/items/${milkItem.id}`, { done: false });
  assert.deepEqual([r.body.done_at, r.body.done_by], [null, null]);
  await call('PATCH', `/shop/items/${milkItem.id}`, { done: true });
  // Adding something ticked off puts it back, unticked.
  r = await call('POST', '/shop/items', { list: 'shared', product_id: milk, qty: 3 });
  assert.deepEqual([r.body.qty, r.body.done_at], [3, null]);
  await call('PATCH', `/shop/items/${milkItem.id}`, { done: true });

  // Clearing takes only what's ticked; the rest stays for later.
  r = await call('POST', '/shop/items/clear', { list: 'shared' });
  assert.equal(r.body.cleared, 1);
  shop = (await call('GET', '/shop?list=shared')).body;
  assert.deepEqual(shop.items.map((i) => i.id), [bread.id]);
  assert.equal(shop.products.length, 2);

  assert.equal((await call('POST', '/shop/items', { list: 'shared', name: ' ' })).body.error, "The item can't be empty.");
  assert.equal((await call('POST', '/shop/items', { list: 'shared', product_id: 999 })).status, 400);
  assert.equal((await call('POST', '/shop/items', { list: 'someone', name: 'Bread' })).status, 400);
}));

test('shopping: the shared list and each login\'s own list', () => withServer({}, async (call, caller) => {
  await call('POST', '/logins', { name: 'Sam', password: 'sams-password' });
  const sam = caller();
  await sam('POST', '/login', { password: 'sams-password' });
  const bread = (await call('POST', '/shop/items', { list: 'shared', name: 'Bread' })).body;
  await call('POST', '/shop/items', { list: 'mine', name: 'Coffee' });
  const samsOwn = (await sam('POST', '/shop/items', { list: 'mine', name: 'Tea' })).body;
  const main = (await call('GET', '/shop?list=mine')).body;
  assert.deepEqual(main.counts, { shared: 1, mine: 1 });
  assert.equal(main.products.find((p) => p.id === main.items[0].product_id).name, 'Coffee');
  // Products are shared by every list.
  assert.deepEqual(main.products.map((p) => p.name), ['Bread', 'Coffee', 'Tea']);
  const sams = (await sam('GET', '/shop?list=mine')).body;
  assert.deepEqual(sams.items.map((i) => i.id), [samsOwn.id]);
  // Sam ticks off something on the shared list at Coles, and everyone sees who, in Sam's colour, and where.
  const coles = main.stores.find((s) => s.name === 'Coles').id;
  await call('PATCH', '/logins/' + (await call('GET', '/logins')).body.find((l) => l.name === 'Sam').id, { colour: '#aa3300' });
  await sam('PATCH', `/shop/items/${bread.id}`, { done: true, store_id: coles });
  let ticked = (await call('GET', '/shop?list=shared')).body.items[0];
  assert.deepEqual([ticked.done_by_name, ticked.done_by_colour, ticked.done_store_id], ['Sam', '#aa3300', coles]);
  await sam('PATCH', `/shop/items/${bread.id}`, { done: false });
  ticked = (await call('GET', '/shop?list=shared')).body.items[0];
  assert.deepEqual([ticked.done_by, ticked.done_store_id], [null, null]);
  await sam('PATCH', `/shop/items/${bread.id}`, { done: true, store_id: 999 });
  assert.equal((await call('GET', '/shop?list=shared')).body.items[0].done_store_id, null);
  // Someone else's own list can't be changed.
  assert.equal((await call('PATCH', `/shop/items/${samsOwn.id}`, { qty: 3 })).status, 404);
  assert.equal((await call('DELETE', `/shop/items/${samsOwn.id}`)).status, 404);
  assert.equal((await sam('PATCH', `/shop/items/${samsOwn.id}`, { qty: 3 })).body.qty, 3);
  assert.equal((await sam('PATCH', `/shop/items/${samsOwn.id}`, { qty: 0 })).status, 400);
}));

test('shopping: changes move the revision on, so open lists refresh', () => withServer({}, async (call) => {
  const before = (await call('GET', '/shop/rev')).body.rev;
  assert.equal((await call('GET', '/shop')).body.rev, before);
  await call('POST', '/shop/items', { name: 'Eggs' });
  const after = (await call('GET', '/shop/rev')).body.rev;
  assert.ok(after > before);
  // A refused change doesn't.
  await call('POST', '/shop/items', { name: '' });
  assert.equal((await call('GET', '/shop/rev')).body.rev, after);
}));

test('shopping: stores, locations, sections, aisles, sizes and prices', () => withServer({}, async (call) => {
  const stores = await storesOf(call);
  assert.deepEqual(Object.keys(stores), ['Woolworths', 'Coles', 'Aldi']);
  // A store of the household's own.
  const iga = (await call('POST', '/shop/stores', { name: 'IGA' })).body;
  assert.equal((await call('POST', '/shop/stores', { name: 'iga' })).status, 400);
  assert.equal((await call('PATCH', `/shop/stores/${iga.id}`, { name: 'IGA Xpress' })).body.name, 'IGA Xpress');

  const vincent = (await call('POST', '/shop/locations', { store_id: stores.Woolworths, name: 'Vincent' })).body;
  const castletown = (await call('POST', '/shop/locations', { store_id: stores.Woolworths, name: 'Castletown' })).body;
  const town = (await call('POST', '/shop/locations', { store_id: iga.id, name: 'Town' })).body;
  assert.equal((await call('POST', '/shop/locations', { store_id: 999, name: 'Town' })).body.error, 'Pick a store.');
  assert.equal((await call('POST', '/shop/locations', { store_id: stores.Woolworths, name: 'vincent' })).status, 400);
  let shop = (await call('GET', '/shop')).body;
  const sections = shop.sections.filter((s) => s.location_id === vincent.id);
  // The sections before Aisle 1 are 0.1, 0.2 ... so they can be put in order.
  assert.deepEqual(sections.map((s) => [s.name, s.position]),
    [['Produce', 0.1], ['Bakery', 0.2], ['Deli', 0.3], ['Meat', 0.4], ['Dairy', 21.1], ['Freezer', 21.2]]);
  const produce = sections.find((s) => s.name === 'Produce');

  const item = (await call('POST', '/shop/items', { name: 'Apples' })).body;
  const id = item.product_id;
  // Aisle 1 at one location, Aisle 2 at another; a section at a third; not sold at a fourth.
  let p = (await call('PUT', `/shop/products/${id}/spot`, { location_id: vincent.id, aisle: 1 })).body;
  assert.deepEqual(p.spots[vincent.id], { aisle: 1, section_id: null, missing: false });
  p = (await call('PUT', `/shop/products/${id}/spot`, { location_id: castletown.id, aisle: 2 })).body;
  assert.deepEqual(p.spots[vincent.id], { aisle: 1, section_id: null, missing: false });
  assert.deepEqual(p.spots[castletown.id], { aisle: 2, section_id: null, missing: false });
  p = (await call('PUT', `/shop/products/${id}/spot`, { location_id: vincent.id, section_id: produce.id })).body;
  assert.deepEqual(p.spots[vincent.id], { aisle: null, section_id: produce.id, missing: false });
  assert.equal((await call('PUT', `/shop/products/${id}/spot`, { location_id: castletown.id, section_id: produce.id })).status, 400);
  assert.equal((await call('PUT', `/shop/products/${id}/spot`, { location_id: vincent.id, aisle: 21 })).status, 400);
  p = (await call('PUT', `/shop/products/${id}/spot`, { location_id: town.id, missing: true })).body;
  assert.equal(p.spots[town.id].missing, true);
  p = (await call('PUT', `/shop/products/${id}/spot`, { location_id: town.id })).body;
  assert.equal(p.spots[town.id], undefined);

  // A section's order takes decimals, and removing it sends its products back to unsorted.
  assert.equal((await call('PATCH', `/shop/sections/${produce.id}`, { position: 0.25 })).body.position, 0.25);
  assert.equal((await call('PATCH', `/shop/sections/${produce.id}`, { position: 0.125 })).status, 400);
  assert.equal((await call('PATCH', `/shop/sections/${produce.id}`, { position: 100 })).status, 400);
  assert.equal((await call('POST', '/shop/sections', { location_id: vincent.id, name: 'Aisle 4' })).status, 400);
  assert.equal((await call('POST', '/shop/sections', { location_id: vincent.id, name: 'Pet food', position: 15.5 })).status, 201);
  await call('DELETE', `/shop/sections/${produce.id}`);
  shop = (await call('GET', '/shop')).body;
  assert.equal(shop.products[0].spots[vincent.id], undefined);

  // A size and unit, and a price at each store.
  p = (await call('PATCH', `/shop/products/${id}`, { size: 1, unit: 'kg', prices: { [stores.Woolworths]: 450, [stores.Coles]: 399, [iga.id]: 520 } })).body;
  assert.deepEqual([p.size, p.unit], [1, 'kg']);
  assert.deepEqual(p.prices, { [stores.Woolworths]: 450, [stores.Coles]: 399, [iga.id]: 520 });
  p = (await call('PATCH', `/shop/products/${id}`, { name: 'Pink Lady apples', prices: { [stores.Coles]: null } })).body;
  assert.deepEqual([p.name, p.size, p.prices], ['Pink Lady apples', 1, { [stores.Woolworths]: 450, [iga.id]: 520 }]);
  assert.equal((await call('PATCH', `/shop/products/${id}`, { prices: { [stores.Coles]: -1 } })).status, 400);
  assert.equal((await call('PATCH', `/shop/products/${id}`, { prices: { 999: 100 } })).status, 400);
  assert.equal((await call('PATCH', `/shop/products/${id}`, { size: 2 })).body.error, 'Pick a unit for the size, like g or L.');
  assert.equal((await call('PATCH', `/shop/products/${id}`, { size: 2, unit: 'stone' })).status, 400);
  // Two sizes of the same thing are two products; the same size twice isn't allowed.
  const other = (await call('POST', '/shop/items', { name: 'Apples 2' })).body.product_id;
  assert.equal((await call('PATCH', `/shop/products/${other}`, { name: 'Pink Lady apples', size: 2, unit: 'kg' })).status, 200);
  assert.equal((await call('PATCH', `/shop/products/${other}`, { size: 1, unit: 'kg' })).status, 400);
  // Typing a name that has two sizes and no plain one makes a new product.
  const typed = (await call('POST', '/shop/items', { name: 'pink lady apples' })).body.product_id;
  assert.ok(typed !== id && typed !== other);

  // Priced per kg or L: needs a size it can be worked out from.
  assert.equal((await call('PATCH', `/shop/products/${other}`, { price_per: 'kg' })).body.price_per, 'kg');
  assert.equal((await call('PATCH', `/shop/products/${other}`, { price_per: 'L' })).body.error, 'To price per L, give the size in mL or L.');
  assert.equal((await call('PATCH', `/shop/products/${typed}`, { price_per: '100g' })).status, 400);
  assert.equal((await call('PATCH', `/shop/products/${other}`, { price_per: 'dozen' })).status, 400);
  assert.equal((await call('PATCH', `/shop/products/${other}`, { size: 2, unit: 'L' })).status, 400);

  // The chains come with their own colours; others get one, and any can be changed.
  assert.deepEqual(shop.stores.map((s) => s.color), ['#178841', '#e01a22', '#1f4fa3', iga.color]);
  assert.match(iga.color, /^#[0-9a-f]{6}$/);
  assert.equal((await call('PATCH', `/shop/stores/${iga.id}`, { color: '#123ABC' })).body.color, '#123abc');
  assert.equal((await call('PATCH', `/shop/stores/${iga.id}`, { color: 'red' })).status, 400);

  // Removing a store forgets its locations and prices.
  await call('DELETE', `/shop/stores/${iga.id}`);
  shop = (await call('GET', '/shop')).body;
  assert.equal(shop.locations.some((l) => l.id === town.id), false);
  assert.equal(shop.products.find((x) => x.id === id).prices[iga.id], undefined);
  // Removing a location forgets where things are there.
  await call('DELETE', `/shop/locations/${vincent.id}`);
  shop = (await call('GET', '/shop')).body;
  assert.deepEqual(shop.locations.map((l) => l.name), ['Castletown']);
  assert.equal(shop.sections.some((s) => s.location_id === vincent.id), false);
  // Forgetting a product takes it off the list.
  await call('DELETE', `/shop/products/${id}`);
  shop = (await call('GET', '/shop')).body;
  assert.equal(shop.products.some((x) => x.id === id), false);
  assert.equal(shop.items.some((i) => i.product_id === id), false);
}));

test('shopping: kept in a backup and restored', () => withServer({}, async (call) => {
  const iga = (await call('POST', '/shop/stores', { name: 'IGA' })).body;
  const loc = (await call('POST', '/shop/locations', { store_id: iga.id, name: 'Townsville' })).body;
  const item = (await call('POST', '/shop/items', { name: 'Cheese', qty: 2 })).body;
  await call('PUT', `/shop/products/${item.product_id}/spot`, { location_id: loc.id, aisle: 7 });
  await call('PATCH', `/shop/products/${item.product_id}`, { size: 500, unit: 'g', price_per: 'kg', prices: { [iga.id]: 650 } });
  await call('PATCH', `/shop/items/${item.id}`, { done: true, store_id: iga.id });
  const backup = (await call('GET', '/export')).body;
  assert.equal(backup.shopping.products.length, 1);
  await call('DELETE', `/shop/stores/${iga.id}`);
  await call('DELETE', `/shop/products/${item.product_id}`);
  const r = await call('POST', '/import', backup);
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.shop_products, 1);
  const shop = (await call('GET', '/shop')).body;
  assert.deepEqual(shop.stores.map((s) => s.name), ['Woolworths', 'Coles', 'Aldi', 'IGA']);
  assert.deepEqual(shop.items.map((i) => [i.qty, Boolean(i.done_at)]), [[2, true]]);
  const p = shop.products[0];
  assert.deepEqual([p.size, p.unit, p.price_per, p.prices, p.spots[loc.id].aisle], [500, 'g', 'kg', { [iga.id]: 650 }, 7]);
  assert.equal(shop.items[0].done_store_id, iga.id);
  assert.equal(shop.stores[3].color, iga.color);
  // A backup from before the shopping list, or from the first 0.9.7 test, leaves it as it is.
  delete backup.shopping;
  await call('POST', '/import', backup);
  assert.equal((await call('POST', '/import', { ...backup, shopping: { locations: [], products: [] } })).status, 200);
  assert.equal((await call('GET', '/shop')).body.products.length, 1);
}));

test('shopping: one aisle or category at every location, and when each was last used', () => withServer({}, async (call) => {
  const stores = await storesOf(call);
  const vincent = (await call('POST', '/shop/locations', { store_id: stores.Woolworths, name: 'Vincent' })).body;
  const town = (await call('POST', '/shop/locations', { store_id: stores.Coles, name: 'Town' })).body;
  let shop;
  // Town has no Fruit category; Change all adds it there, in the same place.
  const fruit = (await call('POST', '/shop/sections', { location_id: vincent.id, name: 'Fruit', position: 0.5 })).body;
  const id = (await call('POST', '/shop/items', { name: 'Bananas' })).body.product_id;
  await call('PUT', `/shop/products/${id}/spot`, { location_id: town.id, missing: true });
  let p = (await call('PUT', `/shop/products/${id}/spots`, { section: 'fruit' })).body;
  shop = (await call('GET', '/shop')).body;
  const townFruit = shop.sections.find((s) => s.location_id === town.id && s.name === 'Fruit');
  assert.equal(townFruit.position, 0.5);
  assert.deepEqual(p.spots[vincent.id], { aisle: null, section_id: fruit.id, missing: false });
  assert.deepEqual(p.spots[town.id], { aisle: null, section_id: townFruit.id, missing: false });
  // An aisle everywhere, then unsorted everywhere.
  p = (await call('PUT', `/shop/products/${id}/spots`, { aisle: 3 })).body;
  assert.deepEqual([p.spots[vincent.id].aisle, p.spots[town.id].aisle], [3, 3]);
  p = (await call('PUT', `/shop/products/${id}/spots`, {})).body;
  assert.deepEqual(p.spots, {});
  assert.equal((await call('PUT', `/shop/products/${id}/spots`, { section: 'Nowhere' })).status, 400);
  assert.equal((await call('PUT', `/shop/products/${id}/spots`, { aisle: 21 })).status, 400);
  assert.equal((await call('PUT', '/shop/products/999/spots', { aisle: 1 })).status, 404);

  // Picking a location to shop at is remembered for the household.
  assert.equal(shop.locations.find((l) => l.id === vincent.id).used_at, null);
  assert.equal((await call('POST', `/shop/locations/${vincent.id}/use`)).status, 200);
  assert.equal((await call('POST', '/shop/locations/999/use')).status, 404);
  shop = (await call('GET', '/shop')).body;
  assert.match(shop.locations.find((l) => l.id === vincent.id).used_at, /^\d{4}-\d\d-\d\d /);
  const backup = (await call('GET', '/export')).body;
  assert.ok(backup.shopping.locations.find((l) => l.id === vincent.id).used_at);
}));

test('shopping: store search links and when prices were checked', () => withServer({}, async (call) => {
  // The chains come with their search links; a store added later has none unless it's a chain.
  let shop = (await call('GET', '/shop')).body;
  assert.match(shop.stores.find((s) => s.name === 'Coles').search_url, /^https:\/\/www\.coles\.com\.au\/.*\{q\}/);
  const iga = (await call('POST', '/shop/stores', { name: 'IGA' })).body;
  assert.equal(iga.search_url, null);
  let r = await call('PATCH', `/shop/stores/${iga.id}`, { search_url: 'https://shop.example.com.au/search?q={q}' });
  assert.equal(r.body.search_url, 'https://shop.example.com.au/search?q={q}');
  for (const bad of ['http://shop.example.com.au/?q={q}', 'https://shop.example.com.au/', 'javascript:alert(1)//{q}']) {
    assert.equal((await call('PATCH', `/shop/stores/${iga.id}`, { search_url: bad })).status, 400);
  }
  r = await call('PATCH', `/shop/stores/${iga.id}`, { search_url: '' });
  assert.equal(r.body.search_url, null);

  // A new or changed price is checked now; saving the same price again leaves its date alone,
  // unless it's marked as checked (looked up and still right).
  const id = (await call('POST', '/shop/items', { name: 'Oats' })).body.product_id;
  let p = (await call('PATCH', `/shop/products/${id}`, { prices: { [iga.id]: 300 } })).body;
  assert.ok(p.checked[iga.id]);
  const old = '2026-01-01 00:00:00';
  const backup = (await call('GET', '/export')).body;
  backup.shopping.prices = backup.shopping.prices.map((x) => ({ ...x, checked_at: old }));
  await call('POST', '/import', backup);
  p = (await call('PATCH', `/shop/products/${id}`, { prices: { [iga.id]: 300 } })).body;
  assert.equal(p.checked[iga.id], old);
  p = (await call('PATCH', `/shop/products/${id}`, { prices: { [iga.id]: 300 }, checked: [iga.id] })).body;
  assert.notEqual(p.checked[iga.id], old);
  await call('POST', '/import', backup);
  p = (await call('PATCH', `/shop/products/${id}`, { checked: [iga.id] })).body;
  assert.notEqual(p.checked[iga.id], old);
  await call('POST', '/import', backup);
  p = (await call('PATCH', `/shop/products/${id}`, { prices: { [iga.id]: 320 } })).body;
  assert.deepEqual([p.prices[iga.id], p.checked[iga.id] !== old], [320, true]);
  // Kept in a backup, and an older backup without dates restores with none.
  shop = (await call('GET', '/export')).body.shopping;
  assert.equal(shop.stores.find((s) => s.name === 'Aldi').search_url, 'https://www.aldi.com.au/results?q={q}');
  delete backup.shopping.prices[0].checked_at;
  await call('POST', '/import', backup);
  assert.equal((await call('GET', '/shop')).body.products[0].checked[iga.id], null);
}));

// Automatic prices, through the real price-checker server with made-up stores in place of the websites.
async function withChecker(fn) {
  const { createJobs } = require('../price-checker/lib/jobs');
  const { createServer } = require('../price-checker/server');
  const { createChecker } = require('../src/checker');
  const shelf = {
    woolworths: [
      { name: 'Test Brand Rolled Oats 750g', size: '750g', price_cents: 280, was_cents: 350, special: true, url: 'https://shop.example/w/1', image: 'https://cdn0.woolworths.media/content/wowproductimages/small/1.jpg' },
      { name: 'Fancy Rolled Oats', size: '750g', price_cents: 550, url: 'https://shop.example/w/2' },
      { name: 'Test Brand Rolled Oats 1kg', size: '1kg', price_cents: 340, url: 'https://shop.example/w/3' },
    ],
    coles: [{ name: 'Test Brand Rolled Oats', size: '750g', price_cents: 300, url: 'https://shop.example/c/1' }],
    aldi: [
      { name: 'Cheap Label Rolled Oats', size: '750 g', price_cents: 199, url: 'https://shop.example/a/1' },
      { name: 'Cheap Label Muesli', size: '750 g', price_cents: 150, url: 'https://shop.example/a/2' },
    ],
  };
  const stores = Object.fromEntries(Object.keys(shelf).map((id) => [id, {
    id, home: 'https://shop.example/', gap: [0, 0], challenged: async () => false,
    search: async (page, q) => shelf[id].filter((r) => r.name.toLowerCase().includes(q.toLowerCase().split(' ')[1] || q)).map((r) => ({ ...r })),
  }]));
  const browser = { page: async () => ({}), closePage: async () => {}, idle: () => {}, size: { width: 1366, height: 768 } };
  const jobs = createJobs({ browser, stores, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  // The stores' picture servers: a tiny JPEG for any address on them.
  const fetchImpl = async (u) => (/woolworths\.media/.test(u) ? new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } })
    : new Response('nope', { status: 404 }));
  const server = createServer({ jobs, browser, token: 'test-token', fetchImpl });
  server.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ checker: createChecker({ url, token: 'test-token' }), url, shelf });
  } finally { server.close(); }
}

const until = async (call, id, ok = (j) => j.state === 'done') => {
  for (let i = 0; i < 200; i++) {
    const r = await call('GET', `/shop/checker/jobs/${id}`);
    if (ok(r.body)) return r.body;
    await new Promise((r2) => setTimeout(r2, 20));
  }
  throw new Error('the check never finished');
};

test('shopping: automatic prices are off without a price-checker', () => withServer({}, async (call) => {
  assert.equal((await call('GET', '/shop')).body.checker, null);
  const id = (await call('POST', '/shop/items', { name: 'Oats' })).body.product_id;
  const r = await call('POST', '/shop/checker/find', { product_id: id });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not set up/);
}));

test('shopping: the price-checker only answers with its token', () => withChecker(async ({ url }) => {
  const { createChecker } = require('../src/checker');
  await assert.rejects(createChecker({ url, token: 'wrong' }).start({ type: 'search', q: 'x' }), /PRICE_CHECKER_TOKEN/);
  await assert.rejects(createChecker({ url: 'http://127.0.0.1:9', token: 'x' }).get('j1'), /Couldn't reach/);
  assert.equal((await fetch(`${url}/screen/coles`, { headers: { authorization: 'Bearer test-token' } })).status, 409);
}));

test('shopping: automatic price search, matching, the cheaper similar hint and updates', () => withChecker(({ checker, shelf }) => withServer({ checker }, async (call) => {
  const stores = await storesOf(call);
  let shop = (await call('GET', '/shop')).body;
  assert.deepEqual(shop.checker.stores, ['woolworths', 'coles', 'aldi']);
  assert.match(shop.checker.since, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(shop.stores.find((s) => s.name === 'Coles').checker, 'coles');

  const id = (await call('POST', '/shop/items', { name: 'Rolled oats' })).body.product_id;
  await call('PATCH', `/shop/products/${id}`, { size: 750, unit: 'g' });
  let r = await call('POST', '/shop/checker/find', { product_id: id });
  assert.equal(r.status, 201);
  const found = await until(call, r.body.id);
  assert.equal(found.stores[stores.Woolworths].state, 'done');
  assert.equal(found.results[stores.Woolworths].length, 3);
  assert.equal(found.results[stores.Aldi].length, 1);

  // Woolworths and Coles matched, Aldi left out: the Aldi oats are a cheaper similar.
  r = await call('PUT', `/shop/products/${id}/matches`, { job: found.id, picks: { [stores.Woolworths]: 0, [stores.Coles]: 0, [stores.Aldi]: null } });
  assert.equal(r.status, 200);
  let p = r.body;
  assert.deepEqual([p.prices[stores.Woolworths], p.was[stores.Woolworths], p.prices[stores.Coles]], [280, 350, 300]);
  assert.equal(p.matches[stores.Coles].url, 'https://shop.example/c/1');
  assert.deepEqual(p.matches[stores.Aldi], { url: '', name: '', size: null, missing_at: null }); // none of them, remembered
  assert.ok(p.not_sold[stores.Aldi]); // and saved as not sold there
  assert.equal(p.prices[stores.Aldi], undefined);
  assert.equal(p.similar.name, 'Cheap Label Rolled Oats');
  assert.deepEqual([p.similar.store_id, p.similar.price_cents], [stores.Aldi, 199]);
  // The same oats in the other size at Woolworths, and Woolworths' own closest other brand.
  assert.deepEqual([p.options[stores.Woolworths].size.name, p.options[stores.Woolworths].size.price_cents], ['Test Brand Rolled Oats 1kg', 340]);
  assert.equal(p.options[stores.Woolworths].similar.name, 'Fancy Rolled Oats');
  assert.equal(p.options[stores.Coles], undefined);
  assert.equal((await call('PUT', `/shop/products/${id}/matches`, { job: found.id, picks: { [stores.Coles]: 7 } })).status, 400);
  assert.equal((await call('PUT', `/shop/products/${id}/matches`, { job: 'j999', picks: {} })).status, 404);

  // Nothing's out of date yet, so an update has nothing to do except the store it isn't matched at.
  r = await call('POST', '/shop/checker/update', { list: 'shared' });
  assert.deepEqual([r.body.id, r.body.total], [null, 0]);
  assert.deepEqual(r.body.unmatched, []);
  const bread = (await call('POST', '/shop/items', { name: 'Test bread' })).body.product_id;
  r = await call('POST', '/shop/checker/update', { list: 'shared' });
  assert.equal(r.body.unmatched.length, 3);
  assert.ok(r.body.unmatched.every((u) => u.product_id === bread));

  // A week later (dates moved back), with new prices at the stores: only the list's matched prices update.
  const backup = (await call('GET', '/export')).body;
  backup.shopping.prices = backup.shopping.prices.map((x) => ({ ...x, checked_at: '2026-01-01 00:00:00' }));
  await call('POST', '/import', backup);
  shelf.woolworths[0].price_cents = 320;
  Object.assign(shelf.woolworths[0], { was_cents: null, special: false });
  const colesOats = shelf.coles.pop();
  r = await call('POST', '/shop/checker/update', { list: 'shared' });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 2);
  const done = await until(call, r.body.id, (j) => j.state === 'done' && j.changes);
  assert.deepEqual(done.changes, [{ product_id: id, store_id: stores.Woolworths, old_cents: 280, new_cents: 320, special: false }]);
  assert.deepEqual(done.missing, [{ product_id: id, store_id: stores.Coles }]);
  p = (await call('GET', '/shop')).body.products.find((x) => x.id === id);
  assert.equal(p.prices[stores.Woolworths], 320);
  assert.equal(p.was[stores.Woolworths], undefined);
  assert.notEqual(p.checked[stores.Woolworths], '2026-01-01 00:00:00');
  assert.ok(p.matches[stores.Coles].missing_at);
  assert.equal(p.checked[stores.Coles], '2026-01-01 00:00:00');

  // Refresh prices now checks every saved product's matched prices, however recent.
  r = await call('POST', '/shop/checker/update', { all: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 2);
  await until(call, r.body.id, (j) => j.state === 'done' && j.changes);

  // Refreshing one product searches again for it, keeping its other size up to date.
  shelf.woolworths[2].price_cents = 360;
  r = await call('POST', '/shop/checker/update', { product_ids: [id] });
  assert.equal(r.body.total, 2);
  await until(call, r.body.id, (j) => j.state === 'done' && j.changes);
  p = (await call('GET', '/shop')).body.products.find((x) => x.id === id);
  assert.equal(p.options[stores.Woolworths].size.price_cents, 360);

  // A new match at just Coles keeps the similar hint (only that store's search is redone).
  shelf.coles.push(colesOats);
  r = await call('POST', '/shop/checker/find', { product_id: id, store_ids: [stores.Coles] });
  assert.deepEqual(Object.keys(r.body.stores), [String(stores.Coles)]);
  const again = await until(call, r.body.id);
  p = (await call('PUT', `/shop/products/${id}/matches`, { job: again.id, picks: { [stores.Coles]: 0 } })).body;
  assert.equal(p.matches[stores.Coles].missing_at, null);
  assert.equal(p.similar.name, 'Cheap Label Rolled Oats');

  // Kept in a backup.
  shop = (await call('GET', '/export')).body.shopping;
  assert.equal(shop.options.filter((o) => o.kind === 'similar').length, 2); // Woolworths' and Aldi's closest
  assert.equal(shop.matches.length, 3);
  assert.ok(shop.stores.every((s) => 'checker' in s));
})));

test('shopping: prices go out of date at 9am on Wednesdays', () => {
  const { priceDay } = require('../src/shop');
  const at = (s) => priceDay(new Date(s));
  const local = (s) => { const d = new Date(s); return d.toISOString().slice(0, 19).replace('T', ' '); };
  assert.equal(at('2026-10-14T09:30:00'), local('2026-10-14T09:00:00')); // Wednesday, after 9
  assert.equal(at('2026-10-14T08:30:00'), local('2026-10-07T09:00:00')); // Wednesday, before 9
  assert.equal(at('2026-10-13T12:00:00'), local('2026-10-07T09:00:00')); // Tuesday
  assert.equal(at('2026-10-18T12:00:00'), local('2026-10-14T09:00:00')); // Sunday
});

test('shopping: the browser helper (Coles button) uses its own key', () => withServer({}, async (call, caller) => {
  const stores = await storesOf(call);
  const oats = (await call('POST', '/shop/items', { name: 'Rolled oats' })).body.product_id;
  await call('PATCH', `/shop/products/${oats}`, { size: 750, unit: 'g' });
  const milk = (await call('POST', '/shop/items', { name: 'Milk' })).body.product_id;
  const bread = (await call('POST', '/shop/items', { name: 'Bread' })).body.product_id;
  // A new key replaces the old one; the extension sends it, not a login cookie, from its own origin.
  const old = (await call('POST', '/shop/helper/key', {})).body.key;
  assert.equal((await call('POST', '/shop/helper/key', {})).body.key, old);
  const key = (await call('POST', '/shop/helper/key', { new: true })).body.key;
  assert.notEqual(key, old);
  const ext = caller();
  const as = (k) => ({ authorization: `Bearer ${k}`, origin: 'chrome-extension://abcdefgh' });
  assert.equal((await ext('GET', '/shop-helper/coles')).status, 401);
  assert.equal((await ext('GET', '/shop-helper/coles', null, as(old))).status, 401);
  assert.equal((await ext('GET', '/shop/', null, as(key))).status, 401); // only the helper's routes
  assert.equal((await ext('GET', '/shop-helper/nowhere', null, as(key))).status, 404);

  let r = await ext('GET', '/shop-helper/coles', null, as(key));
  assert.equal(r.body.store.id, stores.Coles);
  assert.deepEqual(r.body.items.map((i) => [i.name, i.q, i.match, i.out_of_date]),
    [['Bread', 'Bread', null, false], ['Milk', 'Milk', null, false], ['Rolled oats', 'Rolled oats', null, false]]);

  r = await ext('POST', '/shop-helper/coles/results', {
    found: [{ product_id: oats, url: 'https://shop.example/c/oats', name: 'Test Rolled Oats', size: '750g', price_cents: 300, was_cents: 350 },
      { product_id: milk, url: 'javascript:alert(1)', name: 'Bad', price_cents: 100 }],
    none: [bread],
  }, as(key));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changes, [{ product_id: oats, old_cents: null, new_cents: 300 }]);
  const p = (await call('GET', '/shop')).body.products.find((x) => x.id === oats);
  assert.deepEqual([p.prices[stores.Coles], p.was[stores.Coles], p.matches[stores.Coles].url], [300, 350, 'https://shop.example/c/oats']);
  r = await ext('GET', '/shop-helper/coles', null, as(key));
  const by = Object.fromEntries(r.body.items.map((i) => [i.name, i]));
  assert.equal(by.Bread.none, true);
  assert.equal(by.Milk.match, null);
  assert.equal(by['Rolled oats'].match.name, 'Test Rolled Oats');
  assert.equal(by['Rolled oats'].out_of_date, false);
  // Loose bananas, sold each with a price per kg, cost 1 kg's worth for a 1 kg product, or a kilo's
  // price for one priced per kg.
  const bananas = (await call('POST', '/shop/items', { name: 'Bananas' })).body.product_id;
  await call('PATCH', `/shop/products/${bananas}`, { size: 1000, unit: 'g' });
  const loose = { url: 'https://shop.example/c/bananas', name: 'Test Bananas Loose', size: 'approx. 180g', price_cents: 72, sold: 'each', per_kg_cents: 400 };
  await ext('POST', '/shop-helper/coles/results', { found: [{ product_id: bananas, ...loose }] }, as(key));
  assert.equal((await call('GET', '/shop')).body.products.find((x) => x.id === bananas).prices[stores.Coles], 400);
  await call('PATCH', `/shop/products/${bananas}`, { size: 1, unit: 'kg', price_per: '100g' });
  await ext('POST', '/shop-helper/coles/results', { found: [{ product_id: bananas, ...loose }] }, as(key));
  assert.equal((await call('GET', '/shop')).body.products.find((x) => x.id === bananas).prices[stores.Coles], 40);
  await call('PATCH', `/shop/products/${bananas}`, { size: null, unit: null, price_per: 'each' });
  await ext('POST', '/shop-helper/coles/results', { found: [{ product_id: bananas, ...loose }] }, as(key));
  assert.equal((await call('GET', '/shop')).body.products.find((x) => x.id === bananas).prices[stores.Coles], 72); // one banana

  await ext('POST', '/shop-helper/coles/results', { missing: [oats] }, as(key));
  r = await ext('GET', '/shop-helper/coles', null, as(key));
  assert.equal(r.body.items.find((i) => i.product_id === oats).match.missing, true);
}));

test('shopping: the Coles button downloads as a zip of the extension', () => withServer({}, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const zlib = require('node:zlib');
  const { zipFolder } = require('../src/zip');
  const dir = path.join(__dirname, '..', 'browser-extension');
  const z = zipFolder(dir, 'top');
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
  const count = z.readUInt16LE(z.length - 12);
  assert.equal(count, fs.readdirSync(dir).length);
  // The first file is there whole, under the top folder, with its checksum.
  const nameLen = z.readUInt16LE(26);
  const name = z.subarray(30, 30 + nameLen).toString();
  const size = z.readUInt32LE(18);
  const data = z.subarray(30 + nameLen, 30 + nameLen + size);
  assert.ok(name.startsWith('top/'));
  assert.deepEqual(data, fs.readFileSync(path.join(dir, name.slice(4))));
  assert.equal(z.readUInt32LE(14), zlib.crc32(data));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, require('../package.json').version);
}));

test('shopping: bought by weight, counted, swapped and noted', () => withServer({}, async (call) => {
  const stores = await storesOf(call);
  // Typed in new, it's bought by the pack until it's set up.
  let item = (await call('POST', '/shop/items', { list: 'shared', name: 'Bananas' })).body;
  const id = item.product_id;
  let p = (await call('GET', '/shop')).body.products.find((x) => x.id === id);
  assert.deepEqual([p.sold_by, p.setup, item.grams], ['pack', true, null]);
  await call('PATCH', `/shop/products/${id}`, { prices: { [stores.Coles]: 400 } });
  assert.equal((await call('GET', '/shop')).body.products.find((x) => x.id === id).setup, true); // prices alone don't set it up

  // By weight needs a price per kg and a usual amount in g or kg.
  assert.equal((await call('PATCH', `/shop/products/${id}`, { sold_by: 'weight' })).status, 400);
  assert.equal((await call('PATCH', `/shop/products/${id}`, { sold_by: 'heaps' })).status, 400);
  const checked = (await call('GET', '/shop')).body.products.find((x) => x.id === id).checked[stores.Coles];
  const backup = (await call('GET', '/export')).body;
  backup.shopping.prices = backup.shopping.prices.map((x) => ({ ...x, checked_at: '2026-01-01 00:00:00' }));
  await call('POST', '/import', backup);
  // 400 a bunch of 2 kg becomes $2.00 a kg: the same price, said another way, so not checked again.
  let r = await call('PATCH', `/shop/products/${id}`, { sold_by: 'weight', price_per: 'kg', size: 2, unit: 'kg', step_g: 250, each_g: 180,
    prices: { [stores.Coles]: 200 }, converted: [stores.Coles] });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.sold_by, r.body.setup, r.body.step_g, r.body.each_g, r.body.prices[stores.Coles]], ['weight', false, 250, 180, 200]);
  assert.equal(r.body.checked[stores.Coles], '2026-01-01 00:00:00');
  assert.ok(checked);
  // What was on the list became a weight: its usual amount.
  item = (await call('GET', '/shop')).body.items.find((x) => x.product_id === id);
  assert.deepEqual([item.qty, item.grams], [1, 2000]);
  // Added again: another usual amount.
  item = (await call('POST', '/shop/items', { list: 'shared', product_id: id })).body;
  assert.equal(item.grams, 4000);

  // Counted instead, with a note and back to by weight.
  r = await call('PATCH', `/shop/items/${item.id}`, { grams: null, qty: 6, note: '  a bit  green ' });
  assert.deepEqual([r.body.grams, r.body.qty, r.body.note], [null, 6, 'a bit green']);
  assert.equal((await call('PATCH', `/shop/items/${item.id}`, { grams: 0 })).status, 400);
  assert.equal((await call('PATCH', `/shop/items/${item.id}`, { note: 'x'.repeat(201) })).status, 400);
  r = await call('PATCH', `/shop/items/${item.id}`, { grams: 1500, note: '' });
  assert.deepEqual([r.body.grams, r.body.note], [1500, null]);

  // Swapped to another size at a store, for this shop only: ticked off and added again, it's not.
  assert.equal((await call('PATCH', `/shop/items/${item.id}`, { swap_store_id: 9999 })).status, 400);
  r = await call('PATCH', `/shop/items/${item.id}`, { swap_store_id: stores.Woolworths, note: 'only if ripe' });
  assert.deepEqual([r.body.swap_store_id, r.body.swap_kind], [stores.Woolworths, 'size']);
  // Or to a store's close match.
  assert.equal((await call('PATCH', `/shop/items/${item.id}`, { swap_store_id: stores.Coles, swap_kind: 'other' })).status, 400);
  r = await call('PATCH', `/shop/items/${item.id}`, { swap_store_id: stores.Coles, swap_kind: 'similar' });
  assert.deepEqual([r.body.swap_store_id, r.body.swap_kind], [stores.Coles, 'similar']);
  await call('PATCH', `/shop/items/${item.id}`, { done: true });
  r = await call('POST', '/shop/items', { list: 'shared', product_id: id });
  assert.deepEqual([r.body.swap_store_id, r.body.swap_kind, r.body.note, r.body.grams], [null, null, null, 2000]);

  // Back to packs: the list counts it again.
  await call('PATCH', `/shop/products/${id}`, { sold_by: 'pack', price_per: 'each' });
  item = (await call('GET', '/shop')).body.items.find((x) => x.product_id === id);
  assert.equal(item.grams, null);

  // Kept in a backup, along with the list's weights and notes.
  await call('PATCH', `/shop/items/${item.id}`, { note: 'the big bunch' });
  const shop = (await call('GET', '/export')).body.shopping;
  assert.equal(shop.products.find((x) => x.id === id).each_g, 180);
  assert.equal(shop.items.find((x) => x.id === item.id).note, 'the big bunch');
  // An older backup's cheaper similar product comes back as a close match.
  const old = (await call('GET', '/export')).body;
  delete old.shopping.options;
  old.shopping.similar = [{ product_id: id, store_id: stores.Aldi, name: 'Test Bananas', size: '1kg', price_cents: 300, url: 'https://shop.example/a/b', seen_at: '2026-01-01 00:00:00' }];
  await call('POST', '/import', old);
  p = (await call('GET', '/shop')).body.products.find((x) => x.id === id);
  assert.equal(p.options[stores.Aldi].similar.name, 'Test Bananas');
}));

test('shopping: not sold at a store, in place of its price, and typing over an automatic price', () => withServer({}, async (call) => {
  const stores = await storesOf(call);
  const id = (await call('POST', '/shop/items', { list: 'shared', name: 'Paper towels' })).body.product_id;
  let p;
  await call('PATCH', `/shop/products/${id}`, { prices: { [stores.Coles]: 400, [stores.Aldi]: 350 } });
  // Not sold at Aldi: its price goes, and when it was found is kept.
  p = (await call('PATCH', `/shop/products/${id}`, { not_sold: [stores.Aldi] })).body;
  assert.equal(p.prices[stores.Aldi], undefined);
  assert.match(p.not_sold[stores.Aldi], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(p.prices[stores.Coles], 400);
  // It's backed up and restored.
  const { body: backup } = await call('GET', '/export');
  assert.equal(backup.shopping.not_sold.length, 1);
  // A price there clears it, and so does clearing the price.
  p = (await call('PATCH', `/shop/products/${id}`, { prices: { [stores.Aldi]: 360 } })).body;
  assert.deepEqual([p.prices[stores.Aldi], p.not_sold[stores.Aldi]], [360, undefined]);
  await call('PATCH', `/shop/products/${id}`, { not_sold: [stores.Woolworths] });
  p = (await call('PATCH', `/shop/products/${id}`, { prices: { [stores.Woolworths]: null } })).body;
  assert.deepEqual(p.not_sold, {});
  // unmatch stops a store's price being automatic (typed over in Check prices).
  p = (await call('PATCH', `/shop/products/${id}`, { prices: { [stores.Coles]: 410 }, unmatch: [stores.Coles] })).body;
  assert.deepEqual([p.prices[stores.Coles], p.matches[stores.Coles]], [410, undefined]);
  await call('POST', '/import', backup);
  p = (await call('GET', '/shop')).body.products.find((x) => x.id === id);
  assert.ok(p.not_sold[stores.Aldi]);
}));

test('shopping: search results closest to the product come first', () => {
  const { relevance } = require('../src/shop');
  const sugar = { name: 'CSR Brown Sugar', size: 500, unit: 'g', sold_by: 'pack' };
  const order = (p, names, opts) => names.map((n) => [n, relevance(p, { name: n, size: null }, opts)]).sort((a, b) => b[1] - a[1]).map(([n]) => n);
  assert.deepEqual(order(sugar, ['Coles White Sugar 1kg', 'CSR White Sugar 500g', 'Coles Dark Brown Sugar 1kg', 'CSR Brown Sugar 1kg', 'CSR Brown Sugar 500g']),
    ['CSR Brown Sugar 500g', 'CSR Brown Sugar 1kg', 'CSR White Sugar 500g', 'Coles Dark Brown Sugar 1kg', 'Coles White Sugar 1kg']);
  // A word it adds makes it a different thing.
  assert.equal(order(sugar, ['CSR Dark Brown Sugar 500g', 'CSR Brown Sugar 500g'])[0], 'CSR Brown Sugar 500g');
  // No 500 g to be had: the nearest size wins.
  assert.deepEqual(order(sugar, ['CSR Brown Sugar 1kg', 'CSR Brown Sugar 430g', 'CSR Brown Sugar 25g']), ['CSR Brown Sugar 430g', 'CSR Brown Sugar 1kg', 'CSR Brown Sugar 25g']);
  // Something made from it comes after the thing itself.
  const chicken = { name: 'Chicken Thigh Fillets', size: 500, unit: 'g', sold_by: 'pack' };
  assert.equal(order(chicken, ['Chicken Seasoning 500g', 'Chicken Thigh Fillets 1kg', 'Chicken Thigh Fillet 480g'])[0], 'Chicken Thigh Fillet 480g');
  assert.equal(order(chicken, ['Chicken Seasoning 500g', 'Chicken Breast 500g']).at(-1), 'Chicken Seasoning 500g');
  // What it's matched to at another store helps: the same brand first.
  const oats = { name: 'Rolled Oats', size: 750, unit: 'g', sold_by: 'pack' };
  assert.equal(order(oats, ['Fancy Rolled Oats 750g', 'Uncle Tobys Rolled Oats 750g'], { refs: ['Uncle Tobys Oats Traditional 750g'] })[0], 'Uncle Tobys Rolled Oats 750g');
});

test('shopping: pictures of what was picked, from the stores\' own picture servers', () => withChecker(({ checker }) => withServer({ checker }, async (call) => {
  const { imageUrl } = require('../src/shop');
  assert.equal(imageUrl('https://cdn0.woolworths.media/content/wowproductimages/small/1.jpg'), 'https://cdn0.woolworths.media/content/wowproductimages/small/1.jpg');
  assert.equal(imageUrl('https://productimages.coles.com.au/productimages/1/2.jpg'), 'https://productimages.coles.com.au/productimages/1/2.jpg');
  assert.equal(imageUrl('http://cdn0.woolworths.media/1.jpg'), null);
  assert.equal(imageUrl('https://evil.example/woolworths.media.jpg'), null);
  assert.equal(imageUrl('https://woolworths.media.evil.example/1.jpg'), null);

  const stores = await storesOf(call);
  const id = (await call('POST', '/shop/items', { name: 'Rolled oats' })).body.product_id;
  const found = await until(call, (await call('POST', '/shop/checker/find', { product_id: id })).body.id);
  const r = found.results[stores.Woolworths].find((x) => x.url === 'https://shop.example/w/1');
  assert.equal(r.image, 'https://cdn0.woolworths.media/content/wowproductimages/small/1.jpg');
  assert.ok(typeof r.score === 'number');

  // Find prices shows it through the app; only the stores' picture servers.
  const base = `/shop/picture?u=${encodeURIComponent(r.image)}`;
  const pic = await fetchRaw(call, base);
  assert.deepEqual([pic.status, pic.type], [200, 'image/jpeg']);
  assert.equal((await call('GET', `/shop/picture?u=${encodeURIComponent('https://evil.example/x.jpg')}`)).status, 400);

  // Picked with the small copy the browser made: kept with the match, and served from the app.
  const small = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
  let p = (await call('PUT', `/shop/products/${id}/matches`, { job: found.id, picks: { [stores.Woolworths]: 0 }, images: { [stores.Woolworths]: small } })).body;
  assert.ok(p.matches[stores.Woolworths].image_v > 0);
  const kept = await fetchRaw(call, `/shop/products/${id}/picture/${stores.Woolworths}`);
  assert.deepEqual([kept.status, kept.type, kept.size], [200, 'image/jpeg', 4]);
  // Picked again without one: kept. Anything that isn't a small picture is left out.
  p = (await call('PUT', `/shop/products/${id}/matches`, { job: found.id, picks: { [stores.Woolworths]: 0 } })).body;
  assert.ok(p.matches[stores.Woolworths].image_v > 0);
  p = (await call('PUT', `/shop/products/${id}/matches`, { job: found.id, picks: { [stores.Coles]: 0 }, images: { [stores.Coles]: 'data:text/html;base64,PGI+' } })).body;
  assert.equal(p.matches[stores.Coles].image_v, undefined);
  assert.equal((await fetchRaw(call, `/shop/products/${id}/picture/${stores.Coles}`)).status, 404);
  // Kept in a backup.
  const backup = (await call('GET', '/export')).body;
  assert.equal(backup.shopping.matches.find((m) => m.store_id === stores.Woolworths).image, small);
})));
