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
    return async (method, path, body) => {
      const res = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
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

// A stand-in for the price lookup service: answers with made-up products for what's searched.
function fakeLookup(catalogue, seen = []) {
  return async (url, opts) => {
    if (!String(url).startsWith('https://api.apify.com/')) return { ok: false, status: 404, json: async () => ({}) };
    if (opts.headers.authorization !== 'Bearer apify_api_madeupkey123') return { ok: false, status: 401, json: async () => ({}) };
    const input = JSON.parse(opts.body);
    seen.push(input);
    const rows = catalogue.filter((r) => input.chains.includes(r.chain)
      && input.keywords.some((k) => r.name.toLowerCase().includes(k.toLowerCase().split(' ')[0])));
    return { ok: true, status: 201, json: async () => rows };
  };
}

test('shopping: automatic prices find, match and refresh', async () => {
  const catalogue = [
    { chain: 'woolworths', name: 'Woolworths Rolled Oats 750g', size: '750g', price: 2.8, url: 'https://www.woolworths.com.au/shop/productdetails/100001/oats' },
    { chain: 'woolworths', name: 'Uncle Bob Quick Oats 500g', size: '500g', price: 4.5, url: 'https://www.woolworths.com.au/shop/productdetails/100002/quick-oats' },
    { chain: 'coles', name: 'Coles Rolled Oats 750g', size: '750g', price: 3.0, url: 'https://www.coles.com.au/product/coles-rolled-oats-750g-200001' },
    { chain: 'aldi', name: 'Oats without a link', size: '1kg', price: 3.1, url: 'not a link' },
  ];
  const seen = [];
  await withServer({ fetchImpl: fakeLookup(catalogue, seen) }, async (call) => {
    const stores = await storesOf(call);
    const id = (await call('POST', '/shop/items', { name: 'Rolled oats' })).body.product_id;
    // Nothing is looked up without a key, and a key is never sent back.
    let r = await call('POST', `/shop/products/${id}/find`, {});
    assert.equal(r.status, 400);
    assert.equal((await call('PUT', '/shop/lookup', { key: 'not a key' })).status, 400);
    r = await call('PUT', '/shop/lookup', { key: 'apify_api_wrongkey000' });
    assert.deepEqual([r.body.key_set, JSON.stringify(r.body).includes('wrongkey')], [true, false]);
    r = await call('POST', `/shop/products/${id}/find`, {});
    assert.match(r.body.error, /turned down the key/);
    await call('PUT', '/shop/lookup', { key: 'apify_api_madeupkey123' });

    // Find shows each known store's products, leaving out results without a proper link.
    r = await call('POST', `/shop/products/${id}/find`, { q: 'oats' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results[stores.Woolworths].map((x) => x.price_cents), [280, 450]);
    assert.equal(r.body.results[stores.Coles].length, 1);
    assert.deepEqual(r.body.results[stores.Aldi], []);
    assert.deepEqual(seen[0].chains.sort(), ['aldi', 'coles', 'woolworths']);
    const shop = (await call('GET', '/shop')).body;
    assert.deepEqual(shop.stores.map((s) => s.auto), [true, true, true]);

    // Matching saves the store's product and its price.
    const pick = r.body.results[stores.Woolworths][0];
    let p = (await call('PUT', `/shop/products/${id}/match`, { store_id: stores.Woolworths, ...pick })).body;
    assert.deepEqual([p.prices[stores.Woolworths], p.matches[stores.Woolworths].name], [280, 'Woolworths Rolled Oats 750g']);
    await call('PUT', `/shop/products/${id}/match`, { store_id: stores.Coles, ...r.body.results[stores.Coles][0] });
    assert.equal((await call('PUT', `/shop/products/${id}/match`, { store_id: stores.Coles, ...pick, url: 'javascript:x' })).status, 400);

    // A refresh looks each match up at its own store only, and saves what changed.
    catalogue[0].price = 3.2;
    catalogue[2].url = 'https://www.coles.com.au/product/renamed';
    catalogue[2].name = 'Coles Oats Renamed';
    seen.length = 0;
    r = await call('POST', '/shop/lookup/refresh', {});
    assert.deepEqual([r.body.checked, r.body.updated, r.body.changed, r.body.missing], [2, 1, 1, 1]);
    assert.deepEqual(seen.map((x) => x.chains), [['woolworths'], ['coles']]);
    p = (await call('GET', '/shop')).body.products[0];
    assert.deepEqual([p.prices[stores.Woolworths], p.prices[stores.Coles]], [320, 300]);
    assert.equal((await call('GET', '/shop/lookup')).body.last.changed, 1);

    // Unmatched, the price stays. Matches go in a backup, the key doesn't.
    p = (await call('PUT', `/shop/products/${id}/match`, { store_id: stores.Coles, remove: true })).body;
    assert.deepEqual([p.matches[stores.Coles], p.prices[stores.Coles]], [undefined, 300]);
    const backup = (await call('GET', '/export')).body;
    assert.equal(backup.shopping.matches.length, 1);
    assert.equal(JSON.stringify(backup).includes('madeupkey'), false);
    r = await call('PUT', '/shop/lookup', { remove_key: true, weekly: false });
    assert.deepEqual([r.body.key_set, r.body.weekly], [false, false]);
  });
});
