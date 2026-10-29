// Hidden check for the "refactor" task: formatMoney behaves exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from './src/money.js';

const cases = [
  [[0], '$0.00'], [[5], '$0.05'], [[99], '$0.99'], [[100], '$1.00'], [[123450], '$1,234.50'],
  [[100000], '$1,000.00'], [[123456789], '$1,234,567.89'], [[-1999], '-$19.99'], [[-5], '-$0.05'],
  [[300, 'EUR'], '€3.00'], [[250000, 'GBP'], '£2,500.00'], [[200, 'CHF'], 'CHF 2.00'], [[200, null], '$2.00'],
];

test('same output as before', () => {
  for (const [args, want] of cases) assert.equal(formatMoney(...args), want, JSON.stringify(args));
});
