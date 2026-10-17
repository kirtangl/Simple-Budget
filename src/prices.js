'use strict';

// Automatic prices. The supermarkets have no public price feed, so this uses a price lookup
// service: an Apify "actor" that searches Woolworths, Coles, Aldi and IGA online and returns what
// they sell, with prices and product links. The household brings its own Apify key (Settings are
// kept in the database and never sent back out). Apify charges per result, from its free monthly
// credit, so searches are kept small: a handful of results when finding a product, and when
// refreshing, one search per matched product at its own store only.

const { getSetting, setSetting } = require('./db');

const ACTOR = 'toptock~au-grocery-prices';
const API = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;
// The chains the service knows, by the store's name in the app.
const CHAINS = { woolworths: 'woolworths', woolies: 'woolworths', coles: 'coles', aldi: 'aldi', iga: 'iga' };
const FIND_RESULTS = 6; // per store
const REFRESH_RESULTS = 5; // per search
const BATCH = 25; // searches per call, so each call finishes well inside Apify's 5 minutes
const WEEK = 7 * 24 * 60 * 60 * 1000;

class LookupError extends Error {}

const chainOf = (store) => CHAINS[String(store.name || '').trim().toLowerCase()] || null;
// A product link without anything after ? or #, so the same product matches however it was linked.
const sameUrl = (a, b) => {
  const clean = (u) => String(u || '').split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
  return Boolean(a && b) && clean(a) === clean(b);
};
const cents = (dollars) => (typeof dollars === 'number' && Number.isFinite(dollars) && dollars >= 0 ? Math.round(dollars * 100) : null);
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// One result from the service, kept to what the app shows and saves. Anything without a name,
// a price or an https link is left out.
function resultOf(row) {
  if (!row || typeof row !== 'object') return null;
  const price = cents(row.price);
  const url = str(row.url, 500);
  if (!str(row.name) || price === null || !/^https:\/\//i.test(url)) return null;
  return {
    chain: str(row.chain, 20).toLowerCase(),
    name: str(row.name),
    size: str(row.size, 40) || null,
    price_cents: price,
    was_cents: cents(row.wasPrice),
    special: row.isOnSpecial === true,
    unit_price: str(row.unitPriceText, 60) || null,
    url,
  };
}

function createPriceLookup({ db, fetchImpl = globalThis.fetch }) {
  const key = () => getSetting(db, 'shop_lookup_key') || '';
  let running = null;

  async function search(keywords, chains, perKeyword) {
    const token = key();
    if (!token) throw new LookupError('Add your Apify key first, under Automatic prices in Check prices.');
    let res;
    try {
      res = await fetchImpl(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ keywords, chains, maxResultsPerKeyword: perKeyword, output: 'products' }),
        signal: AbortSignal.timeout(290_000),
      });
    } catch {
      throw new LookupError("Couldn't reach the price lookup service. Check the server's internet connection and try again.");
    }
    if (res.status === 401 || res.status === 403) throw new LookupError('Apify turned down the key. Check it was copied in full, or make a new one.');
    if (res.status === 402) throw new LookupError("Apify says this month's credit is used up. It refills at the start of next month.");
    if (!res.ok) throw new LookupError(`The price lookup service had a problem (error ${res.status}). Try again later.`);
    let rows;
    try { rows = await res.json(); } catch { rows = null; }
    if (!Array.isArray(rows)) throw new LookupError('The price lookup service sent back something unexpected. Try again later.');
    return rows.map(resultOf).filter(Boolean);
  }

  // What each store sells under a name: { [store id]: [results] }, for the stores the service knows.
  async function find(q) {
    const stores = db.prepare('SELECT * FROM shop_stores').all().filter(chainOf);
    if (!stores.length) throw new LookupError('Automatic prices work for Woolworths, Coles, Aldi and IGA. Add one of them as a store first.');
    const rows = await search([q], [...new Set(stores.map(chainOf))], FIND_RESULTS);
    return Object.fromEntries(stores.map((s) => [s.id, rows.filter((r) => r.chain === chainOf(s))]));
  }

  // Looks up every matched product at its store and saves the prices found. A product the
  // service can't find this time keeps its price (and its old date, so it shows as needing a check).
  async function refreshNow() {
    const stores = new Map(db.prepare('SELECT * FROM shop_stores').all().map((s) => [s.id, s]));
    const matches = db.prepare('SELECT * FROM shop_matches').all().filter((m) => stores.has(m.store_id) && chainOf(stores.get(m.store_id)));
    const out = { at: new Date().toISOString(), checked: matches.length, updated: 0, changed: 0, missing: 0, error: null };
    try {
      const byChain = new Map();
      for (const m of matches) {
        const chain = chainOf(stores.get(m.store_id));
        if (!byChain.has(chain)) byChain.set(chain, []);
        byChain.get(chain).push(m);
      }
      const save = db.prepare(`INSERT INTO shop_prices (product_id, store_id, price_cents, checked_at) VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT (product_id, store_id) DO UPDATE SET price_cents = excluded.price_cents, checked_at = excluded.checked_at`);
      const before = db.prepare('SELECT price_cents FROM shop_prices WHERE product_id = ? AND store_id = ?');
      for (const [chain, list] of byChain) {
        const names = [...new Set(list.map((m) => m.name))];
        const rows = [];
        for (let i = 0; i < names.length; i += BATCH) rows.push(...await search(names.slice(i, i + BATCH), [chain], REFRESH_RESULTS));
        for (const m of list) {
          const found = rows.find((r) => r.chain === chain && sameUrl(r.url, m.url))
            || rows.find((r) => r.chain === chain && r.name.toLowerCase() === m.name.toLowerCase() && (r.size || '') === (m.size || ''));
          if (!found) { out.missing += 1; continue; }
          const was = before.get(m.product_id, m.store_id);
          save.run(m.product_id, m.store_id, found.price_cents);
          out.updated += 1;
          if (!was || was.price_cents !== found.price_cents) out.changed += 1;
        }
      }
    } catch (err) {
      out.error = err instanceof LookupError ? err.message : 'Something went wrong refreshing prices.';
      if (!(err instanceof LookupError)) console.error(err);
    }
    setSetting(db, 'shop_lookup_last', JSON.stringify(out));
    return out;
  }
  // One refresh at a time: asking again while one runs waits for that one.
  const refresh = () => {
    if (!running) running = refreshNow().finally(() => { running = null; });
    return running;
  };

  function status() {
    let last;
    try { last = JSON.parse(getSetting(db, 'shop_lookup_last') || 'null'); } catch { last = null; }
    return {
      key_set: Boolean(key()),
      weekly: getSetting(db, 'shop_lookup_weekly') !== '0',
      matched: db.prepare('SELECT count(*) AS n FROM shop_matches').get().n,
      running: Boolean(running),
      last,
    };
  }

  return {
    find,
    refresh,
    status,
    setKey(v) { setSetting(db, 'shop_lookup_key', v); },
    setWeekly(on) { setSetting(db, 'shop_lookup_weekly', on ? '1' : '0'); },
    chainOf,
    // Once a week, if there's a key and something to look up. Checked every hour, so a server
    // that was off on the day catches up when it's back.
    start() {
      const auto = () => {
        const s = status();
        if (!s.key_set || !s.weekly || !s.matched || s.running) return;
        if (s.last && Date.now() - Date.parse(s.last.at) < WEEK - 60_000) return;
        refresh();
      };
      setTimeout(auto, 60_000).unref();
      setInterval(auto, 60 * 60 * 1000).unref();
    },
  };
}

module.exports = { createPriceLookup, LookupError, resultOf, sameUrl };
