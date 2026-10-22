'use strict';

// The shopping list: stores (Woolworths, Coles, Aldi, and any the household adds), their locations,
// the aisles and named sections at each location, products (with a size, a price at each store and
// a spot at each location), and the lists themselves. It stands apart from the budget. The only
// link is logins: the shared list or a login's own, and who ticked something off.

const express = require('express');
const { transaction, getSetting, setSetting } = require('./db');
const { CheckerError } = require('./checker');

const MAX_AISLE = 20;
const UNITS = ['g', 'kg', 'mL', 'L', 'each', 'pack'];
// How a product is bought: by the pack (or each), by weight (priced per kg, with an amount on the
// list), or by volume (packs again, compared per L).
const SOLD_BY = ['pack', 'weight', 'volume'];
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

const ITEM_COLS = 'id, product_id, qty, grams, note, swap_store_id, swap_kind, done_at, done_by, done_store_id';

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
// A store's name for something with its size taken out, so the same product in another size can be
// told apart from another flavour: "Oats Traditional 750g" and "Oats Traditional 1kg" match,
// "Oats Honey 750g" doesn't.
const SIZE_WORDS = /\b\d+(?:\.\d+)?\s*(?:x\s*\d+(?:\.\d+)?\s*)?(?:kg|g|ml|l|pk|pack|each)\b/gi;
const bareName = (s) => String(s || '').toLowerCase().replace(SIZE_WORDS, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// From a store's search, besides the product it's matched to: the same product's other size (a
// pack or bottle bigger or smaller, the cheapest for the amount) and the cheapest close match (a
// word of the name in common, from half to twice the size). Both are compared per g or mL, so a
// 1.94 L bottle and a 2 L one can be. Not for things bought by weight.
function optionsAt(p, list, match) {
  const out = {};
  if (!Array.isArray(list) || p.sold_by === 'weight') return out;
  const ok = (r) => r && typeof r.url === 'string' && /^https:\/\//.test(r.url) && typeof r.name === 'string' && r.available !== false
    && Number.isInteger(r.price_cents) && r.price_cents > 0 && r.price_cents <= 100000;
  const own = p.size && MEASURE[p.unit] ? measureOf(`${p.size}${p.unit}`) : null;
  const matched = match && match.url ? match : null;
  const ref = (matched && measureOf(matched.size)) || own;
  if (!ref) return out;
  const sizeOfR = (r) => measureOf(r.size) || measureOf(r.name);
  if (matched) {
    const bare = bareName(matched.name);
    for (const r of list) {
      if (!ok(r) || r.url === matched.url || bareName(r.name) !== bare) continue;
      const m = sizeOfR(r);
      if (!m || m[0] !== ref[0] || Math.abs(m[1] - ref[1]) <= ref[1] * 0.02) continue;
      const cost = r.price_cents / m[1];
      if (!out.size || cost < out.size.cost) out.size = { ...r, cost };
    }
  }
  const words = wordsOf(p.name);
  for (const r of list) {
    if (!ok(r) || (matched && r.url === matched.url) || (out.size && r.url === out.size.url)) continue;
    const m = sizeOfR(r);
    if (!m || m[0] !== ref[0] || m[1] < ref[1] / 2 || m[1] > ref[1] * 2) continue;
    if (![...wordsOf(r.name)].some((w) => words.has(w))) continue;
    const cost = r.price_cents / m[1];
    if (!out.similar || cost < out.similar.cost) out.similar = { ...r, cost };
  }
  return out;
}

// How well a store's search result fits a product, so the closest comes first: the product's
// words in its name (the brand too: CSR Brown Sugar over White Sugar), the words of what it's
// matched to at other stores, a little less for each word it adds (Dark Brown Sugar), less for
// something else made from it (chicken seasoning isn't chicken), and less the further its size is
// from the product's (by ratio: 430 g is closer to 500 g than 1 kg is). The stores are still
// searched for the name alone.
const OTHER_THING = new Set(['seasoning', 'stock', 'marinade', 'flavoured', 'flavored', 'mix', 'sauce', 'gravy', 'powder', 'chip', 'crisp',
  'cracker', 'juice', 'cordial', 'syrup', 'essence', 'soup', 'noodle', 'dip', 'bite', 'nugget', 'snack', 'bar', 'biscuit', 'cake', 'baby', 'pouch', 'pet', 'dog', 'cat']);
const stemOf = (w) => (w.length > 3 ? w.replace(/(?:es|s)$/, '') : w);
const stemsOf = (s) => [...wordsOf(s)].map(stemOf);
function relevance(p, r, { refs = [], size = null } = {}) {
  const want = stemsOf(p.name);
  const got = new Set(stemsOf(r.name));
  let score = want.length ? (3 * want.filter((w) => got.has(w)).length) / want.length : 0;
  const ref = [...new Set(refs.flatMap((n) => stemsOf(bareName(n))))];
  if (ref.length) score += ref.filter((w) => got.has(w)).length / ref.length;
  if ([...got].some((w) => OTHER_THING.has(w) && !want.includes(w))) score -= 1.5;
  // Each word it has that the product (and its other matches) doesn't, like Dark in Dark Brown Sugar.
  const extra = [...got].filter((w) => !want.includes(w) && !ref.includes(w)).length;
  score -= Math.min(0.8, extra * 0.2);
  if (p.sold_by === 'weight') return score + (r.sold === 'each' || r.sold === 'kg' ? 1 : 0);
  const own = size || (p.size && MEASURE[p.unit] ? measureOf(`${p.size}${p.unit}`) : null);
  if (own) {
    const m = measureOf(r.size) || measureOf(r.name);
    if (!m) score -= 0.3;
    else if (m[0] !== own[0]) score -= 0.8;
    else score -= Math.min(1.5, Math.abs(Math.log(m[1] / own[1])));
  }
  return score;
}

// A store's product picture: only from the stores' own image servers, over https.
const IMAGE_HOSTS = /(^|\.)(woolworths\.media|woolworths\.com\.au|coles\.com\.au|aldi\.cx|aldi\.com\.au)$/i;
const imageUrl = (v) => {
  try {
    const u = new URL(String(v || ''));
    return u.protocol === 'https:' && IMAGE_HOSTS.test(u.hostname) ? u.href : null;
  } catch { return null; }
};
// A small picture the browser made from it when the match was picked: a JPEG, PNG or WebP as a
// data address, up to 60 KB.
const IMAGE_DATA = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const imageData = (v) => (typeof v === 'string' && v.length <= 80000 && IMAGE_DATA.test(v) ? v : null);

// Pricing by weight or volume needs a size it can be worked out from.
function pricePer(per, size, unit) {
  if (!(per in PRICE_PER)) throw new BadRequest(`The price should be per ${Object.keys(PRICE_PER).join(', ')}.`);
  if (PRICE_PER[per] && (!size || MEASURE[unit] !== PRICE_PER[per][0])) {
    throw new BadRequest(`To price per ${per}, give the size in ${PRICE_PER[per][0] === 'weight' ? 'g or kg' : 'mL or L'}.`);
  }
  return per;
}
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

// What a store's result costs, priced the way the product is. Loose fruit and veg (sold each, like
// a banana at Woolworths, or by the kilo, like one at Aldi) with a price per kg is priced by
// weight: per kg or 100 g (L or 100 mL) as the product is, or for its size when it's priced each
// with a weight, like 1 kg of bananas at $4.50/kg = $4.50. Something counted (2 onions) that a
// store only prices by the kilo is priced for what one weighs (about 200 g at $3.49/kg = $0.70).
// Anything else costs its own price.
const PER_KG_SHARE = { kg: 1, '100g': 0.1, L: 1, '100mL': 0.1 };
const GRAMS = { g: 1, kg: 1000, mL: 1, L: 1000 };
function priceFor(p, r) {
  const own = { cents: r.price_cents, was: r.was_cents || null };
  const perKg = Number.isInteger(r.per_kg_cents) && r.per_kg_cents > 0;
  const byKilo = r.sold === 'kg';
  const loose = perKg && (r.sold === 'each' || byKilo);
  if (!loose || !p) return own;
  const share = PER_KG_SHARE[p.price_per] ?? (p.size > 0 && GRAMS[p.unit] ? (p.size * GRAMS[p.unit]) / 1000
    : byKilo && p.each_g > 0 ? p.each_g / 1000 : null);
  if (!share) return own;
  const cents = Math.round(r.per_kg_cents * share);
  if (!(cents > 0 && cents <= 100000)) return own;
  return { cents, was: r.was_cents ? Math.round((r.was_cents * cents) / r.price_cents) : null };
}

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
    const matches = all('SELECT product_id, store_id, url, name, size, missing_at, length(image) AS image_v FROM shop_matches');
    const options = all('SELECT * FROM shop_options');
    const notSold = all('SELECT * FROM shop_not_sold');
    return all('SELECT * FROM shop_products ORDER BY name COLLATE NOCASE, size').map((p) => {
      const mine = prices.filter((x) => x.product_id === p.id);
      const opts = {};
      for (const o of options.filter((x) => x.product_id === p.id)) {
        (opts[o.store_id] ||= {})[o.kind] = { name: o.name, size: o.size, url: o.url, price_cents: o.price_cents, was_cents: o.was_cents, seen_at: o.seen_at };
      }
      const view = {
        ...p,
        setup: Boolean(p.setup),
        prices: Object.fromEntries(mine.map((x) => [x.store_id, x.price_cents])),
        checked: Object.fromEntries(mine.map((x) => [x.store_id, x.checked_at])),
        was: Object.fromEntries(mine.filter((x) => x.was_cents).map((x) => [x.store_id, x.was_cents])),
        matches: Object.fromEntries(matches.filter((x) => x.product_id === p.id)
          .map((x) => [x.store_id, { url: x.url, name: x.name, size: x.size, missing_at: x.missing_at, ...(x.image_v ? { image_v: x.image_v } : {}) }])),
        options: opts,
        not_sold: Object.fromEntries(notSold.filter((x) => x.product_id === p.id).map((x) => [x.store_id, x.at])),
        spots: Object.fromEntries(spots.filter((x) => x.product_id === p.id)
          .map((x) => [x.location_id, { aisle: x.aisle, section_id: x.section_id, missing: Boolean(x.missing) }])),
      };
      view.similar = cheaperSimilar(view);
      return view;
    });
  }

  // The close match that's cheapest for the amount, when it's at least 5% cheaper than the best
  // matched price (by its price per g, mL or each): only ever a hint.
  function cheaperSimilar(p) {
    const own = p.size && MEASURE[p.unit] ? measureOf(`${p.size}${p.unit}`) : null;
    let best = null;
    for (const [sid, m] of Object.entries(p.matches)) {
      const cents = p.prices[sid];
      const size = m.url && cents != null ? measureOf(m.size) || own : null;
      if (size && (!best || cents / size[1] < best[1])) best = [size[0], cents / size[1]];
    }
    if (!best) return null;
    let found = null;
    for (const [sid, o] of Object.entries(p.options)) {
      const s = o.similar;
      const size = s && measureOf(s.size || s.name);
      if (!size || size[0] !== best[0]) continue;
      const cost = s.price_cents / size[1];
      if (cost < best[1] * 0.95 && (!found || cost < found.cost)) found = { ...s, store_id: Number(sid), cost };
    }
    if (!found) return null;
    delete found.cost;
    return found;
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
      sold_by: SOLD_BY,
      // When the stores last changed their prices: a price checked since then is this week's.
      price_day: priceDay(),
      // Automatic prices, when there's a price-checker: what counts as up to date.
      checker: checker && checker.on ? { stores: CHECKER_STORES, since: priceDay() } : null,
      stores: all('SELECT * FROM shop_stores ORDER BY sort_order, id'),
      locations: all('SELECT * FROM shop_locations ORDER BY name COLLATE NOCASE'),
      sections: all('SELECT * FROM shop_sections ORDER BY location_id, position, name COLLATE NOCASE'),
      products: productsView(),
      items: all(`SELECT ${ITEM_COLS} FROM shop_items WHERE ${where} ORDER BY id`, ...args)
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

  // Picked to shop at: the store picker shows when each was last used.
  router.post('/locations/:id/use', (req, res) => {
    const { changes } = db.prepare("UPDATE shop_locations SET used_at = datetime('now') WHERE id = ?").run(Number(req.params.id));
    if (!changes) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
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
    // Typed in new: bought by the pack until it's set up.
    return Number(db.prepare('INSERT INTO shop_products (name, setup) VALUES (?, 1)').run(name).lastInsertRowid);
  };
  const productView = (id) => productsView().find((p) => p.id === id);
  // Not sold at a store: no price there, and remembered with when it was found.
  const markNotSold = (pid, sid) => {
    db.prepare('DELETE FROM shop_prices WHERE product_id = ? AND store_id = ?').run(pid, sid);
    db.prepare(`INSERT INTO shop_not_sold (product_id, store_id, at) VALUES (?, ?, datetime('now'))
      ON CONFLICT (product_id, store_id) DO UPDATE SET at = excluded.at`).run(pid, sid);
  };
  const sameProduct = (name, size, unit, id) => one(`SELECT id FROM shop_products WHERE name = ? AND coalesce(size, 0) = ? AND coalesce(unit, '') = ? AND id <> ?`,
    name, size ?? 0, unit ?? '', id);
  const sizeText = (size, unit) => (size ? ` (${size} ${unit})` : unit ? ` (${unit})` : '');

  // { name?, size?, unit?, price_per?, sold_by?, step_g?, each_g?, prices?: { [store id]: cents | null },
  // checked?: [store ids], converted?: [store ids], not_sold?: [store ids], unmatch?: [store ids] }. A changed price counts as checked today, and
  // so does one in checked: looked at and still right. A converted one is the same price said
  // another way (per kg instead of per pack), so it keeps when it was checked. not_sold marks it as
  // not sold at those stores (in place of a price), and a price there clears that. unmatch stops a
  // store's price being automatic, when it's typed over. Saying how it's sold sets the product up. Something bought by weight
  // is priced per kg (or 100 g), and its size is the usual amount.
  router.patch('/products/:id', (req, res) => {
    const id = Number(req.params.id);
    const before = one('SELECT * FROM shop_products WHERE id = ?', id);
    if (!before) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const name = 'name' in b ? text(b.name, 'The name') : before.name;
    const { size, unit } = 'size' in b || 'unit' in b ? sizeOf({ size: b.size, unit: b.unit }) : before;
    const per = pricePer('price_per' in b ? b.price_per : before.price_per, size, unit);
    const soldBy = 'sold_by' in b ? b.sold_by : before.sold_by;
    if (!SOLD_BY.includes(soldBy)) throw new BadRequest(`It should be sold by ${SOLD_BY.join(', ')}.`);
    if (soldBy === 'weight' && PRICE_PER[per]?.[0] !== 'weight') throw new BadRequest('Something bought by weight is priced per kg. Give its usual amount in g or kg.');
    const grams = (v, label) => (v === null || v === '' ? null : int(v, 1, 100000, label));
    const step = 'step_g' in b ? grams(b.step_g, 'The step') : before.step_g;
    const each = 'each_g' in b ? grams(b.each_g, 'What one weighs') : before.each_g;
    if (sameProduct(name, size, unit, id)) throw new BadRequest(`"${name}${sizeText(size, unit)}" is already in your product list.`);
    const prices = b.prices && typeof b.prices === 'object' ? Object.entries(b.prices) : [];
    const set = prices.map(([s, cents]) => {
      if (!exists('shop_stores', s)) throw new BadRequest('That store no longer exists.');
      return [Number(s), cents === null || cents === '' ? null : int(cents, 0, 100000, 'The price')];
    });
    const checked = new Set(Array.isArray(b.checked) ? b.checked.map(Number) : []);
    const converted = new Set(Array.isArray(b.converted) ? b.converted.map(Number) : []);
    const storeIds = (v) => (Array.isArray(v) ? v.map(Number).filter((s) => exists('shop_stores', s)) : []);
    const notSold = storeIds(b.not_sold);
    const unmatch = storeIds(b.unmatch);
    transaction(db, () => {
      db.prepare('UPDATE shop_products SET name = ?, size = ?, unit = ?, price_per = ?, sold_by = ?, step_g = ?, each_g = ?, setup = ? WHERE id = ?')
        .run(name, size, unit, per, soldBy, step, each, 'sold_by' in b ? 0 : before.setup, id);
      // What's on a list now goes by weight (its usual amount, as many times as it was on), or by count.
      if (soldBy !== before.sold_by && soldBy === 'weight') {
        const usual = Math.round(size * GRAMS[unit]);
        db.prepare('UPDATE shop_items SET grams = min(100000, qty * ?), qty = 1 WHERE product_id = ? AND grams IS NULL AND done_at IS NULL').run(usual, id);
      } else if (soldBy !== before.sold_by) {
        db.prepare('UPDATE shop_items SET grams = NULL WHERE product_id = ?').run(id);
      }
      for (const s of unmatch) db.prepare('DELETE FROM shop_matches WHERE product_id = ? AND store_id = ?').run(id, s);
      for (const [s, cents] of set) {
        db.prepare('DELETE FROM shop_not_sold WHERE product_id = ? AND store_id = ?').run(id, s);
        if (cents === null) { db.prepare('DELETE FROM shop_prices WHERE product_id = ? AND store_id = ?').run(id, s); continue; }
        if (converted.has(s) && cents > 0) {
          const old = one('SELECT price_cents FROM shop_prices WHERE product_id = ? AND store_id = ?', id, s);
          if (old) {
            db.prepare('UPDATE shop_prices SET price_cents = ?, was_cents = CASE WHEN was_cents THEN round(was_cents * ? / ?) END WHERE product_id = ? AND store_id = ?')
              .run(cents, cents, old.price_cents, id, s);
            continue;
          }
        }
        db.prepare(`INSERT INTO shop_prices (product_id, store_id, price_cents, checked_at) VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT (product_id, store_id) DO UPDATE SET price_cents = excluded.price_cents,
          was_cents = CASE WHEN price_cents <> excluded.price_cents THEN NULL ELSE was_cents END,
          checked_at = CASE WHEN price_cents <> excluded.price_cents OR ? THEN excluded.checked_at ELSE checked_at END`)
          .run(id, s, cents, checked.has(s) ? 1 : 0);
      }
      for (const s of checked) {
        if (!set.some(([x]) => x === s)) db.prepare("UPDATE shop_prices SET checked_at = datetime('now') WHERE product_id = ? AND store_id = ?").run(id, s);
      }
      for (const s of notSold) markNotSold(id, s);
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

  // The same place at every location: { aisle }, { section: name } (made at any location that
  // hasn't a category by that name, in the same place among the aisles), { missing: true }, or {}
  // for unsorted. It replaces wherever it was at each.
  router.put('/products/:id/spots', (req, res) => {
    const id = Number(req.params.id);
    if (!exists('shop_products', id)) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const aisle = b.aisle === null || b.aisle === undefined || b.aisle === '' ? null : int(b.aisle, 0, MAX_AISLE, 'The aisle');
    const section = b.section === undefined || b.section === null ? null : text(b.section, 'The category');
    const missing = b.missing === true;
    if ([aisle !== null, section !== null, missing].filter(Boolean).length > 1) throw new BadRequest('Pick one place for it.');
    transaction(db, () => {
      const like = section && one('SELECT name, position FROM shop_sections WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1', section);
      if (section && !like) throw new BadRequest("There's no category by that name.");
      for (const { id: loc } of all('SELECT id FROM shop_locations')) {
        let sectionId = null;
        if (section) {
          const at = one('SELECT id FROM shop_sections WHERE location_id = ? AND name = ? COLLATE NOCASE', loc, section);
          if (at) sectionId = at.id;
          else {
            if (count('shop_sections', 'WHERE location_id = ?', loc) >= LIMITS.sections) throw new BadRequest(`A location already has as many sections as it can keep (${LIMITS.sections}).`);
            sectionId = Number(db.prepare('INSERT INTO shop_sections (location_id, name, position) VALUES (?, ?, ?)').run(loc, like.name, like.position).lastInsertRowid);
          }
        }
        db.prepare('DELETE FROM shop_spots WHERE product_id = ? AND location_id = ?').run(id, loc);
        if (aisle !== null || sectionId || missing) {
          db.prepare('INSERT INTO shop_spots (product_id, location_id, aisle, section_id, missing) VALUES (?, ?, ?, ?, ?)').run(id, loc, aisle, sectionId, missing ? 1 : 0);
        }
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
    // Something bought by weight goes on in its usual amount (1 kg if it hasn't one).
    const usual = (p) => (p.sold_by !== 'weight' ? null : p.size && GRAMS[p.unit] && MEASURE[p.unit] === 'weight' ? Math.round(p.size * GRAMS[p.unit]) : 1000);
    const result = transaction(db, () => {
      let productId;
      if (b.product_id !== undefined) {
        productId = Number(b.product_id);
        if (!exists('shop_products', productId)) throw new BadRequest('That item no longer exists.');
      } else {
        productId = productNamed(text(b.name, 'The item'));
      }
      const existing = one(`SELECT * FROM shop_items WHERE product_id = ? AND ${where}`, productId, ...args);
      const g = usual(one('SELECT * FROM shop_products WHERE id = ?', productId));
      if (existing && existing.done_at) {
        db.prepare('UPDATE shop_items SET qty = ?, grams = ?, note = NULL, swap_store_id = NULL, swap_kind = NULL, done_at = NULL, done_by = NULL, done_store_id = NULL WHERE id = ?')
          .run(qty, g === null ? null : g * qty, existing.id);
        return { id: existing.id, added: false };
      }
      if (existing) {
        // Weighed: another usual amount; counted or packs: one more.
        if (g !== null && existing.grams !== null) db.prepare('UPDATE shop_items SET grams = min(100000, grams + ?) WHERE id = ?').run(g * qty, existing.id);
        else db.prepare('UPDATE shop_items SET qty = min(99, qty + ?) WHERE id = ?').run(qty, existing.id);
        return { id: existing.id, added: false };
      }
      if (count('shop_items', `WHERE ${where}`, ...args) >= LIMITS.items) throw new BadRequest(`That's more than one list can hold (${LIMITS.items}).`);
      const { lastInsertRowid } = db.prepare('INSERT INTO shop_items (product_id, owner_id, qty, grams) VALUES (?, ?, ?, ?)')
        .run(productId, who, qty, g === null ? null : g * qty);
      return { id: Number(lastInsertRowid), added: true };
    });
    res.status(result.added ? 201 : 200).json(one(`SELECT ${ITEM_COLS} FROM shop_items WHERE id = ?`, result.id));
  });

  // { qty }, { grams } (null to count them instead), { note }, { swap_store_id, swap_kind } (the store
  // whose other size, or close match, it's swapped to for this shop, or null) and/or { done: true | false, store_id }. Ticking off
  // notes who did it, and at which store.
  router.patch('/items/:id', (req, res) => {
    const item = itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const store = b.store_id && exists('shop_stores', b.store_id) ? Number(b.store_id) : null;
    const note = 'note' in b ? (typeof b.note === 'string' ? b.note.trim().replace(/\s+/g, ' ') : '') : null;
    if (note && note.length > 200) throw new BadRequest('The note is too long (200 characters at most).');
    if ('swap_store_id' in b && b.swap_store_id !== null && !exists('shop_stores', b.swap_store_id)) throw new BadRequest('That store no longer exists.');
    const swapKind = b.swap_kind === undefined ? 'size' : b.swap_kind;
    if ('swap_store_id' in b && b.swap_store_id !== null && !['size', 'similar'].includes(swapKind)) throw new BadRequest('Swap to the other size or the close match.');
    transaction(db, () => {
      if ('qty' in b) db.prepare('UPDATE shop_items SET qty = ? WHERE id = ?').run(int(b.qty, 1, 99, 'How many'), item.id);
      if ('grams' in b) db.prepare('UPDATE shop_items SET grams = ? WHERE id = ?').run(b.grams === null ? null : int(b.grams, 1, 100000, 'The weight'), item.id);
      if ('note' in b) db.prepare('UPDATE shop_items SET note = ? WHERE id = ?').run(note || null, item.id);
      if ('swap_store_id' in b) {
        db.prepare('UPDATE shop_items SET swap_store_id = ?, swap_kind = ? WHERE id = ?')
          .run(b.swap_store_id === null ? null : Number(b.swap_store_id), b.swap_store_id === null ? null : swapKind, item.id);
      }
      if (b.done === true && !item.done_at) {
        db.prepare("UPDATE shop_items SET done_at = datetime('now'), done_by = ?, done_store_id = ? WHERE id = ?").run(req.login.id, store, item.id);
      }
      if (b.done === false) db.prepare('UPDATE shop_items SET done_at = NULL, done_by = NULL, done_store_id = NULL WHERE id = ?').run(item.id);
    });
    res.json(one(`SELECT ${ITEM_COLS} FROM shop_items WHERE id = ?`, item.id));
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
  // Stores are searched for the name alone: "Bananas 1000g" finds packs instead of loose ones.
  // Results the same size as the product come first (see jobView).
  const queryOf = (p) => p.name;
  const startedJob = (id) => {
    const meta = started.get(String(id));
    if (!meta) throw new CheckerError('That check has finished.', 404);
    return meta;
  };
  // A search's results with what each would cost as the product is priced (cost_cents) and its
  // place in the checker's list (i, which a pick refers to): the same size as the product, or
  // loose when the product is priced by weight, first.
  function ranked(p, list) {
    if (!Array.isArray(list)) return [];
    const own = p && p.size && MEASURE[p.unit] ? measureOf(`${p.size}${p.unit}`) : null;
    const near = (r) => {
      if (p && PER_KG_SHARE[p.price_per] && (r.sold === 'each' || r.sold === 'kg')) return true;
      const m = own && measureOf(r.size);
      return Boolean(m && m[0] === own[0] && Math.abs(m[1] - own[1]) <= own[1] * 0.02);
    };
    // What it's matched to at other stores helps find it at the next.
    const others = p ? all("SELECT name, size FROM shop_matches WHERE product_id = ? AND url != ''", p.id) : [];
    const size = own || others.map((m) => measureOf(m.size)).find(Boolean) || null;
    const refs = others.map((m) => m.name);
    return list.map((r, i) => ({ ...r, i, cost_cents: priceFor(p, r).cents, near: near(r),
      score: p ? Math.round(relevance(p, r, { refs, size }) * 100) / 100 : 0 }))
      .sort((a, b) => b.score - a.score || Number(b.near) - Number(a.near) || a.i - b.i);
  }

  // The checker's job as the app sees it: stores by their ids here.
  const jobView = (job, meta) => {
    const byKey = Object.fromEntries(Object.entries(meta.stores).map(([sid, key]) => [key, Number(sid)]));
    const stores = {};
    for (const [key, st] of Object.entries(job.stores || {})) if (key in byKey) stores[byKey[key]] = st;
    const out = { id: job.id, type: meta.type, state: job.state, waiting_for: job.waiting_for || 0, stores };
    if (meta.type === 'find') {
      out.product_id = meta.product_id;
      out.q = job.q;
      out.results = {};
      const p = one('SELECT * FROM shop_products WHERE id = ?', meta.product_id);
      for (const [key, list] of Object.entries(job.results || {})) if (key in byKey) out.results[byKey[key]] = ranked(p, list);
    } else {
      out.total = Object.keys(meta.items).length;
      out.changes = meta.changes || null;
      out.missing = meta.missing || null;
      out.unmatched = meta.unmatched;
    }
    return out;
  };

  // A product's prices from a search at every store (or just the stores given, for a new match):
  // { product_id, store_ids?, q? }. It searches for the name unless q says otherwise.
  router.post('/checker/find', async (req, res) => {
    needChecker();
    const b = body(req);
    const p = one('SELECT * FROM shop_products WHERE id = ?', Number(b.product_id));
    if (!p) return res.status(404).json({ error: 'Not found.' });
    const stores = checkerStores(Array.isArray(b.store_ids) ? b.store_ids.map(Number) : null);
    if (!stores.length) throw new BadRequest('None of your stores have automatic prices.');
    const keys = {};
    for (const s of stores) if (!Object.values(keys).includes(s.checker)) keys[s.id] = s.checker;
    const q = typeof b.q === 'string' && b.q.trim() ? b.q.trim().slice(0, 120) : queryOf(p);
    const job = await checker.start({ type: 'search', q, stores: Object.values(keys) });
    const meta = { type: 'find', product_id: p.id, stores: keys, all: !b.store_ids };
    remember(job, meta);
    res.status(201).json(jobView(job, meta));
  });

  // The products on a list whose matched prices are out of date: { list }. Products on the list not
  // matched at a store come back as unmatched, to find. { all: true } checks every saved product's
  // matched prices now, however recently they were checked, and { product_ids } just those.
  // Each is searched for again at each store (one search a product a store), which brings back its
  // other size and close matches too.
  router.post('/checker/update', async (req, res) => {
    needChecker();
    const b = body(req);
    const some = Array.isArray(b.product_ids) ? b.product_ids.map(Number).filter((n) => Number.isInteger(n)).slice(0, LIMITS.products) : null;
    const every = b.all === true || Boolean(some);
    const since = every ? null : priceDay();
    const stores = checkerStores();
    let products;
    if (some) products = some.filter((id) => exists('shop_products', id));
    else if (every) products = all('SELECT id FROM shop_products ORDER BY name').map((r) => r.id);
    else {
      const [where, args] = onList(ownerOf(req, listOf(req)));
      products = all(`SELECT DISTINCT product_id AS id FROM shop_items WHERE done_at IS NULL AND ${where}`, ...args).map((r) => r.id);
    }
    const keys = {};
    const items = {};
    const toCheck = [];
    const unmatched = [];
    for (const pid of products) {
      const p = one('SELECT name FROM shop_products WHERE id = ?', pid);
      for (const s of stores) {
        const m = one('SELECT * FROM shop_matches WHERE product_id = ? AND store_id = ?', pid, s.id);
        if (!m) { if (!every) unmatched.push({ product_id: pid, store_id: s.id }); continue; }
        if (!m.url) continue; // not sold there, or not wanted
        const price = one('SELECT checked_at FROM shop_prices WHERE product_id = ? AND store_id = ?', pid, s.id);
        if (since && price && price.checked_at && price.checked_at >= since) continue;
        const key = `${pid}:${s.id}`;
        keys[s.id] = s.checker;
        items[key] = [pid, s.id];
        toCheck.push({ key, store: s.checker, url: m.url, name: m.name, size: m.size, q: p.name, search: true });
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
        const p = one('SELECT * FROM shop_products WHERE id = ?', pid);
        if (Array.isArray(r.others)) {
          const m = one('SELECT * FROM shop_matches WHERE product_id = ? AND store_id = ?', pid, sid);
          saveOptions(p, sid, optionsAt(p, r.others, r.found ? { url: m && m.url, name: r.name, size: r.size } : m));
        }
        if (!r.found) {
          if (!r.error) {
            db.prepare("UPDATE shop_matches SET missing_at = datetime('now') WHERE product_id = ? AND store_id = ?").run(pid, sid);
            missing.push({ product_id: pid, store_id: sid });
          }
          continue;
        }
        if (!(Number.isInteger(r.price_cents) && r.price_cents > 0 && r.price_cents <= 100000)) continue;
        const { cents, was } = priceFor(p, r);
        fillWeight(p, r);
        const before = one('SELECT price_cents FROM shop_prices WHERE product_id = ? AND store_id = ?', pid, sid);
        savePrice(pid, sid, cents, was);
        db.prepare('UPDATE shop_matches SET missing_at = NULL WHERE product_id = ? AND store_id = ?').run(pid, sid);
        if (!before || before.price_cents !== cents) changes.push({ product_id: pid, store_id: sid, old_cents: before ? before.price_cents : null, new_cents: cents, special: Boolean(r.special) });
      }
    });
    meta.changes = changes;
    meta.missing = missing;
    rev += 1;
  }

  // A store's other size and close match for a product, from its latest search.
  const saveOptions = (p, sid, found) => {
    db.prepare('DELETE FROM shop_options WHERE product_id = ? AND store_id = ?').run(p.id, sid);
    for (const kind of ['size', 'similar']) {
      const r = found[kind];
      if (!r) continue;
      const was = Number.isInteger(r.was_cents) && r.was_cents > r.price_cents && r.was_cents <= 100000 ? r.was_cents : null;
      db.prepare(`INSERT INTO shop_options (product_id, store_id, kind, name, size, url, price_cents, was_cents, seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
        .run(p.id, sid, kind, String(r.name).slice(0, 200), r.size ? String(r.size).slice(0, 40) : null, String(r.url).slice(0, 500), r.price_cents, was);
    }
  };
  // What one weighs, for counting things bought by weight, from the store when it says (Woolworths
  // does for loose fruit and veg) and nobody has said yet.
  const fillWeight = (p, r) => {
    const g = Number(r.each_grams);
    if (!p.each_g && Number.isInteger(g) && g > 0 && g <= 100000) {
      db.prepare('UPDATE shop_products SET each_g = ? WHERE id = ? AND each_g IS NULL').run(g, p.id);
      p.each_g = g;
    }
  };

  const savePrice = (pid, sid, cents, was) => {
    const normal = Number.isInteger(was) && was > cents && was <= 100000 ? was : null;
    db.prepare(`INSERT INTO shop_prices (product_id, store_id, price_cents, was_cents, checked_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (product_id, store_id) DO UPDATE SET price_cents = excluded.price_cents, was_cents = excluded.was_cents, checked_at = excluded.checked_at`)
      .run(pid, sid, cents, normal);
    db.prepare('DELETE FROM shop_not_sold WHERE product_id = ? AND store_id = ?').run(pid, sid);
  };

  router.get('/checker/jobs/:id', async (req, res) => {
    const meta = startedJob(req.params.id);
    const job = await checker.get(req.params.id);
    if (meta.type === 'find') { meta.results = job.results; meta.final = job.state === 'done' || job.state === 'cancelled'; }
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
  // or null for none of them } }. Their prices are saved, and each store searched keeps the other
  // size and closest cheaper match among its results (see optionsAt).
  router.put('/products/:id/matches', async (req, res) => {
    const id = Number(req.params.id);
    const p = one('SELECT * FROM shop_products WHERE id = ?', id);
    if (!p) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const meta = startedJob(b.job);
    if (meta.type !== 'find' || meta.product_id !== id) throw new BadRequest("That search wasn't for this product.");
    if (!meta.final) meta.results = (await checker.get(b.job)).results;
    const results = meta.results || {};
    const picks = b.picks && typeof b.picks === 'object' ? Object.entries(b.picks) : [];
    const images = b.images && typeof b.images === 'object' ? b.images : {};
    transaction(db, () => {
      for (const [sid, index] of picks) {
        const key = meta.stores[Number(sid)];
        if (!key) throw new BadRequest('That store was not part of the search.');
        // None of them: remembered (an empty address), so it isn't asked about again until found anew.
        if (index === null) {
          db.prepare(`INSERT INTO shop_matches (product_id, store_id, url, name, size, missing_at) VALUES (?, ?, '', '', NULL, NULL)
            ON CONFLICT (product_id, store_id) DO UPDATE SET url = '', name = '', size = NULL, missing_at = NULL, image = NULL`).run(id, Number(sid));
          markNotSold(id, Number(sid));
          continue;
        }
        const r = (results[key] || [])[int(index, 0, 1000, 'The pick')];
        if (!r) throw new BadRequest('That result is not there.');
        // Its picture, as the browser made it small; kept when the same listing is picked again.
        const was = one('SELECT url, image FROM shop_matches WHERE product_id = ? AND store_id = ?', id, Number(sid));
        const image = imageData(images[sid]) || (was && was.url === r.url ? was.image : null);
        db.prepare(`INSERT INTO shop_matches (product_id, store_id, url, name, size, missing_at, image) VALUES (?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT (product_id, store_id) DO UPDATE SET url = excluded.url, name = excluded.name, size = excluded.size, missing_at = NULL, image = excluded.image`)
          .run(id, Number(sid), String(r.url).slice(0, 500), String(r.name).slice(0, 200), r.size ? String(r.size).slice(0, 40) : null, image);
        const price = priceFor(p, r);
        savePrice(id, Number(sid), price.cents, price.was);
        fillWeight(p, r);
      }
      for (const [sid, key] of Object.entries(meta.stores)) {
        if (!Array.isArray(results[key])) continue;
        saveOptions(p, Number(sid), optionsAt(p, results[key], one('SELECT * FROM shop_matches WHERE product_id = ? AND store_id = ?', id, Number(sid))));
      }
    });
    res.json(productView(id));
  });

  // A store's product picture for Find prices, fetched by the price-checker (the app itself has no
  // way out to the internet) and kept for a while, since the same ones are looked at again.
  const pictures = new Map();
  router.get('/picture', async (req, res) => {
    const url = imageUrl(req.query.u);
    if (!url) return res.status(400).json({ error: "That's not a store's picture." });
    needChecker();
    let pic = pictures.get(url);
    if (!pic) {
      pic = await checker.image(url);
      pictures.set(url, pic);
      if (pictures.size > 300) pictures.delete(pictures.keys().next().value);
    }
    res.set({ 'Content-Type': pic.type, 'Cache-Control': 'private, max-age=86400' }).send(pic.body);
  });

  // A product's picture at a store, kept with its match.
  router.get('/products/:id/picture/:store', (req, res) => {
    const m = one('SELECT image FROM shop_matches WHERE product_id = ? AND store_id = ?', Number(req.params.id), Number(req.params.store));
    const data = m && imageData(m.image);
    if (!data) return res.status(404).json({ error: 'No picture.' });
    const [, type, b64] = /^data:([^;]+);base64,(.*)$/.exec(data);
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=604800' }).send(Buffer.from(b64, 'base64'));
  });

  // The key the browser helper (the Coles button) uses, made the first time it's asked for.
  // { new: true } makes a new one, and the old one stops working.
  router.post('/helper/key', (req, res) => {
    let key = getSetting(db, 'shop_helper_key');
    if (!key || body(req).new === true) {
      key = require('node:crypto').randomBytes(18).toString('base64url');
      setSetting(db, 'shop_helper_key', key);
    }
    res.json({ key });
  });

  // The browser helper itself, to unzip and load into Brave or Chrome (see the README).
  router.get('/helper/extension.zip', (req, res) => {
    const { zipFolder } = require('./zip');
    const dir = require('node:path').join(__dirname, '..', 'browser-extension');
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="simple-budget-coles-button.zip"' })
      .send(zipFolder(dir, 'simple-budget-coles-button'));
  });

  router.use((err, req, res, next) => {
    if (err instanceof CheckerError) return res.status(err.status).json({ error: err.message });
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err && /UNIQUE/.test(err.message)) return res.status(400).json({ error: 'That name is already used.' });
    next(err);
  });

  return router;
}

// ---------- The browser helper (the Coles button) ----------
//
// A Simple Budget extension in the household's own browser gets prices from a store's website
// while they browse it (Coles turns the price-checker away). It's not logged in like a person:
// it uses a key (Shopping → Coles button) and only reaches these two routes.
//
//   GET  /api/shop-helper/:store          the list's products to check there (store: coles ...)
//   POST /api/shop-helper/:store/results  { found: [{ product_id, url, name, size, price_cents, was_cents }],
//                                           none: [product ids], missing: [product ids] }

function createHelper(db) {
  const router = express.Router();
  const crypto = require('node:crypto');
  const hash = (v) => crypto.createHash('sha256').update(String(v)).digest();
  router.use((req, res, next) => {
    const key = getSetting(db, 'shop_helper_key');
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!key || !m || !crypto.timingSafeEqual(hash(m[1]), hash(key))) return res.status(401).json({ error: 'Wrong key. Copy it again from Shopping → Coles button.' });
    next();
  });
  const storeOf = (key) => db.prepare('SELECT * FROM shop_stores WHERE checker = ? ORDER BY sort_order, id').get(String(key));

  router.get('/:store', (req, res) => {
    const s = storeOf(req.params.store);
    if (!s) return res.status(404).json({ error: `No store gets its prices from ${req.params.store}.` });
    const since = priceDay();
    const items = db.prepare(`SELECT p.id, p.name, p.size, p.unit, sum(i.qty) AS qty FROM shop_items i JOIN shop_products p ON p.id = i.product_id
      WHERE i.done_at IS NULL GROUP BY p.id ORDER BY p.name COLLATE NOCASE`).all().map((p) => {
      const m = db.prepare('SELECT * FROM shop_matches WHERE product_id = ? AND store_id = ?').get(p.id, s.id);
      const price = db.prepare('SELECT * FROM shop_prices WHERE product_id = ? AND store_id = ?').get(p.id, s.id);
      const size = p.size ? `${p.size}${p.unit && MEASURE[p.unit] ? p.unit : ` ${p.unit || ''}`}`.trim() : '';
      return {
        product_id: p.id, name: p.name, size: size || null, q: p.name, // the name alone, as for the price-checker
        match: m && m.url ? { url: m.url, name: m.name, size: m.size, missing: Boolean(m.missing_at) } : null,
        none: Boolean(m && !m.url),
        price_cents: price ? price.price_cents : null,
        checked_at: price ? price.checked_at : null,
        out_of_date: Boolean(m && m.url && (!price || !price.checked_at || price.checked_at < since)),
      };
    });
    res.json({ store: { id: s.id, name: s.name }, since, items });
  });

  router.post('/:store/results', (req, res) => {
    const s = storeOf(req.params.store);
    if (!s) return res.status(404).json({ error: 'Not found.' });
    const b = body(req);
    const ids = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n)) : []);
    const product = (id) => db.prepare('SELECT * FROM shop_products WHERE id = ?').get(id);
    const changes = [];
    transaction(db, () => {
      for (const r of (Array.isArray(b.found) ? b.found : []).slice(0, 500)) {
        const id = Number(r && r.product_id);
        if (!product(id) || typeof r.url !== 'string' || !/^https:\/\//.test(r.url) || typeof r.name !== 'string') continue;
        if (!(Number.isInteger(r.price_cents) && r.price_cents > 0 && r.price_cents <= 100000)) continue;
        const given = { price_cents: r.price_cents, was_cents: Number.isInteger(r.was_cents) && r.was_cents > r.price_cents && r.was_cents <= 100000 ? r.was_cents : null,
          sold: r.sold === 'each' || r.sold === 'kg' ? r.sold : 'pack', per_kg_cents: Number.isInteger(r.per_kg_cents) && r.per_kg_cents > 0 && r.per_kg_cents <= 1000000 ? r.per_kg_cents : null };
        const { cents, was } = priceFor(product(id), given);
        const before = db.prepare('SELECT price_cents FROM shop_prices WHERE product_id = ? AND store_id = ?').get(id, s.id);
        db.prepare(`INSERT INTO shop_matches (product_id, store_id, url, name, size, missing_at) VALUES (?, ?, ?, ?, ?, NULL)
          ON CONFLICT (product_id, store_id) DO UPDATE SET url = excluded.url, name = excluded.name, size = excluded.size, missing_at = NULL`)
          .run(id, s.id, r.url.slice(0, 500), r.name.trim().slice(0, 200), typeof r.size === 'string' ? r.size.slice(0, 40) : null);
        db.prepare(`INSERT INTO shop_prices (product_id, store_id, price_cents, was_cents, checked_at) VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT (product_id, store_id) DO UPDATE SET price_cents = excluded.price_cents, was_cents = excluded.was_cents, checked_at = excluded.checked_at`)
          .run(id, s.id, cents, was);
        db.prepare('DELETE FROM shop_not_sold WHERE product_id = ? AND store_id = ?').run(id, s.id);
        if (!before || before.price_cents !== cents) changes.push({ product_id: id, old_cents: before ? before.price_cents : null, new_cents: cents });
      }
      for (const id of ids(b.none)) {
        if (!product(id)) continue;
        db.prepare(`INSERT INTO shop_matches (product_id, store_id, url, name, size, missing_at) VALUES (?, ?, '', '', NULL, NULL)
          ON CONFLICT (product_id, store_id) DO UPDATE SET url = '', name = '', size = NULL, missing_at = NULL`).run(id, s.id);
        // Not sold at this store, in place of its price.
        db.prepare('DELETE FROM shop_prices WHERE product_id = ? AND store_id = ?').run(id, s.id);
        db.prepare(`INSERT INTO shop_not_sold (product_id, store_id, at) VALUES (?, ?, datetime('now'))
          ON CONFLICT (product_id, store_id) DO UPDATE SET at = excluded.at`).run(id, s.id);
      }
      for (const id of ids(b.missing)) {
        db.prepare("UPDATE shop_matches SET missing_at = datetime('now') WHERE product_id = ? AND store_id = ? AND url <> ''").run(id, s.id);
      }
    });
    res.json({ ok: true, changes });
  });
  return router;
}

// ---------- Backup and restore ----------

const SHOP_TABLES = {
  stores: ['shop_stores', ['id', 'name', 'sort_order', 'color', 'search_url', 'checker']],
  locations: ['shop_locations', ['id', 'store_id', 'name', 'used_at']],
  sections: ['shop_sections', ['id', 'location_id', 'name', 'position']],
  products: ['shop_products', ['id', 'name', 'size', 'unit', 'price_per', 'sold_by', 'step_g', 'each_g', 'setup']],
  prices: ['shop_prices', ['product_id', 'store_id', 'price_cents', 'checked_at', 'was_cents']],
  // Each product's own listing at a store, for automatic prices, and its other size and close match there.
  matches: ['shop_matches', ['product_id', 'store_id', 'url', 'name', 'size', 'missing_at', 'image']],
  options: ['shop_options', ['product_id', 'store_id', 'kind', 'name', 'size', 'url', 'price_cents', 'was_cents', 'seen_at']],
  spots: ['shop_spots', ['product_id', 'location_id', 'aisle', 'section_id', 'missing']],
  not_sold: ['shop_not_sold', ['product_id', 'store_id', 'at']],
  items: ['shop_items', ['id', 'product_id', 'owner_id', 'qty', 'grams', 'note', 'swap_store_id', 'swap_kind', 'added_at', 'done_at', 'done_by', 'done_store_id']],
};

function exportShop(db) {
  return Object.fromEntries(Object.entries(SHOP_TABLES).map(([key, [table, cols]]) => [key,
    db.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all().map((r) => ({ ...r }))]));
}

// Replaces the shopping list with the backup's. Rows keep their ids, since nothing outside the
// shopping list refers to them. Returns how many products were restored, and how many rows were left out.
function importShop(db, data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.stores)) return null;
  // Backups from before 0.9.10 kept one cheaper similar product each.
  if (!data.options && Array.isArray(data.similar)) data = { ...data, options: data.similar.map((x) => ({ ...x, kind: 'similar' })) };
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

module.exports = { createShop, createHelper, exportShop, importShop, priceDay, priceFor, relevance, imageUrl, UNITS };
