import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/money.js';

test('formats dollars and cents', () => {
  assert.equal(formatMoney(123450), '$1,234.50');
  assert.equal(formatMoney(5), '$0.05');
});

test('other currencies', () => {
  assert.equal(formatMoney(300, 'EUR'), '€3.00');
  assert.equal(formatMoney(200, 'CHF'), 'CHF 2.00');
});
