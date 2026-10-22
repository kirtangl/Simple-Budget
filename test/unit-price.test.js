'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../public/unit-price');

test('sizes are read the way stores and the list write them', () => {
  assert.deepEqual(U.parse('375g'), { kind: 'weight', amount: 375 });
  assert.deepEqual(U.parse('1.5 kg'), { kind: 'weight', amount: 1500 });
  assert.deepEqual(U.parse('150mL'), { kind: 'volume', amount: 150 });
  assert.deepEqual(U.parse(3, 'L'), { kind: 'volume', amount: 3000 });
  assert.deepEqual(U.parse('6 pack'), { kind: 'count', amount: 6 });
  assert.deepEqual(U.parse('each'), { kind: 'count', amount: 1 });
  assert.deepEqual(U.parse(null, 'each'), { kind: 'count', amount: 1 });
  assert.deepEqual(U.parse('Coles Chicken Thigh Fillets Bulk Pack 1kg'), { kind: 'weight', amount: 1000 });
  assert.equal(U.parse(''), null);
  assert.equal(U.parse('family size'), null);
  assert.equal(U.parse(null), null);
});

test('weights are per kg, volumes per L and packs per each', () => {
  assert.equal(U.text(U.of(500, '375g')), '$13.33/kg');
  assert.equal(U.text(U.of(495, 3, 'L')), '$1.65/L');
  assert.equal(U.text(U.of(500, '100 mL')), '$50.00/L');
  assert.equal(U.text(U.of(269, '230g')), '$11.70/kg');
  assert.equal(U.text(U.of(300, '6 pack')), '$0.50 each');
  assert.equal(U.text(U.perKg(2000)), '$20.00/kg');
});

test("there's no unit price for one of something, or a size that can't be read", () => {
  assert.equal(U.of(84, 'each'), null);
  assert.equal(U.of(500, 'jar'), null);
  assert.equal(U.of(0, '500g'), null);
  assert.equal(U.of(NaN, '500g'), null);
  assert.equal(U.text(null), '');
});
