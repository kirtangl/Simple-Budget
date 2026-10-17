'use strict';

// The shopping list: stores (Woolworths, Coles, Aldi, and any the household adds), their locations,
// the aisles and named sections at each location, products (with a size, a price at each store and
// a spot at each location), and the lists themselves. It stands apart from the budget. The only
// link is logins: the shared list or a login's own, and who ticked something off.

const express = require('express');
const { transaction, getSetting } = require('./db');

const MAX_AISLE = 20;
const UNITS = ['g', 'kg', 'mL', 'L', 'each', 'pack'];
// A price can be for each one, or by weight or volume, worked out from the size: $10 per kg for a
// 500 g pack is $5. [what it's measured in, how many g or mL the price is for]
const PRICE_PER = { each: null, kg: ['weight', 1000], '100g': ['weight', 100], L: ['volume', 1000], '100mL': ['volume', 100] };
const MEASURE = { g: 'weight', kg: 'weight', mL: 'volume', L: 'volume' };
// Colours for stores added later, after the chains' own.
const STORE_COLOURS = ['#ea580c', '#9333ea', '#0891b2', '#db2777', '#ca8a04', '#64748b'];
// Named sections a new location starts with. A section's order puts it among the aisles:
// 0.1 to 0.9 come before Aisle 1 (in that order), and 21 comes after Aisle 20.
const DEFAULT_SECTIONS = [['Produce', 0.1], ['Bakery', 0.2], ['Deli', 0.3], ['Meat', 0.4], ['Dairy', 21.1], ['Freezer', 21.2]];
const LIMITS = { stores: 20, locations: 50, sections: 60, products: 5000, items: 500 };

class BadRequest extends Error {}

const text = (v, label) => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s) throw new BadRequest(`${label} can't be empty.`);
  if (s.length > 80) throw new BadRequest(`${label} is too long (80 characters at most).`);
  return s;
};
const int = (v, lo, hi, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new BadRequest(`${label} should be a whole number from ${lo} to ${hi}.`);
  return n;
};
// A section's order: 0 to 99, with up to two decimal places (0.1, 0.25 ...).
const order = (v) => {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || n < 0 || n > 99 || Math.round(n * 100) !== n * 100) {
    throw new BadRequest('The order should be a number from 0 to 99, like 3 or 0.2.');
  }
  return n;
};
// A product's size and unit, like 2 L or 500 g. Both can be left out; a size needs a unit.
function sizeOf(b) {
  const size = b.size === undefined || b.size === null || b.size === '' ? null : Number(b.size);
  const unit = b.unit === undefined || b.unit === null || b.unit === '' ? null : b.unit;
  if (size !== null && (!Number.isFinite(size) || size <= 0 || size > 100000)) throw new BadRequest('The size should be a number, like 2 or 500.');
  if (unit !== null && !UNITS.includes(unit)) throw new BadRequest(`The unit should be one of ${UNITS.join(', ')}.`);
  if (size !== null && unit === null) throw new BadRequest('Pick a unit for the size, like g or L.');
  return { size, unit };
}
const colour = (v) => {
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw new BadRequest('The colour should look like #1f2937.');
  return v.toLowerCase();
};
// The chains' search links (also set by migration 22), filled in when one is added by name.
const KNOWN_SEARCH = {
  woolworths: 'https://www.woolworths.com.au/shop/search/products?searchTerm={q}',
  coles: 'https://www.coles.com.au/search/products?q={q}',
  aldi: 'https://www.aldi.com.au/results?q={q}',
};
// A store's search link: its website's search page with {q} where the product goes, like
// https://www.example.com.au/search?q={q}. Blank for none.
const searchUrl = (v) => {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return null;
  const s = typeof v === 'string' ? v.trim() : '';
  let ok = s.length <= 300 && s.includes('{q}');
  try { ok = ok && new URL(s.replace(/\{q\}/g, 'x')).protocol === 'https:'; } catch { ok = false; }
  if (!ok) throw new BadRequest('The search link should start with https:// and have {q} where the product name goes.');
  return s;
};
// Pricing by weight or volume needs a size it can be worked out from.
function pricePer(per, size, unit) {
  if (!(per in PRICE_PER)) throw new BadRequest(`The price should be per ${Object.keys(PRICE_PER).join(', ')}.`);
  if (PRICE_PER[per] && (!size || MEASURE[unit] !== PRICE_PER[per][0])) {
    throw new BadRequest(`To price per ${per}, give the size in ${PRICE_PER[per][0] === 'weight' ? 'g or kg' : 'mL or L'}.`);
  }
  return per;
}
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

function createShop(db) {
  const router = express.Router();
  const count = (table, where = '', ...args) => db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get(...args).n;
  const one = (sql, ...args) => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; };
  const all = (sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));

  // Goes up with every change, so open lists can tell when to fetch again.
  let rev = 1;
  router.use((req, res, next) => {
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) rev += 1; });
    next();
  });

  // Which list a request means: the shared one (no owner), or the login's own.
  const listOf = (req) => {
    const list = (req.query && req.query.list) || body(req).list || 'shared';
    if (list !== 'shared' && list !== 'mine') throw new BadRequest('That list does not exist.');
    return list;
  };
  const ownerOf = (req, list) => (list === 'mine' ? req.login.id : null);
  const onList = (who) => (who === null ? ['owner_id IS NULL', []] : ['owner_id = ?', [who]]);
  // An item is only reachable from the shared list or the login's own.
  const itemFor = (req) => {
    const item = one('SELECT * FROM shop_items WHERE id = ?', Number(req.params.id));
    if (!item || (item.owner_id !== null && item.owner_id !== req.login.id)) return null;
    return item;
  };
  const loginsById = () => new Map([[0, { name: getSetting(db, 'main_login_name') || 'Main', colour: getSetting(db, 'main_colour') || null }],
    ...all('SELECT id, name, colour FROM logins').map((l) => [l.id, { name: l.name, colour: l.colour || null }])]);
  const exists = (table, id) => Boolean(one(`SELECT id FROM ${table} WHERE id = ?`, Number(id)));

  function productsView() {
    const prices = all('SELECT * FROM shop_prices');
    const spots = all('SELECT * FROM shop_spots');
    return all('SELECT * FROM shop_products ORDER BY name COLLATE NOCASE, size').map((p) => ({
      ...p,
      prices: Object.fromEntries(prices.filter((x) => x.product_id === p.id).map((x) => [x.store_id, x.price_cents])),
      checked: Object.fromEntries(prices.filter((x) => x.product_id === p.id).map((x) => [x.store_id, x.checked_at])),
      spots: Object.fromEntries(spots.filter((x) => x.product_id === p.id)
        .map((x) => [x.location_id, { aisle: x.aisle, section_id: x.section_id, missing: Boolean(x.missing) }])),
    }));
  }

  function view(req) {
    const list = listOf(req);
    const [where, args] = onList(ownerOf(req, list));
    const logins = loginsById();
    const mine = req.login.id;
    return {
      rev,
      list,
      max_aisle: MAX_AISLE,
      units: UNITS,
      price_per: Object.keys(PRICE_PER),
      stores: all('SELECT * FROM shop_stores ORDER BY sort_order, id'),
      locations: all('SELECT * FROM shop_locations ORDER BY name COLLATE NOCASE'),
      sections: all('SELECT * FROM shop_sections ORDER BY location_id, position, name COLLATE NOCASE'),
      products: productsView(),
      items: all(`SELECT id, product_id, qty, done_at, done_by, done_store_id FROM shop_items WHERE ${where} ORDER BY id`, ...args)
        .map((it) => {
          const who = it.done_at ? logins.get(it.done_by) : null;
          return { ...it, done_by_name: who ? who.name : null, done_by_colour: who ? who.colour : null };
        }),
      counts: {
        shared: count('shop_items', 'WHERE owner_id IS NULL AND done_at IS NULL'),
        mine: count('shop_items', 'WHERE owner_id = ? AND done_at IS NULL', mine),
      },
    };
  }

  router.get('/', (req, res) => res.json(view(req)));
  router.get('/rev', (req, res) => res.json({ rev }));

  // ---------- Stores, their locations and the sections at each ----------

  router.post('/stores', (req, res) => {
    const b = body(req);
    const name = text(b.name, 'The store');
    const n = count('shop_stores');
    if (n >= LIMITS.stores) throw new BadRequest(`That's more stores than the list can keep (${LIMITS.stores}).`);
    const c = b.color ? colour(b.color) : STORE_COLOURS[n % STORE_COLOURS.length];
    const { lastInsertRowid } = db.prepare('INSERT INTO shop_stores (name, sort_order, color, search_url) VALUES (?, ?, ?, ?)')
      .run(name, n, c, 'search_url' in b ? searchUrl(b.search_url) : KNOWN_SEARCH[name.toLowerCase()] || null);
    res.status(201).json(one('SELECT * FROM shop_stores WHERE id = ?', Number(lastInsertRowid)));
  });

  router.patch('/stores/:id', (req, res) => {
    const id = Number(req.params.id);
    const before = one('SELECT * FROM shop_stores WHERE id = ?', id);
    if (!before) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const name = 'name' in b ? text(b.name, 'The store') : before.name;
    const c = 'color' in b ? colour(b.color) : before.color;
    const link = 'search_url' in b ? searchUrl(b.search_url) : before.search_url;
    db.prepare('UPDATE shop_stores SET name = ?, color = ?, search_url = ? WHERE id = ?').run(name, c, link, id);
    res.json(one('SELECT * FROM shop_stores WHERE id = ?', id));
  });

  // Its locations and prices go with it.
  router.delete('/stores/:id', (req, res) => {
    const { changes } = db.prepare('DELETE FROM shop_stores WHERE id = ?').run(Number(req.params.id));
    if (!changes) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });

  router.post('/locations', (req, res) => {
    const b = body(req);
    if (!exists('shop_stores', b.store_id)) throw new BadRequest('Pick a store.');
    const name = text(b.name, 'The location');
    if (count('shop_locations') >= LIMITS.locations) throw new BadRequest(`That's more locations than the list can keep (${LIMITS.locations}).`);
    const id = transaction(db, () => {
      const { lastInsertRowid } = db.prepare('INSERT INTO shop_locations (store_id, name) VALUES (?, ?)').run(Number(b.store_id), name);
      const add = db.prepare('INSERT INTO shop_sections (location_id, name, position) VALUES (?, ?, ?)');
      for (const [n, pos] of DEFAULT_SECTIONS) add.run(lastInsertRowid, n, pos);
      return Number(lastInsertRowid);
    });
    res.status(201).json(one('SELECT * FROM shop_locations WHERE id = ?', id));
  });

  router.patch('/locations/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!exists('shop_locations', id)) return res.status(404).json({ error: 'Not found.' });
    db.prepare('UPDATE shop_locations SET name = ? WHERE id = ?').run(text(body(req).name, 'The location'), id);
    res.json(one('SELECT * FROM shop_locations WHERE id = ?', id));
  });

  router.delete('/locations/:id', (req, res) => {
    const { changes } = db.prepare('DELETE FROM shop_locations WHERE id = ?').run(Number(req.params.id));
    if (!changes) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });

  router.post('/sections', (req, res) => {
    const b = body(req);
    const locationId = Number(b.location_id);
    if (!exists('shop_locations', locationId)) return res.status(404).json({ error: 'Not found.' });
    if (count('shop_sections', 'WHERE location_id = ?', locationId) >= LIMITS.sections) {
      throw new BadRequest(`That's more sections than one location can keep (${LIMITS.sections}).`);
    }
    const name = text(b.name, 'The section');
    if (/^(aisle\s*)?\d+$/i.test(name)) throw new BadRequest('Numbered aisles are already there. Give a section a name, like Dairy.');
    const { lastInsertRowid } = db.prepare('INSERT INTO shop_sections (location_id, name, position) VALUES (?, ?, ?)')
      .run(locationId, name, order(b.position ?? 21));
    res.status(201).json(one('SELECT * FROM shop_sections WHERE id = ?', Number(lastInsertRowid)));
  });

  router.patch('/sections/:id', (req, res) => {
    const id = Number(req.params.id);
    const before = one('SELECT * FROM shop_sections WHERE id = ?', id);
    if (!before) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const name = 'name' in b ? text(b.name, 'The section') : before.name;
    const position = 'position' in b ? order(b.position) : before.position;
    db.prepare('UPDATE shop_sections SET name = ?, position = ? WHERE id = ?').run(name, position, id);
    res.json(one('SELECT * FROM shop_sections WHERE id = ?', id));
  });

  // Products in a removed section go back to unsorted at that location.
  router.delete('/sections/:id', (req, res) => {
    const { changes } = db.prepare('DELETE FROM shop_sections WHERE id = ?').run(Number(req.params.id));
    if (!changes) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });

  // ---------- Products ----------

  // The product a typed name means: the only one with that name (whatever its size), or the one
  // with no size, or a new one. Names match whatever the capitals.
  const productNamed = (name) => {
    const found = all('SELECT id, size FROM shop_products WHERE name = ?', name);
    if (found.length === 1) return found[0].id;
    const plain = found.find((p) => p.size === null);
    if (plain) return plain.id;
    if (count('shop_products') >= LIMITS.products) throw new BadRequest(`That's more products than the list can keep (${LIMITS.products}).`);
    return Number(db.prepare('INSERT INTO shop_products (name) VALUES (?)').run(name).lastInsertRowid);
  };
  const productView = (id) => productsView().find((p) => p.id === id);
  const sameProduct = (name, size, unit, id) => one(`SELECT id FROM shop_products WHERE name = ? AND coalesce(size, 0) = ? AND coalesce(unit, '') = ? AND id <> ?`,
    name, size ?? 0, unit ?? '', id);
  const sizeText = (size, unit) => (size ? ` (${size} ${unit})` : unit ? ` (${unit})` : '');

  // { name?, size?, unit?, price_per?, prices?: { [store id]: cents | null }, checked?: [store ids] }.
  // A changed price counts as checked today, and so does one in checked: looked at and still right.
  router.patch('/products/:id', (req, res) => {
    const id = Number(req.params.id);
    const before = one('SELECT * FROM shop_products WHERE id = ?', id);
    if (!before) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const name = 'name' in b ? text(b.name, 'The name') : before.name;
    const { size, unit } = 'size' in b || 'unit' in b ? sizeOf({ size: b.size, unit: b.unit }) : before;
    const per = pricePer('price_per' in b ? b.price_per : before.price_per, size, unit);
    if (sameProduct(name, size, unit, id)) throw new BadRequest(`"${name}${sizeText(size, unit)}" is already in your product list.`);
    const prices = b.prices && typeof b.prices === 'object' ? Object.entries(b.prices) : [];
    const set = prices.map(([s, cents]) => {
      if (!exists('shop_stores', s)) throw new BadRequest('That store no longer exists.');
      return [Number(s), cents === null || cents === '' ? null : int(cents, 0, 100000, 'The price')];
    });
    const checked = new Set(Array.isArray(b.checked) ? b.checked.map(Number) : []);
    transaction(db, () => {
      db.prepare('UPDATE shop_products SET name = ?, size = ?, unit = ?, price_per = ? WHERE id = ?').run(name, size, unit, per, id);
      for (const [s, cents] of set) {
        if (cents === null) { db.prepare('DELETE FROM shop_prices WHERE product_id = ? AND store_id = ?').run(id, s); continue; }
        db.prepare(`INSERT INTO shop_prices (product_id, store_id, price_cents, checked_at) VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT (product_id, store_id) DO UPDATE SET price_cents = excluded.price_cents,
          checked_at = CASE WHEN price_cents <> excluded.price_cents OR ? THEN excluded.checked_at ELSE checked_at END`)
          .run(id, s, cents, checked.has(s) ? 1 : 0);
      }
      for (const s of checked) {
        if (!set.some(([x]) => x === s)) db.prepare("UPDATE shop_prices SET checked_at = datetime('now') WHERE product_id = ? AND store_id = ?").run(id, s);
      }
    });
    res.json(productView(id));
  });

  // Where a product is at one location: { location_id, aisle } or { location_id, section_id },
  // { location_id, missing: true } for not sold there, or none of them to forget it.
  router.put('/products/:id/spot', (req, res) => {
    const id = Number(req.params.id);
    const b = body(req);
    const locationId = Number(b.location_id);
    if (!exists('shop_products', id) || !exists('shop_locations', locationId)) return res.status(404).json({ error: 'Not found.' });
    const aisle = b.aisle === null || b.aisle === undefined || b.aisle === '' ? null : int(b.aisle, 0, MAX_AISLE, 'The aisle');
    const sectionId = b.section_id ? Number(b.section_id) : null;
    if (sectionId && !one('SELECT id FROM shop_sections WHERE id = ? AND location_id = ?', sectionId, locationId)) {
      throw new BadRequest("That section isn't at this location.");
    }
    const missing = b.missing === true;
    if ([aisle !== null, sectionId !== null, missing].filter(Boolean).length > 1) throw new BadRequest('Pick one place for it.');
    transaction(db, () => {
      db.prepare('DELETE FROM shop_spots WHERE product_id = ? AND location_id = ?').run(id, locationId);
      if (aisle !== null || sectionId || missing) {
        db.prepare('INSERT INTO shop_spots (product_id, location_id, aisle, section_id, missing) VALUES (?, ?, ?, ?, ?)')
          .run(id, locationId, aisle, sectionId, missing ? 1 : 0);
      }
    });
    res.json(productView(id));
  });

  // Forgetting a product takes it off every list too.
  router.delete('/products/:id', (req, res) => {
    const { changes } = db.prepare('DELETE FROM shop_products WHERE id = ?').run(Number(req.params.id));
    if (!changes) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });

  // ---------- The lists ----------

  // { list, name } or { list, product_id }, and qty. Adding something already on the list adds
  // to how many; adding something ticked off puts it back, unticked.
  router.post('/items', (req, res) => {
    const b = body(req);
    const who = ownerOf(req, listOf(req));
    const [where, args] = onList(who);
    const qty = b.qty === undefined ? 1 : int(b.qty, 1, 99, 'How many');
    const result = transaction(db, () => {
      let productId;
      if (b.product_id !== undefined) {
        productId = Number(b.product_id);
        if (!exists('shop_products', productId)) throw new BadRequest('That item no longer exists.');
      } else {
        productId = productNamed(text(b.name, 'The item'));
      }
      const existing = one(`SELECT * FROM shop_items WHERE product_id = ? AND ${where}`, productId, ...args);
      if (existing && existing.done_at) {
        db.prepare('UPDATE shop_items SET qty = ?, done_at = NULL, done_by = NULL, done_store_id = NULL WHERE id = ?').run(qty, existing.id);
        return { id: existing.id, added: false };
      }
      if (existing) {
        db.prepare('UPDATE shop_items SET qty = min(99, qty + ?) WHERE id = ?').run(qty, existing.id);
        return { id: existing.id, added: false };
      }
      if (count('shop_items', `WHERE ${where}`, ...args) >= LIMITS.items) throw new BadRequest(`That's more than one list can hold (${LIMITS.items}).`);
      const { lastInsertRowid } = db.prepare('INSERT INTO shop_items (product_id, owner_id, qty) VALUES (?, ?, ?)').run(productId, who, qty);
      return { id: Number(lastInsertRowid), added: true };
    });
    res.status(result.added ? 201 : 200).json(one('SELECT id, product_id, qty, done_at FROM shop_items WHERE id = ?', result.id));
  });

  // { qty } and/or { done: true | false, store_id }. Ticking off notes who did it, and at which store.
  router.patch('/items/:id', (req, res) => {
    const item = itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const store = b.store_id && exists('shop_stores', b.store_id) ? Number(b.store_id) : null;
    transaction(db, () => {
      if ('qty' in b) db.prepare('UPDATE shop_items SET qty = ? WHERE id = ?').run(int(b.qty, 1, 99, 'How many'), item.id);
      if (b.done === true && !item.done_at) {
        db.prepare("UPDATE shop_items SET done_at = datetime('now'), done_by = ?, done_store_id = ? WHERE id = ?").run(req.login.id, store, item.id);
      }
      if (b.done === false) db.prepare('UPDATE shop_items SET done_at = NULL, done_by = NULL, done_store_id = NULL WHERE id = ?').run(item.id);
    });
    res.json(one('SELECT id, product_id, qty, done_at, done_by, done_store_id FROM shop_items WHERE id = ?', item.id));
  });

  // Taken off the list without being bought. It stays in the product list.
  router.delete('/items/:id', (req, res) => {
    const item = itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found.' });
    db.prepare('DELETE FROM shop_items WHERE id = ?').run(item.id);
    res.json({ ok: true });
  });

  // Clears what's been ticked off, leaving anything not found yet on the list for next time.
  router.post('/items/clear', (req, res) => {
    const [where, args] = onList(ownerOf(req, listOf(req)));
    const { changes } = db.prepare(`DELETE FROM shop_items WHERE done_at IS NOT NULL AND ${where}`).run(...args);
    res.json({ ok: true, cleared: changes });
  });

  router.use((err, req, res, next) => {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err && /UNIQUE/.test(err.message)) return res.status(400).json({ error: 'That name is already used.' });
    next(err);
  });

  return router;
}

// ---------- Backup and restore ----------

const SHOP_TABLES = {
  stores: ['shop_stores', ['id', 'name', 'sort_order', 'color', 'search_url']],
  locations: ['shop_locations', ['id', 'store_id', 'name']],
  sections: ['shop_sections', ['id', 'location_id', 'name', 'position']],
  products: ['shop_products', ['id', 'name', 'size', 'unit', 'price_per']],
  prices: ['shop_prices', ['product_id', 'store_id', 'price_cents', 'checked_at']],
  // Each product's own listing at a store, for automatic prices (filled in from 0.9.9).
  matches: ['shop_matches', ['product_id', 'store_id', 'url', 'name', 'size']],
  spots: ['shop_spots', ['product_id', 'location_id', 'aisle', 'section_id', 'missing']],
  items: ['shop_items', ['id', 'product_id', 'owner_id', 'qty', 'added_at', 'done_at', 'done_by', 'done_store_id']],
};

function exportShop(db) {
  return Object.fromEntries(Object.entries(SHOP_TABLES).map(([key, [table, cols]]) => [key,
    db.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all().map((r) => ({ ...r }))]));
}

// Replaces the shopping list with the backup's. Rows keep their ids, since nothing outside the
// shopping list refers to them. Returns how many products were restored, and how many rows were left out.
function importShop(db, data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.stores)) return null;
  for (const [table] of Object.values(SHOP_TABLES).reverse()) db.exec(`DELETE FROM ${table}`);
  let skipped = 0;
  for (const [key, [table, cols]] of Object.entries(SHOP_TABLES)) {
    const rows = Array.isArray(data[key]) ? data[key] : [];
    for (const row of rows.slice(0, LIMITS.products * 4)) {
      // Columns the row leaves out get their defaults.
      const given = row && typeof row === 'object' ? cols.filter((c) => row[c] !== undefined && row[c] !== null) : [];
      const values = given.map((c) => (typeof row[c] === 'boolean' ? Number(row[c]) : row[c]));
      if (!given.length || values.some((v) => typeof v !== 'string' && typeof v !== 'number')) { skipped += 1; continue; }
      try {
        db.prepare(`INSERT INTO ${table} (${given.join(', ')}) VALUES (${given.map(() => '?').join(', ')})`).run(...values);
      } catch { skipped += 1; }
    }
  }
  return { products: db.prepare('SELECT count(*) AS n FROM shop_products').get().n, skipped };
}

module.exports = { createShop, exportShop, importShop, UNITS };
