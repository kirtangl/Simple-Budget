'use strict';

// Aldi: its website gets search results from asl.api.aldi.com.au, which needs no cookies, so
// Aldi is asked directly, without a browser tab. Prices are in cents and the same at every store.
// Aldi sells mostly its own brands, so a match here is a "similar" more often than the same thing.

const { result } = require('./common');
const { Challenge } = require('../lib/jobs');

const HOME = 'https://www.aldi.com.au/';
const API = 'https://asl.api.aldi.com.au/commerce';
const urlOf = (p) => `${HOME}product/${p.urlSlugText || 'item'}-${p.sku}`;
// Its picture's address has the width and name to fill in: a small one, 120 pixels wide.
const imageOf = (p) => {
  const a = Array.isArray(p.assets) ? p.assets.find((x) => x && typeof x.url === 'string') : null;
  return a ? a.url.replace(/\{width\}/g, '120').replace(/\{slug\}/g, encodeURIComponent(p.urlSlugText || 'item')) : null;
};

const toResult = (p) => p && p.price && result({
  name: [p.brandName, p.name].filter(Boolean).join(' '),
  size: p.sellingSize,
  price: typeof p.price.amount === 'number' ? p.price.amount / 100 : p.price.amountRelevantDisplay,
  was: p.price.wasPriceDisplay,
  unit: p.price.comparisonDisplay,
  url: urlOf(p),
  // Loose fruit and veg are priced by the kilo (its size says "per kg" when its unit doesn't).
  sold: String(p.quantityUnit || '').toLowerCase() === 'kg' || /^\s*(per\s*)?kg\s*$/i.test(p.sellingSize || '') ? 'kg' : 'pack',
  image: imageOf(p),
});

function create(fetchImpl = globalThis.fetch) {
  async function get(url) {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'accept-language': 'en-AU,en;q=0.9' }, signal: AbortSignal.timeout(20e3) });
    if (res.status === 403 || res.status === 429) throw new Challenge();
    if (!res.ok) throw new Error(`Aldi's website answered ${res.status}.`);
    return res.json();
  }
  return {
    id: 'aldi',
    name: 'Aldi',
    home: HOME,
    gap: [800, 1600],
    noBrowser: true,
    challenged: async () => false,
    async search(page, q) {
      const data = await get(`${API}/v3/product-search?currency=AUD&serviceType=walk-in&q=${encodeURIComponent(q)}&limit=30&offset=0&sort=relevance&servicePoint=G452`);
      return (Array.isArray(data && data.data) ? data.data : []).map(toResult).filter(Boolean);
    },
    async lookup(page, item) {
      const sku = /-(\w+)\/?$/.exec(String(item.url || '').split(/[?#]/)[0]);
      if (!sku) return null;
      const data = await get(`${API}/v2/products?skus=${encodeURIComponent(sku[1])}&servicePoint=G452&serviceType=walk-in`);
      const list = Array.isArray(data && data.data) ? data.data : Array.isArray(data) ? data : [];
      return toResult(list.find((p) => String(p.sku) === sku[1]) || null);
    },
  };
}

module.exports = { ...create(), create, toResult };
