# tiny-cart

Cart math for a small online shop. Prices are integer cents.

```js
import { orderTotal, receipt } from './src/cart.js';

orderTotal([{ name: 'Mug', priceCents: 1200, qty: 2 }], 'SAVE10'); // 2659
```

- `subtotal(items)`: sum of `priceCents * qty` (qty defaults to 1).
- `discount(items, code)`: cents off for a code. `SAVE10` is 10% off, `FLAT5` is $5 off. Unknown codes give 0.
- `orderTotal(items, code)`: subtotal minus discount plus flat shipping ($4.99).
- `receipt(items, code)`: printable lines.
- `formatMoney(cents, currency = 'USD')` in `src/money.js`: `$1,234.50`, `€3.00`, `CHF 2.00`.

Run the tests with `node --test`.
