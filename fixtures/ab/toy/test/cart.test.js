import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discount, orderTotal, receipt, subtotal } from '../src/cart.js';

const mug = { name: 'Mug', priceCents: 1200 };

test('subtotal counts quantity', () => {
  assert.equal(subtotal([{ ...mug, qty: 2 }, { name: 'Tea', priceCents: 450 }]), 2850);
});

test('codes', () => {
  assert.equal(discount([mug], 'SAVE10'), 120);
  assert.equal(discount([mug], 'FLAT5'), 500);
  assert.equal(discount([mug], 'NOPE'), 0);
});

test('order total adds shipping', () => {
  assert.equal(orderTotal([mug]), 1699);
  assert.equal(orderTotal([mug], 'SAVE10'), 1579);
});

test('receipt ends with the total', () => {
  assert.equal(receipt([mug]).at(-1), 'Total  $16.99');
});
