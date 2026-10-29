import { formatMoney } from './money.js';

export const SHIPPING_CENTS = 499;

const CODES = {
  SAVE10: { type: 'percent', value: 10 },
  FLAT5: { type: 'flat', value: 500 },
};

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.priceCents * (item.qty ?? 1), 0);
}

export function discount(items, code) {
  const rule = CODES[code];
  if (!rule) return 0;
  if (rule.type === 'flat') return Math.min(rule.value, subtotal(items));
  return items.reduce((off, item) => off + Math.round((item.priceCents * rule.value) / 100), 0);
}

export function orderTotal(items, code) {
  return subtotal(items) - discount(items, code) + SHIPPING_CENTS;
}

export function receipt(items, code) {
  const lines = items.map((item) => `${item.qty ?? 1} x ${item.name}  ${formatMoney(item.priceCents * (item.qty ?? 1))}`);
  const off = discount(items, code);
  if (off) lines.push(`Discount (${code})  -${formatMoney(off)}`);
  lines.push(`Shipping  ${formatMoney(SHIPPING_CENTS)}`);
  lines.push(`Total  ${formatMoney(orderTotal(items, code))}`);
  return lines;
}
