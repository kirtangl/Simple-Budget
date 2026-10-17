'use strict';

// The shopping list: stores (Woolworths, Coles, Aldi, and any the household adds), their locations,
// the aisles and named sections at each location, products (with a size, a price at each store and
// a spot at each location), and the lists themselves. It stands apart from the budget. The only
// link is logins: the shared list or a login's own, and who ticked something off.

const express = require('express');
const { transaction, getSetting } = require('./db');
const { CheckerError } = require('./checker');

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
// The stores the price-checker knows, and the chains that are them.
const CHECKER_STORES = ['woolworths', 'coles', 'aldi'];
const checkerOf = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (!CHECKER_STORES.includes(v)) throw new BadRequest(`Automatic prices can come from ${CHECKER_STORES.join(', ')}.`);
  return v;
};
// The supermarkets change prices on Wednesday mornings, so a price checked before 9am last
// Wednesday (the server's time) is out of date. As SQLite writes datetime('now'), in UTC.
function priceDay(now = new Date()) {
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 4) % 7));
  if (d > now) d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
// A size written by a store, like "750g", "2 L" or "6 pack", in g, mL or how many.
function measureOf(text) {
  const m = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|pk|pack|each)\b/i.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'kg') return ['weight', n * 1000];
  if (u === 'g') return ['weight', n];
  if (u === 'l') return ['volume', n * 1000];
  if (u === 'ml') return ['volume', n];
  return ['count', n];
}
const WORDS_SKIPPED = new Set(['the', 'and', 'with', 'for', 'pack', 'each']);
const wordsOf = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !WORDS_SKIPPED.has(w)));

// Pricing by weight or volume needs a size it can be worked out from.
function pricePer(per, size, unit) {
  if (!(per in PRICE_PER)) throw new BadRequest(`The price should be per ${Object.keys(PRICE_PER).join(', ')}.`);
  if (PRICE_PER[per] && (!size || MEASURE[unit] !== PRICE_PER[per][0])) {
    throw new BadRequest(`To price per ${per}, give the size in ${PRICE_PER[per][0] === 'weight' ? 'g or kg' : 'mL or L'}.`);
  }
  return per;
}
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

function createShop(db, { checker = null } = {}) {
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
    const matches = all('SELECT * FROM shop_matches');
    const similar = new Map(all('SELECT * FROM shop_similar').map((x) => [x.product_id, x]));
    return all('SELECT * FROM shop_products ORDER BY name COLLATE NOCASE, size').map((p) => ({
      ...p,
      prices: Object.fromEntries(prices.filter((x) => x.product_id === p.id).map((x) => [x.store_id, x.price_cents])),
      checked: Object.fromEntries(prices.filter((x) => x.product_id === p.id).map((x) => [x.store_id, x.checked_at])),
      was: Object.fromEntries(prices.filter((x) => x.product_id === p.id && x.was_cents).map((x) => [x.store_id, x.was_cents])),
      matches: Object.fromEntries(matches.filter((x) => x.product_id === p.id)
        .map((x) => [x.store_id, { url: x.url, name: x.name, size: x.size, missing_at: x.missing_at }])),
      similar: similar.get(p.id) || null,
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
      // Automatic prices, when there's a price-checker: what counts as up to date.
      checker: checker && checker.on ? { stores: CHECKER_STORES, since: priceDay() } : null,
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
    const chain = CHECKER_STORES.includes(name.toLowerCase()) ? name.toLowerCase() : null;
    const { lastInsertRowid } = db.prepare('INSERT INTO shop_stores (name, sort_order, color, search_url, checker) VALUES (?, ?, ?, ?, ?)')
      .run(name, n, c, 'search_url' in b ? searchUrl(b.search_url) : KNOWN_SEARCH[name.toLowerCase()] || null, 'checker' in b ? checkerOf(b.checker) : chain);
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
    const auto = 'checker' in b ? checkerOf(b.checker) : before.checker;
    db.prepare('UPDATE shop_stores SET name = ?, color = ?, search_url = ?, checker = ? WHERE id = ?').run(name, c, link, auto, id);
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
          was_cents = CASE WHEN price_cents <> excluded.price_cents THEN NULL ELSE was_cents END,
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

  // ---------- Automatic prices (the price-checker) ----------

  // The checks this app started, by the checker's job id: what each was for, so results go to
  // the right products and stores. Kept for an hour.
  const started = new Map();
  const needChecker = () => {
    if (!checker || !checker.on) throw new BadRequest('Automatic prices are not set up. See "Automatic prices" in the README.');
  };
  const checkerStores = (ids) => all('SELECT * FROM shop_stores WHERE checker IS NOT NULL ORDER BY sort_order, id')
    .filter((s) => !ids || ids.includes(s.id));
  const remember = (job, meta) => {
    for (const [id, m] of started) if (Date.now() - m.at > 60 * 60e3) started.delete(id);
    started.set(job.id, { ...meta, at: Date.now() });
  };
  const queryOf = (p) => (p.size && MEASURE[p.unit] ? `${p.name} ${p.size}${p.unit}` : p.name);
  const startedJob = (id) => {
    const meta = started.get(String(id));
    if (!meta) throw new CheckerError('That check has finished.', 404);
    return meta;
  };
  // The checker's job as the app sees it: stores by their ids here.
  const jobView = (job, meta) => {
    const byKey = Object.fromEntries(Object.entries(meta.stores).map(([sid, key]) => [key, Number(sid)]));
    const stores = {};
    for (const [key, st] of Object.entries(job.stores || {})) if (key in byKey) stores[byKey[key]] = st;
    const out = { id: job.id, type: meta.type, state: job.state, waiting_for: job.waiting_for || 0, stores };
    if (meta.type === 'find') {
      out.product_id = meta.product_id;
      out.results = {};
      for (const [key, list] of Object.entries(job.results || {})) if (key in byKey) out.results[byKey[key]] = list;
    } else {
      out.total = Object.keys(meta.items).length;
      out.changes = meta.changes || null;
      out.missing = meta.missing || null;
      out.unmatched = meta.unmatched;
    }
    return out;
  };

  // A product's prices from a search at every store (or just the stores given, for a new match).
  router.post('/checker/find', async (req, res) => {
    needChecker();
    const b = body(req);
    const p = one('SELECT * FROM shop_products WHERE id = ?', Number(b.product_id));
    if (!p) return res.status(404).json({ error: 'Not found.' });
    const stores = checkerStores(Array.isArray(b.store_ids) ? b.store_ids.map(Number) : null);
    if (!stores.length) throw new BadRequest('None of your stores have automatic prices.');
    const keys = {};
    for (const s of stores) if (!Object.values(keys).includes(s.checker)) keys[s.id] = s.checker;
    const job = await checker.start({ type: 'search', q: queryOf(p), stores: Object.values(keys) });
    const meta = { type: 'find', product_id: p.id, stores: keys, all: !b.store_ids };
    remember(job, meta);
    res.status(201).json(jobView(job, meta));
  });

  // The products on a list whose matched prices are out of date: { list }. Products on the list not
  // matched at a store come back as unmatched, to find.
  router.post('/checker/update', async (req, res) => {
    needChecker();
    const [where, args] = onList(ownerOf(req, listOf(req)));
    const since = priceDay();
    const stores = checkerStores();
    const products = all(`SELECT DISTINCT product_id AS id FROM shop_items WHERE done_at IS NULL AND ${where}`, ...args).map((r) => r.id);
    const keys = {};
    const items = {};
    const toCheck = [];
    const unmatched = [];
    for (const pid of products) {
      for (const s of stores) {
        const m = one('SELECT * FROM shop_matches WHERE product_id = ? AND store_id = ?', pid, s.id);
        if (!m) { unmatched.push({ product_id: pid, store_id: s.id }); continue; }
        const price = one('SELECT checked_at FROM shop_prices WHERE product_id = ? AND store_id = ?', pid, s.id);
        if (price && price.checked_at && price.checked_at >= since) continue;
        const key = `${pid}:${s.id}`;
        keys[s.id] = s.checker;
        items[key] = [pid, s.id];
        toCheck.push({ key, store: s.checker, url: m.url, name: m.name, size: m.size });
      }
    }
    if (!toCheck.length) return res.json({ id: null, type: 'update', state: 'done', stores: {}, total: 0, changes: [], missing: [], unmatched });
    const job = await checker.start({ type: 'refresh', items: toCheck });
    const meta = { type: 'update', stores: keys, items, unmatched };
    remember(job, meta);
    follow(job.id);
    res.status(201).json(jobView(job, meta));
  });

  // Saves an update's new prices once it's finished, whether or not anyone's still watching.
  function follow(id) {
    const meta = started.get(id);
    if (!meta || meta.changes || Date.now() - meta.at > 60 * 60e3) return;
    const again = () => setTimeout(() => follow(id), 2000).unref?.();
    checker.get(id).then((job) => {
      if (job.state === 'done' || job.state === 'cancelled') applyUpdate(job, meta);
      else again();
    }, (err) => { if (!(err instanceof CheckerError && err.status === 404)) again(); });
  }

  function applyUpdate(job, meta) {
    if (meta.changes) return;
    const changes = [];
    const missing = [];
    transaction(db, () => {
      for (const r of Array.isArray(job.results) ? job.results : []) {
        const target = meta.items[r.key];
        if (!target) continue;
        const [pid, sid] = target;
        if (!r.found) {
          if (!r.error) {
            db.prepare("UPDATE shop_matches SET missing_at = datetime('now') WHERE product_id = ? AND store_id = ?").run(pid, sid);
            missing.push({ product_id: pid, store_id: sid });
          }
          continue;
        }
        const cents = Number.isInteger(r.price_cents) && r.price_cents > 0 && r.price_cents <= 100000 ? r.price_cents : null;
        if (!cents) continue;
        const before = one('SELECT price_cents FROM shop_prices WHERE product_id = ? AND store_id = ?', pid, sid);
        savePrice(pid, sid, cents, r.was_cents);
        db.prepare('UPDATE shop_matches SET missing_at = NULL WHERE product_id = ? AND store_id = ?').run(pid, sid);
        if (!before || before.price_cents !== cents) changes.push({ product_id: pid, store_id: sid, old_cents: before ? before.price_cents : null, new_cents: cents, special: Boolean(r.special) });
      }
    });
    meta.changes = changes;
    meta.missing = missing;
    rev += 1;
  }

  const savePrice = (pid, sid, cents, was) => {
    const normal = Number.isInteger(was) && was > cents && was <= 100000 ? was : null;
    db.prepare(`INSERT INTO shop_prices (product_id, store_id, price_cents, was_cents, checked_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (product_id, store_id) DO UPDATE SET price_cents = excluded.price_cents, was_cents = excluded.was_cents, checked_at = excluded.checked_at`)
      .run(pid, sid, cents, normal);
  };

  router.get('/checker/jobs/:id', async (req, res) => {
    const meta = startedJob(req.params.id);
    const job = await checker.get(req.params.id);
    if (meta.type === 'find' && job.state !== 'running' && job.state !== 'queued') meta.results = job.results;
    if (meta.type === 'update' && (job.state === 'done' || job.state === 'cancelled')) applyUpdate(job, meta);
    res.json(jobView(job, meta));
  });
  router.post('/checker/jobs/:id/cancel', async (req, res) => {
    const meta = startedJob(req.params.id);
    res.json(jobView(await checker.cancel(req.params.id), meta));
  });
  // Gave up on a bot check at a store: { store_id }.
  router.post('/checker/jobs/:id/skip', async (req, res) => {
    const meta = startedJob(req.params.id);
    const key = meta.stores[Number(body(req).store_id)];
    if (!key) return res.status(404).json({ error: 'Not found.' });
    res.json(jobView(await checker.skip(req.params.id, key), meta));
  });

  // What a store's tab shows while it waits for a person to get past a bot check, and their clicks.
  const keyOf = (id) => {
    const s = one('SELECT checker FROM shop_stores WHERE id = ?', Number(id));
    if (!s || !s.checker) throw new CheckerError('Not found.', 404);
    return s.checker;
  };
  router.get('/checker/screen/:store', async (req, res) => {
    needChecker();
    const shot = await checker.screen(keyOf(req.params.store));
    res.set({ 'Content-Type': 'image/jpeg', 'X-Width': String(shot.width || ''), 'X-Height': String(shot.height || '') }).send(shot.image);
  });
  router.post('/checker/input/:store', async (req, res) => {
    needChecker();
    const b = body(req);
    if (!['click', 'down', 'move', 'up', 'key', 'text'].includes(b.type)) throw new BadRequest('That kind of input does not exist.');
    const ev = { type: b.type, x: Number(b.x) || 0, y: Number(b.y) || 0 };
    if (typeof b.key === 'string') ev.key = b.key.slice(0, 20);
    if (typeof b.text === 'string') ev.text = b.text.slice(0, 100);
    res.json(await checker.input(keyOf(req.params.store), ev));
  });

  // The store listings picked for a product from a find: { job, picks: { [store id]: result's index,
  // or null for no match } }. Their prices are saved, and a cheaper similar product among all the
  // results (by its price per g, mL or each) is kept as a hint.
  router.put('/products/:id/matches', async (req, res) => {
    const id = Number(req.params.id);
    const p = one('SELECT * FROM shop_products WHERE id = ?', id);
    if (!p) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const meta = startedJob(b.job);
    if (meta.type !== 'find' || meta.product_id !== id) throw new BadRequest("That search wasn't for this product.");
    if (!meta.results) meta.results = (await checker.get(b.job)).results;
    const results = meta.results || {};
    const picks = b.picks && typeof b.picks === 'object' ? Object.entries(b.picks) : [];
    const chosen = new Set();
    transaction(db, () => {
      for (const [sid, index] of picks) {
        const key = meta.stores[Number(sid)];
        if (!key) throw new BadRequest('That store was not part of the search.');
        if (index === null) { db.prepare('DELETE FROM shop_matches WHERE product_id = ? AND store_id = ?').run(id, Number(sid)); continue; }
        const r = (results[key] || [])[int(index, 0, 1000, 'The pick')];
        if (!r) throw new BadRequest('That result is not there.');
        chosen.add(r);
        db.prepare(`INSERT INTO shop_matches (product_id, store_id, url, name, size, missing_at) VALUES (?, ?, ?, ?, ?, NULL)
          ON CONFLICT (product_id, store_id) DO UPDATE SET url = excluded.url, name = excluded.name, size = excluded.size, missing_at = NULL`)
          .run(id, Number(sid), String(r.url).slice(0, 500), String(r.name).slice(0, 200), r.size ? String(r.size).slice(0, 40) : null);
        savePrice(id, Number(sid), r.price_cents, r.was_cents);
      }
      const similar = cheaperSimilar(p, results, meta.stores, chosen);
      if (similar) {
        db.prepare(`INSERT INTO shop_similar (product_id, store_id, name, size, price_cents, url, seen_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT (product_id) DO UPDATE SET store_id = excluded.store_id, name = excluded.name, size = excluded.size,
          price_cents = excluded.price_cents, url = excluded.url, seen_at = excluded.seen_at`)
          .run(id, similar.store_id, similar.name.slice(0, 200), similar.size ? String(similar.size).slice(0, 40) : null, similar.price_cents, String(similar.url).slice(0, 500));
      } else if (meta.all) {
        db.prepare('DELETE FROM shop_similar WHERE product_id = ?').run(id);
      }
    });
    res.json(productView(id));
  });

  // The cheapest result, per g, mL or each, that's like the product (a word of its name in common,
  // and a size from half to twice as big) and at least 5% cheaper than its best price now.
  function cheaperSimilar(p, results, storeKeys, chosen) {
    const own = p.size && MEASURE[p.unit] ? measureOf(`${p.size}${p.unit}`) : null;
    const per = (price, size) => { const m = measureOf(size) || own; return m ? [m[0], price / m[1]] : null; };
    let best = null;
    for (const r of chosen) {
      const x = per(r.price_cents, r.size);
      if (x && (!best || x[1] < best[1])) best = x;
    }
    if (!best && own) {
      const cheapest = one('SELECT min(price_cents) AS c FROM shop_prices WHERE product_id = ?', p.id).c;
      if (cheapest) best = [own[0], cheapest / own[1]];
    }
    if (!best) return null;
    const words = wordsOf(p.name);
    const refSize = own ? own[1] : null;
    let found = null;
    for (const [sid, key] of Object.entries(storeKeys)) {
      for (const r of results[key] || []) {
        if (chosen.has(r) || r.available === false || !Number.isInteger(r.price_cents)) continue;
        const m = measureOf(r.size);
        if (!m || m[0] !== best[0]) continue;
        if (refSize && (m[1] < refSize / 2 || m[1] > refSize * 2)) continue;
        if (![...wordsOf(r.name)].some((w) => words.has(w))) continue;
        const cost = r.price_cents / m[1];
        if (cost < best[1] * 0.95 && (!found || cost < found.cost)) found = { ...r, store_id: Number(sid), cost };
      }
    }
    return found;
  }

  router.use((err, req, res, next) => {
    if (err instanceof CheckerError) return res.status(err.status).json({ error: err.message });
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err && /UNIQUE/.test(err.message)) return res.status(400).json({ error: 'That name is already used.' });
    next(err);
  });

  return router;
}

// ---------- Backup and restore ----------

const SHOP_TABLES = {
  stores: ['shop_stores', ['id', 'name', 'sort_order', 'color', 'search_url', 'checker']],
  locations: ['shop_locations', ['id', 'store_id', 'name']],
  sections: ['shop_sections', ['id', 'location_id', 'name', 'position']],
  products: ['shop_products', ['id', 'name', 'size', 'unit', 'price_per']],
  prices: ['shop_prices', ['product_id', 'store_id', 'price_cents', 'checked_at', 'was_cents']],
  // Each product's own listing at a store, for automatic prices, and a cheaper similar one.
  matches: ['shop_matches', ['product_id', 'store_id', 'url', 'name', 'size', 'missing_at']],
  similar: ['shop_similar', ['product_id', 'store_id', 'name', 'size', 'price_cents', 'url', 'seen_at']],
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

module.exports = { createShop, exportShop, importShop, priceDay, UNITS };
