// Hidden check for the "feature" task: shipping is free from $50, $4.99 below.
// Only cases that read the same whether the threshold uses the subtotal before or after the discount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTotal } from './src/cart.js';

test('free shipping at $50 and over', () => {
  assert.equal(orderTotal([{ name: 'Lamp', priceCents: 6000 }]), 6000);
  assert.equal(orderTotal([{ name: 'Mug', priceCents: 2500, qty: 2 }]), 5000);
});

test('shipping below $50', () => {
  assert.equal(orderTotal([{ name: 'Mug', priceCents: 1200 }]), 1699);
  assert.equal(orderTotal([{ name: 'Mug', priceCents: 1200 }], 'FLAT5'), 1199);
});
