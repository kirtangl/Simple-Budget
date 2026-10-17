'use strict';

// Coles: a Next.js site. The search page's data comes from /_next/data/{build}/en/search/products.json,
// where {build} is in the open page (window.__NEXT_DATA__). Coles checks visitors closely (Imperva)
// and in testing turned an automated browser away every time, with no puzzle to solve, so here
// that's usually "try later". Searches are spaced out more, and the checker never presses on.

const { challenged, pageFetch, result } = require('./common');

const HOME = 'https://www.coles.com.au/';
const slug = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const urlOf = (p) => `${HOME}product/${slug([p.brand, p.name, p.size].filter(Boolean).join(' '))}-${p.id}`;

const toResult = (p) => p && p.pricing && result({
  name: [p.brand, p.name].filter(Boolean).join(' '),
  size: p.size,
  price: p.pricing.now,
  was: p.pricing.was,
  special: Boolean(p.pricing.promotionType) || Boolean(p.pricing.was),
  unit: p.pricing.comparable,
  url: urlOf(p),
  available: p.availability,
});

async function build(page) {
  const id = await page.evaluate(() => (window.__NEXT_DATA__ && window.__NEXT_DATA__.buildId) || null);
  if (!id) throw new Error("Couldn't read the Coles page. It may have changed.");
  return id;
}

module.exports = {
  toResult,
  id: 'coles',
  name: 'Coles',
  home: HOME,
  gap: [4000, 8000],
  show: (page, q) => page.goto(`${HOME}search/products?q=${encodeURIComponent(q || '')}`, { waitUntil: 'domcontentloaded' }),
  challenged,
  async search(page, q) {
    const data = await pageFetch(page, `${HOME}_next/data/${await build(page)}/en/search/products.json?q=${encodeURIComponent(q)}`);
    const found = data && data.pageProps && data.pageProps.searchResults;
    return (found && Array.isArray(found.results) ? found.results : []).filter((p) => p && p._type === 'PRODUCT').map(toResult).filter(Boolean);
  },
};
