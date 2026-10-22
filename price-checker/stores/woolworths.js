'use strict';

// Woolworths: its search page asks /apis/ui/Search/products for results, and a product's own page
// asks /apis/ui/product/detail/{stockcode}. These only answer from inside an open Woolworths tab
// (with the cookies its bot protection gives a browser). Prices are in dollars; WasPrice is the
// normal price (the same as Price when it isn't on special). A visitor who isn't logged in gets the
// prices of Woolworths' default store.

const { challenged, pageFetch, result, Challenge } = require('./common');

const HOME = 'https://www.woolworths.com.au/';
const urlOf = (p) => `https://www.woolworths.com.au/shop/productdetails/${p.Stockcode}/${p.UrlFriendlyName || ''}`.replace(/\/$/, '');

// Loose fruit and veg are sold "each", with a unit price per each; how much one weighs
// (UnitWeightInGrams) is only in the product's detail.
const isEach = (p) => /^\s*each\s*$/i.test(p.PackageSize || '') || /\/\s*1\s*EA\b/i.test(p.CupString || '');
const toResult = (p) => p && result({
  name: p.DisplayName || p.Name,
  size: p.PackageSize,
  price: p.Price ?? p.InstorePrice,
  was: p.WasPrice ?? p.InstoreWasPrice,
  special: p.IsOnSpecial || p.IsInstoreOnSpecial,
  unit: p.CupString,
  url: urlOf(p),
  available: p.IsAvailable ?? p.IsInStock,
  sold: isEach(p) ? 'each' : 'pack',
  grams: Number(p.UnitWeightInGrams) || null,
  image: p.SmallImageFile || p.MediumImageFile,
});
// How many loose results a search looks up the weight of (one request each, so only the first few).
const WEIGH = 4;

module.exports = {
  toResult,
  id: 'woolworths',
  name: 'Woolworths',
  home: HOME,
  gap: [1500, 3000],
  show: (page, q) => page.goto(`${HOME}shop/search/products?searchTerm=${encodeURIComponent(q || '')}`, { waitUntil: 'domcontentloaded' }),
  challenged,
  async search(page, q) {
    const data = await pageFetch(page, `${HOME}apis/ui/Search/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        Filters: [], IsSpecial: false, Location: `/shop/search/products?searchTerm=${encodeURIComponent(q)}`,
        PageNumber: 1, PageSize: 36, SearchTerm: q, SortType: 'TraderRelevance', ExcludeSearchTypes: ['UntraceableVendors'],
        IsHideUnavailableProducts: false, IsHideEverydayMarketProducts: false, IsRegisteredRewardCardPromotion: false,
        EnableAdReRanking: false, GpBoost: 0,
      },
    });
    const groups = Array.isArray(data.Products) ? data.Products : [];
    const found = groups.flatMap((g) => (Array.isArray(g.Products) ? g.Products : [g]));
    // The first few loose items get their weight from their detail, a moment apart, so they can be
    // priced per kg.
    let weighed = 0;
    for (const p of found) {
      if (weighed >= WEIGH || !isEach(p) || Number(p.UnitWeightInGrams) > 0 || !p.Stockcode) continue;
      weighed += 1;
      await page.waitForTimeout(400 + Math.random() * 600);
      try {
        const d = await pageFetch(page, `${HOME}apis/ui/product/detail/${p.Stockcode}`);
        const grams = Number((d && (d.Product || d) || {}).UnitWeightInGrams);
        if (grams > 0) p.UnitWeightInGrams = grams;
      } catch (err) { if (err instanceof Challenge) throw err; } // without its weight, it's priced each
    }
    return found.map(toResult).filter(Boolean);
  },
  async lookup(page, item) {
    const code = /productdetails\/(\d+)/.exec(item.url || '');
    if (!code) return null;
    const data = await pageFetch(page, `${HOME}apis/ui/product/detail/${code[1]}`);
    return toResult(data && (data.Product || data));
  },
};
