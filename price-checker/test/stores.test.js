'use strict';

// What the store adapters make of a store's own search data: here, its product pictures.
const test = require('node:test');
const assert = require('node:assert/strict');
const woolworths = require('../stores/woolworths');
const coles = require('../stores/coles');
const aldi = require('../stores/aldi');

test('results carry a small picture from the store\'s own picture server', () => {
  const w = woolworths.toResult({ Stockcode: 1, Name: 'Test Oats', PackageSize: '750g', Price: 2.8, UrlFriendlyName: 'test-oats',
    SmallImageFile: 'https://cdn0.woolworths.media/content/wowproductimages/small/000001.jpg' });
  assert.equal(w.image, 'https://cdn0.woolworths.media/content/wowproductimages/small/000001.jpg');
  const c = coles.toResult({ id: 2, brand: 'Test', name: 'Oats', size: '750g', pricing: { now: 3 }, imageUris: [{ uri: '/2/2.jpg' }] });
  assert.equal(c.image, 'https://productimages.coles.com.au/productimages/2/2.jpg');
  const a = aldi.toResult({ sku: '3', name: 'Oats', sellingSize: '750 g', urlSlugText: 'oats', price: { amount: 199 },
    assets: [{ url: 'https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/{width}/abc/{slug}' }] });
  assert.equal(a.image, 'https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/120/abc/oats');
  // Anywhere else is left out.
  const x = woolworths.toResult({ Stockcode: 4, Name: 'Odd', Price: 1, SmallImageFile: 'https://elsewhere.example/1.jpg' });
  assert.equal(x.image, undefined);
});

test('Aldi loose fruit and veg sold by the kilo', () => {
  assert.equal(aldi.toResult({ sku: '5', name: 'Brown Onions', sellingSize: 'per kg', price: { amount: 349 } }).sold, 'kg');
  assert.equal(aldi.toResult({ sku: '5', name: 'Brown Onions', sellingSize: 'per kg', price: { amount: 349 } }).per_kg_cents, 349);
  assert.equal(aldi.toResult({ sku: '6', name: 'Pears 1kg bag', sellingSize: '1 kg', price: { amount: 349 } }).sold, 'pack');
});
