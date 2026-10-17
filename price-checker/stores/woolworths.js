'use strict';

// Woolworths: its search page asks /apis/ui/Search/products for results, and a product's own page
// asks /apis/ui/product/detail/{stockcode}. These only answer from inside an open Woolworths tab
// (with the cookies its bot protection gives a browser). Prices are in dollars; WasPrice is the
// normal price (the same as Price when it isn't on special). A visitor who isn't logged in gets the
// prices of Woolworths' default store.

const { challenged, pageFetch, result } = require('./common');

const HOME = 'https://www.woolworths.com.au/';
const urlOf = (p) => `https://www.woolworths.com.au/shop/productdetails/${p.Stockcode}/${p.UrlFriendlyName || ''}`.replace(/\/$/, '');

const toResult = (p) => p && result({
  name: p.DisplayName || p.Name,
  size: p.PackageSize,
  price: p.Price ?? p.InstorePrice,
  was: p.WasPrice ?? p.InstoreWasPrice,
  special: p.IsOnSpecial || p.IsInstoreOnSpecial,
  unit: p.CupString,
  url: urlOf(p),
  available: p.IsAvailable ?? p.IsInStock,
});

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
    return groups.flatMap((g) => (Array.isArray(g.Products) ? g.Products : [g])).map(toResult).filter(Boolean);
  },
  async lookup(page, item) {
    const code = /productdetails\/(\d+)/.exec(item.url || '');
    if (!code) return null;
    const data = await pageFetch(page, `${HOME}apis/ui/product/detail/${code[1]}`);
    return toResult(data && (data.Product || data));
  },
};
