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

test('shopping: add by name, tick off, and add again from past items', () => withServer({}, async (call) => {
  let r = await call('POST', '/shop/items', { list: 'shared', name: '  Milk  2L ' });
  assert.equal(r.status, 201);
  const milk = r.body.product_id;
  // The same name in other capitals is the same product, and adds to how many.
  r = await call('POST', '/shop/items', { list: 'shared', name: 'milk 2l' });
  assert.deepEqual([r.status, r.body.product_id, r.body.qty], [200, milk, 2]);
  let shop = (await call('GET', '/shop?list=shared')).body;
  assert.deepEqual(shop.products.map((p) => p.name), ['Milk 2L']);
  assert.equal(shop.items.length, 1);
  // Ticked off: it leaves the list and stays a past item.
  r = await call('DELETE', `/shop/items/${shop.items[0].id}`);
  assert.deepEqual([r.body.product_id, r.body.qty], [milk, 2]);
  shop = (await call('GET', '/shop?list=shared')).body;
  assert.deepEqual([shop.items.length, shop.products.length], [0, 1]);
  r = await call('POST', '/shop/items', { list: 'shared', product_id: milk });
  assert.equal(r.status, 201);
  assert.equal((await call('POST', '/shop/items', { list: 'shared', name: ' ' })).body.error, "The item can't be empty.");
  assert.equal((await call('POST', '/shop/items', { list: 'shared', product_id: 999 })).status, 400);
  assert.equal((await call('POST', '/shop/items', { list: 'someone', name: 'Bread' })).status, 400);
}));

test('shopping: the shared list and each login\'s own list', () => withServer({}, async (call, caller) => {
  await call('POST', '/logins', { name: 'Sam', password: 'sams-password' });
  const sam = caller();
  await sam('POST', '/login', { password: 'sams-password' });
  await call('POST', '/shop/items', { list: 'shared', name: 'Bread' });
  await call('POST', '/shop/items', { list: 'mine', name: 'Coffee' });
  const samsOwn = (await sam('POST', '/shop/items', { list: 'mine', name: 'Tea' })).body;
  const main = (await call('GET', '/shop?list=mine')).body;
  assert.deepEqual(main.counts, { shared: 1, mine: 1 });
  assert.equal(main.products.find((p) => p.id === main.items[0].product_id).name, 'Coffee');
  // Past items are shared by every list.
  assert.deepEqual(main.products.map((p) => p.name), ['Bread', 'Coffee', 'Tea']);
  const sams = (await sam('GET', '/shop?list=mine')).body;
  assert.deepEqual(sams.items.map((i) => i.id), [samsOwn.id]);
  assert.equal((await sam('GET', '/shop?list=shared')).body.items.length, 1);
  // Someone else's own list can't be changed.
  assert.equal((await call('PATCH', `/shop/items/${samsOwn.id}`, { qty: 3 })).status, 404);
  assert.equal((await call('DELETE', `/shop/items/${samsOwn.id}`)).status, 404);
  assert.equal((await sam('PATCH', `/shop/items/${samsOwn.id}`, { qty: 3 })).body.qty, 3);
  assert.equal((await sam('PATCH', `/shop/items/${samsOwn.id}`, { qty: 0 })).status, 400);
}));

test('shopping: locations, sections, aisles and prices', () => withServer({}, async (call) => {
  const vincent = (await call('POST', '/shop/locations', { store: 'woolworths', name: 'Vincent' })).body;
  const castletown = (await call('POST', '/shop/locations', { store: 'woolworths', name: 'Castletown' })).body;
  assert.equal((await call('POST', '/shop/locations', { store: 'iga', name: 'Town' })).body.error, 'Pick Woolworths, Coles or Aldi.');
  assert.equal((await call('POST', '/shop/locations', { store: 'woolworths', name: 'vincent' })).status, 400);
  let shop = (await call('GET', '/shop')).body;
  const sections = shop.sections.filter((s) => s.location_id === vincent.id);
  assert.deepEqual(sections.map((s) => s.name), ['Bakery', 'Deli', 'Meat', 'Produce', 'Dairy', 'Freezer']);
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
  p = (await call('PUT', `/shop/products/${id}/spot`, { location_id: castletown.id, missing: true })).body;
  assert.equal(p.spots[castletown.id].missing, true);
  p = (await call('PUT', `/shop/products/${id}/spot`, { location_id: castletown.id })).body;
  assert.equal(p.spots[castletown.id], undefined);

  // A section's order, and removing it sends its products back to unsorted.
  assert.equal((await call('PATCH', `/shop/sections/${produce.id}`, { position: 3 })).body.position, 3);
  assert.equal((await call('POST', '/shop/sections', { location_id: vincent.id, name: 'Aisle 4' })).status, 400);
  assert.equal((await call('POST', '/shop/sections', { location_id: vincent.id, name: 'Pet food', position: 15 })).status, 201);
  await call('DELETE', `/shop/sections/${produce.id}`);
  shop = (await call('GET', '/shop')).body;
  assert.equal(shop.products[0].spots[vincent.id], undefined);

  // A price at each chain, and clearing one.
  p = (await call('PATCH', `/shop/products/${id}`, { prices: { woolworths: 450, coles: 399 } })).body;
  assert.deepEqual(p.prices, { woolworths: 450, coles: 399 });
  p = (await call('PATCH', `/shop/products/${id}`, { name: 'Pink Lady apples', prices: { coles: null } })).body;
  assert.deepEqual([p.name, p.prices], ['Pink Lady apples', { woolworths: 450 }]);
  assert.equal((await call('PATCH', `/shop/products/${id}`, { prices: { coles: -1 } })).status, 400);

  // Removing a location forgets where things are there.
  await call('DELETE', `/shop/locations/${vincent.id}`);
  shop = (await call('GET', '/shop')).body;
  assert.deepEqual(shop.locations.map((l) => l.name), ['Castletown']);
  assert.equal(shop.sections.some((s) => s.location_id === vincent.id), false);
  // Forgetting a past item takes it off the list.
  await call('DELETE', `/shop/products/${id}`);
  shop = (await call('GET', '/shop')).body;
  assert.deepEqual([shop.products.length, shop.items.length], [0, 0]);
}));

test('shopping: kept in a backup and restored', () => withServer({}, async (call) => {
  const loc = (await call('POST', '/shop/locations', { store: 'coles', name: 'Townsville' })).body;
  const item = (await call('POST', '/shop/items', { name: 'Cheese', qty: 2 })).body;
  await call('PUT', `/shop/products/${item.product_id}/spot`, { location_id: loc.id, aisle: 7 });
  await call('PATCH', `/shop/products/${item.product_id}`, { prices: { coles: 650 } });
  const backup = (await call('GET', '/export')).body;
  assert.equal(backup.shopping.products.length, 1);
  await call('DELETE', `/shop/locations/${loc.id}`);
  await call('DELETE', `/shop/products/${item.product_id}`);
  const r = await call('POST', '/import', backup);
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.shop_products, 1);
  const shop = (await call('GET', '/shop')).body;
  assert.deepEqual(shop.items.map((i) => i.qty), [2]);
  assert.deepEqual([shop.products[0].prices, shop.products[0].spots[loc.id].aisle], [{ coles: 650 }, 7]);
  // A backup from before the shopping list leaves it as it is.
  delete backup.shopping;
  await call('POST', '/import', backup);
  assert.equal((await call('GET', '/shop')).body.products.length, 1);
}));
