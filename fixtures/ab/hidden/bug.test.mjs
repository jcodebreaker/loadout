// Hidden check for the "bug" task: the percent code must count quantity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discount, orderTotal } from './src/cart.js';

test('SAVE10 counts quantity', () => {
  assert.equal(discount([{ name: 'Mug', priceCents: 1200, qty: 3 }], 'SAVE10'), 360);
  assert.equal(orderTotal([{ name: 'Mug', priceCents: 1200, qty: 2 }], 'SAVE10'), 2659);
});

test('single items and other codes unchanged', () => {
  assert.equal(discount([{ name: 'Mug', priceCents: 1200 }], 'SAVE10'), 120);
  assert.equal(discount([{ name: 'Mug', priceCents: 1200, qty: 2 }], 'FLAT5'), 500);
});
