'use strict';

// The shopping list: stores and their locations, the aisles and sections at each location,
// products (with a price at each chain and a spot at each location), and the lists themselves.
// It stands apart from the budget. The only link is logins: the shared list, or a login's own.

const express = require('express');
const { transaction } = require('./db');

const STORES = ['woolworths', 'coles', 'aldi'];
const MAX_AISLE = 20;
// Named sections a new location starts with. A section's position puts it among the aisles:
// 0 comes before Aisle 1, and 21 comes after Aisle 20.
const DEFAULT_SECTIONS = [['Produce', 0], ['Bakery', 0], ['Deli', 0], ['Meat', 0], ['Dairy', 21], ['Freezer', 21]];
const LIMITS = { locations: 50, sections: 60, products: 5000, items: 500 };

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
const store = (v) => {
  if (!STORES.includes(v)) throw new BadRequest('Pick Woolworths, Coles or Aldi.');
  return v;
};
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

function createShop(db) {
  const router = express.Router();
  const count = (table, where = '', ...args) => db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get(...args).n;
  const one = (sql, ...args) => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; };
  const all = (sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));

  // Which list a request means: the shared one (no owner), or the login's own.
  const owner = (req, list) => (list === 'mine' ? req.login.id : null);
  const listOf = (req) => {
    const list = (req.query && req.query.list) || body(req).list || 'shared';
    if (list !== 'shared' && list !== 'mine') throw new BadRequest('That list does not exist.');
    return list;
  };
  // An item is only reachable from the shared list or the login's own.
  const itemFor = (req) => {
    const item = one('SELECT * FROM shop_items WHERE id = ?', Number(req.params.id));
    if (!item || (item.owner_id !== null && item.owner_id !== req.login.id)) return null;
    return item;
  };

  function view(req) {
    const list = listOf(req);
    const prices = all('SELECT * FROM shop_prices');
    const spots = all('SELECT * FROM shop_spots');
    const products = all('SELECT id, name FROM shop_products ORDER BY name COLLATE NOCASE').map((p) => ({
      ...p,
      prices: Object.fromEntries(prices.filter((x) => x.product_id === p.id).map((x) => [x.store, x.price_cents])),
      spots: Object.fromEntries(spots.filter((x) => x.product_id === p.id)
        .map((x) => [x.location_id, { aisle: x.aisle, section_id: x.section_id, missing: Boolean(x.missing) }])),
    }));
    const mine = req.login.id;
    return {
      list,
      stores: STORES,
      max_aisle: MAX_AISLE,
      locations: all('SELECT * FROM shop_locations ORDER BY store, sort_order, name COLLATE NOCASE'),
      sections: all('SELECT * FROM shop_sections ORDER BY location_id, position, name COLLATE NOCASE'),
      products,
      items: owner(req, list) === null
        ? all('SELECT id, product_id, qty FROM shop_items WHERE owner_id IS NULL ORDER BY id')
        : all('SELECT id, product_id, qty FROM shop_items WHERE owner_id = ? ORDER BY id', mine),
      counts: { shared: count('shop_items', 'WHERE owner_id IS NULL'), mine: count('shop_items', 'WHERE owner_id = ?', mine) },
    };
  }

  router.get('/', (req, res) => res.json(view(req)));

  // ---------- Locations and their sections ----------

  router.post('/locations', (req, res) => {
    const b = body(req);
    const s = store(b.store);
    const name = text(b.name, 'The location');
    if (count('shop_locations') >= LIMITS.locations) throw new BadRequest(`That's more locations than the list can keep (${LIMITS.locations}).`);
    const id = transaction(db, () => {
      const { lastInsertRowid } = db.prepare('INSERT INTO shop_locations (store, name, sort_order) VALUES (?, ?, ?)')
        .run(s, name, count('shop_locations', 'WHERE store = ?', s));
      const add = db.prepare('INSERT INTO shop_sections (location_id, name, position) VALUES (?, ?, ?)');
      for (const [n, pos] of DEFAULT_SECTIONS) add.run(lastInsertRowid, n, pos);
      return Number(lastInsertRowid);
    });
    res.status(201).json(one('SELECT * FROM shop_locations WHERE id = ?', id));
  });

  router.patch('/locations/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!one('SELECT id FROM shop_locations WHERE id = ?', id)) return res.status(404).json({ error: 'Not found.' });
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
    if (!one('SELECT id FROM shop_locations WHERE id = ?', locationId)) return res.status(404).json({ error: 'Not found.' });
    if (count('shop_sections', 'WHERE location_id = ?', locationId) >= LIMITS.sections) {
      throw new BadRequest(`That's more sections than one location can keep (${LIMITS.sections}).`);
    }
    const name = text(b.name, 'The section');
    if (/^(aisle\s*)?\d+$/i.test(name)) throw new BadRequest('Numbered aisles are already there. Give a section a name, like Dairy.');
    const { lastInsertRowid } = db.prepare('INSERT INTO shop_sections (location_id, name, position) VALUES (?, ?, ?)')
      .run(locationId, name, int(b.position ?? 0, 0, 99, 'The order'));
    res.status(201).json(one('SELECT * FROM shop_sections WHERE id = ?', Number(lastInsertRowid)));
  });

  router.patch('/sections/:id', (req, res) => {
    const id = Number(req.params.id);
    const before = one('SELECT * FROM shop_sections WHERE id = ?', id);
    if (!before) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const name = 'name' in b ? text(b.name, 'The section') : before.name;
    const position = 'position' in b ? int(b.position, 0, 99, 'The order') : before.position;
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

  // The product with this name, made if it's new. Names match whatever the capitals.
  const productNamed = (name) => {
    const found = one('SELECT id FROM shop_products WHERE name = ?', name);
    if (found) return found.id;
    if (count('shop_products') >= LIMITS.products) throw new BadRequest(`That's more products than the list can keep (${LIMITS.products}).`);
    return Number(db.prepare('INSERT INTO shop_products (name) VALUES (?)').run(name).lastInsertRowid);
  };

  // { name?, prices?: { woolworths: cents | null, ... } }
  router.patch('/products/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!one('SELECT id FROM shop_products WHERE id = ?', id)) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const name = 'name' in b ? text(b.name, 'The name') : null;
    if (name && one('SELECT id FROM shop_products WHERE name = ? AND id <> ?', name, id)) {
      throw new BadRequest(`"${name}" is already in your past items.`);
    }
    const prices = b.prices && typeof b.prices === 'object' ? b.prices : {};
    const set = Object.entries(prices).map(([s, cents]) => [store(s), cents === null || cents === '' ? null : int(cents, 0, 100000, 'The price')]);
    transaction(db, () => {
      if (name) db.prepare('UPDATE shop_products SET name = ? WHERE id = ?').run(name, id);
      for (const [s, cents] of set) {
        if (cents === null) db.prepare('DELETE FROM shop_prices WHERE product_id = ? AND store = ?').run(id, s);
        else db.prepare('INSERT INTO shop_prices (product_id, store, price_cents) VALUES (?, ?, ?) ON CONFLICT (product_id, store) DO UPDATE SET price_cents = excluded.price_cents').run(id, s, cents);
      }
    });
    res.json(view(req).products.find((p) => p.id === id));
  });

  // Where a product is at one location: { location_id, aisle } or { location_id, section_id },
  // { location_id, missing: true } for not sold there, or neither to forget it.
  router.put('/products/:id/spot', (req, res) => {
    const id = Number(req.params.id);
    const b = body(req);
    const locationId = Number(b.location_id);
    if (!one('SELECT id FROM shop_products WHERE id = ?', id) || !one('SELECT id FROM shop_locations WHERE id = ?', locationId)) {
      return res.status(404).json({ error: 'Not found.' });
    }
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
    res.json(view(req).products.find((p) => p.id === id));
  });

  // Forgetting a past item takes it off every list too.
  router.delete('/products/:id', (req, res) => {
    const { changes } = db.prepare('DELETE FROM shop_products WHERE id = ?').run(Number(req.params.id));
    if (!changes) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });

  // ---------- The list ----------

  // { list, name } or { list, product_id }, and qty. Adding something already on the list adds to how many.
  router.post('/items', (req, res) => {
    const b = body(req);
    const who = owner(req, listOf(req));
    const qty = b.qty === undefined ? 1 : int(b.qty, 1, 99, 'How many');
    const result = transaction(db, () => {
      let productId;
      if (b.product_id !== undefined) {
        productId = Number(b.product_id);
        if (!one('SELECT id FROM shop_products WHERE id = ?', productId)) throw new BadRequest('That item no longer exists.');
      } else {
        productId = productNamed(text(b.name, 'The item'));
      }
      const existing = who === null
        ? one('SELECT * FROM shop_items WHERE product_id = ? AND owner_id IS NULL', productId)
        : one('SELECT * FROM shop_items WHERE product_id = ? AND owner_id = ?', productId, who);
      if (existing) {
        db.prepare('UPDATE shop_items SET qty = min(99, qty + ?) WHERE id = ?').run(qty, existing.id);
        return { id: existing.id, added: false };
      }
      if (count('shop_items', who === null ? 'WHERE owner_id IS NULL' : 'WHERE owner_id = ?', ...(who === null ? [] : [who])) >= LIMITS.items) {
        throw new BadRequest(`That's more than one list can hold (${LIMITS.items}).`);
      }
      const { lastInsertRowid } = db.prepare('INSERT INTO shop_items (product_id, owner_id, qty) VALUES (?, ?, ?)').run(productId, who, qty);
      return { id: Number(lastInsertRowid), added: true };
    });
    res.status(result.added ? 201 : 200).json(one('SELECT id, product_id, qty FROM shop_items WHERE id = ?', result.id));
  });

  router.patch('/items/:id', (req, res) => {
    const item = itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found.' });
    db.prepare('UPDATE shop_items SET qty = ? WHERE id = ?').run(int(body(req).qty, 1, 99, 'How many'), item.id);
    res.json(one('SELECT id, product_id, qty FROM shop_items WHERE id = ?', item.id));
  });

  // Ticked off (or removed): it leaves the list, and stays in past items for next time.
  router.delete('/items/:id', (req, res) => {
    const item = itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found.' });
    db.prepare('DELETE FROM shop_items WHERE id = ?').run(item.id);
    res.json({ ok: true, product_id: item.product_id, qty: item.qty });
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
  locations: ['shop_locations', ['id', 'store', 'name', 'sort_order']],
  sections: ['shop_sections', ['id', 'location_id', 'name', 'position']],
  products: ['shop_products', ['id', 'name']],
  prices: ['shop_prices', ['product_id', 'store', 'price_cents']],
  spots: ['shop_spots', ['product_id', 'location_id', 'aisle', 'section_id', 'missing']],
  items: ['shop_items', ['id', 'product_id', 'owner_id', 'qty', 'added_at']],
};

function exportShop(db) {
  return Object.fromEntries(Object.entries(SHOP_TABLES).map(([key, [table, cols]]) => [key,
    db.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all().map((r) => ({ ...r }))]));
}

// Replaces the shopping list with the backup's. Rows keep their ids, since nothing outside the
// shopping list refers to them. Returns how many products were restored, and anything left out.
function importShop(db, data) {
  if (!data || typeof data !== 'object') return null;
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

module.exports = { createShop, exportShop, importShop, STORES };
