'use strict';
/* global module */

// Unit prices the way Australian shelf labels show them: weights per kg, volumes per L, and
// packs of several per each. One pure helper for the list's own price, a swap and a cheaper
// store, so they're always compared the same way. Loaded by the page (window.UnitPrice) and by
// the tests (require).
(function (root) {
  const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const UNITS = { g: ['weight', 1], kg: ['weight', 1000], ml: ['volume', 1], l: ['volume', 1000], pk: ['count', 1], pack: ['count', 1], each: ['count', 1], ea: ['count', 1] };

  // A size as a store or the list writes it ("375g", "1.5 kg", "150mL", "6 pack", "each"), or a
  // number and a unit: { kind: 'weight' | 'volume' | 'count', amount } in g, mL or how many.
  // Null when it can't be read.
  function parse(size, unit) {
    if (typeof size === 'number' && unit) return parse(`${size} ${unit}`);
    if ((size === null || size === undefined || size === '') && unit) return parse(unit);
    const text = String(size ?? '').toLowerCase();
    if (/^\s*each\s*$/.test(text)) return { kind: 'count', amount: 1 };
    const m = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|pk|pack|each|ea)\b/.exec(text);
    if (!m) return null;
    const [kind, base] = UNITS[m[2]];
    const amount = Number(m[1]) * base;
    return amount > 0 ? { kind, amount } : null;
  }

  // What a price comes to per kg, per L or per each: { cents, per: 'kg' | 'L' | 'each' }. Null
  // when the size can't be read, and for one of something, where it would just be the price.
  function of(cents, size, unit) {
    if (!Number.isFinite(cents) || cents <= 0) return null;
    const m = size && typeof size === 'object' ? size : parse(size, unit);
    if (!m) return null;
    if (m.kind === 'count') return m.amount > 1 ? { cents: Math.round(cents / m.amount), per: 'each' } : null;
    return { cents: Math.round((cents * 1000) / m.amount), per: m.kind === 'weight' ? 'kg' : 'L' };
  }

  // A price per kg straight from what something costs by the kilo.
  const perKg = (cents) => (Number.isFinite(cents) && cents > 0 ? { cents: Math.round(cents), per: 'kg' } : null);

  // "$13.33/kg", "$1.65/L", "$0.50 each"; nothing for none.
  const text = (u) => (u ? `${money.format(u.cents / 100)}${u.per === 'each' ? ' each' : `/${u.per}`}` : '');

  const api = { parse, of, perKg, text };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UnitPrice = api;
})(typeof window === 'object' ? window : globalThis);
