import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculate, validateDataset } from '../dist/engine.js';
import { parseCsv, exportCsv, exportReportCsv, parseImport } from '../dist/csv.js';

test('the documented CSV reconstructs the actual fiscal result and the same portfolio after export', async () => {
  const example = await readFile(new URL('../examples/esempio.csv', import.meta.url), 'utf8');
  const input = parseCsv(example);
  assert.deepEqual(validateDataset(input), []);
  const original = calculate(input, 2026);
  assert.equal(original.rows[1].fiscalResult, '500');
  assert.equal(original.holdings[0].quantity, '0.25');
  assert.equal(original.tax.tax, '165.00');
  const restored = parseImport(exportCsv(input), 'sessione.csv');
  assert.deepEqual(restored, input);
  assert.deepEqual(calculate(restored, 2026), original);
});

test('an annual loss and a previously declared residue survive CSV and offset the following year', () => {
  const input = { version: 1, openingDate: '2025-01-01', initialLots: [
    { id: 'lotto-1', asset: 'BTC', acquiredOn: '2024-05-01', order: 1, quantity: '2', unitCost: '1000' },
  ], transactions: [
    { id: 'vendita-2025', date: '2025-03-01', order: 1, type: 'vendita', asset: 'BTC', quantity: '1', unitPrice: '800', fees: '10' },
    { id: 'vendita-2026', date: '2026-03-01', order: 1, type: 'vendita', asset: 'BTC', quantity: '1', unitPrice: '1500', fees: '10' },
  ], carryLosses: [{ id: 'residuo-2024', year: 2024, amount: '100' }] };
  const restored = parseCsv(exportCsv(input));
  assert.equal(calculate(restored, 2025).tax.currentLoss, '200');
  const final = calculate(restored, 2026);
  assert.equal(final.tax.lossesUsed, '300');
  assert.equal(final.tax.taxable, '200');
  assert.equal(final.tax.tax, '66.00');
  assert.equal(final.holdings[0].quantity, '0');
  assert.deepEqual(final.tax.remainingLosses, []);
});

test('CSV import does not bypass chronological balance validation', () => {
  const input = { version: 1, openingDate: '2025-01-01', initialLots: [], carryLosses: [], transactions: [
    { id: 'vendita', date: '2026-01-01', order: 1, type: 'vendita', asset: 'BTC', quantity: '0.1', unitPrice: '50000', fees: '0' },
  ] };
  const restored = parseCsv(exportCsv(input));
  assert.ok(validateDataset(restored).some(error => error.message.includes('disponibil')));
  assert.throws(() => calculate(restored, 2026));
});

test('the consultation report cannot be mistaken for the recoverable source CSV', async () => {
  const data = parseCsv(await readFile(new URL('../examples/esempio.csv', import.meta.url), 'utf8'));
  const report = exportReportCsv(calculate(data, 2026).rows);
  assert.throws(() => parseCsv(report));
});

test('CSV round trips preserve fee expenses in management results while fiscal gains use gross amounts', () => {
  const input = { version: 1, openingDate: '2025-01-01', initialLots: [], carryLosses: [], transactions: [
    { id: 'buy', date: '2025-02-01', order: 1, type: 'acquisto', asset: 'BTC', quantity: '2', unitPrice: '100', fees: '3' },
    { id: 'first-sale', date: '2025-02-02', order: 1, type: 'vendita', asset: 'BTC', quantity: '1', unitPrice: '150', fees: '2' },
    { id: 'final-sale', date: '2025-02-03', order: 1, type: 'vendita', asset: 'BTC', quantity: '1', unitPrice: '200', fees: '4' },
  ] };
  const restored = parseImport(exportCsv(input), 'sessione.csv');
  assert.deepEqual(restored, input);
  const result = calculate(restored, 2025);
  // Independent cash reconciliation after liquidation: EUR 350 gross receipts
  // minus EUR 200 purchases = EUR 150 fiscal gain; EUR 9 expenses reduce the
  // management profit to EUR 141. The two sales share the EUR 203 opening cost.
  assert.equal(result.tax.gains, '150');
  assert.equal(result.tax.tax, '39.00');
  assert.equal(result.rows[1].managementResult, '46.5');
  assert.equal(result.rows[2].managementResult, '94.5');
  assert.equal(result.rows[1].managementProceeds, '148');
  assert.equal(result.rows[2].managementProceeds, '196');
  assert.equal(result.holdings[0].quantity, '0');
  assert.equal(result.holdings[0].cost, '0');
  assert.equal(result.holdings[0].fiscalCost, '0');
  assert.deepEqual(calculate(parseCsv(exportCsv(restored)), 2025), result);
});

test('seeded multiasset CSV round trips preserve full-liquidation results at 18-decimal precision', () => {
  let seed = 782341;
  const random = maximum => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % maximum;
  };
  // Independent fixed-point accounting: quantities are integer units of 10^-18;
  // integer prices keep gross fiscal cash flows exact in those units. Fees are
  // generated and retained in the CSV, but are not deductible fiscal costs.
  const scale = 10n ** 18n;
  const fixed = units => {
    const absolute = units < 0n ? -units : units;
    return `${units < 0n ? '-' : ''}${absolute / scale}.${String(absolute % scale).padStart(18, '0')}`;
  };
  const canonical = units => fixed(units).replace(/\.?0+$/, '');
  const quantityUnits = () => BigInt(1 + random(5)) * scale + BigInt(1 + random(99999));
  const assets = ['BTC', '石油', 'ΝΕΣΠΟΛΑ'];

  for (let sample = 0; sample < 20; sample += 1) {
    const input = {
      version: 1, openingDate: '2025-01-01', initialLots: [], transactions: [],
      carryLosses: [{ id: `residuo; "è"-${sample}`, year: 2024, amount: '123.000000000000000001' }],
    };
    const expectedNet = new Map([[2025, 0n], [2026, 0n]]);
    const orders = new Map([[2025, 0], [2026, 0]]);
    assets.forEach((asset, assetIndex) => {
      const initialQuantity = quantityUnits();
      const initialPrice = BigInt(200 + random(701));
      input.initialLots.push({
        id: `lotto; "è"-${sample}-${assetIndex}`, asset, acquiredOn: '2024-02-29', order: 0,
        quantity: fixed(initialQuantity), unitCost: String(initialPrice),
      });
      expectedNet.set(2025, expectedNet.get(2025) - initialQuantity * initialPrice);

      for (const year of [2025, 2026]) {
        let balance = year === 2025 ? initialQuantity : 0n;
        const append = (type, quantity) => {
          const price = BigInt(200 + random(701));
          const fees = BigInt(random(4)) * scale + BigInt(1 + random(99999));
          const order = orders.get(year);
          orders.set(year, order + 1);
          input.transactions.push({
            id: `tx; "è"-${sample}-${year}-${order}`, asset, date: `${year}-01-15`, order, type,
            quantity: fixed(quantity), unitPrice: String(price), fees: fixed(fees),
          });
          const cashFlow = type === 'acquisto' ? -quantity * price : quantity * price;
          expectedNet.set(year, expectedNet.get(year) + cashFlow);
          balance += type === 'acquisto' ? quantity : -quantity;
        };
        const firstPurchase = quantityUnits();
        append('acquisto', firstPurchase);
        append('acquisto', quantityUnits());
        append('vendita', firstPurchase);
        append('vendita', balance);
        assert.equal(balance, 0n);
      }
    });
    // Input storage order differs from the same-day chronological sequence.
    input.transactions.reverse();
    assert.deepEqual(validateDataset(input), [], `sample ${sample}`);
    const restored = parseImport(exportCsv(input), 'sessione.CSV');
    assert.deepEqual(restored, input);

    for (const year of [2025, 2026]) {
      const calculated = calculate(restored, year);
      assert.deepEqual(calculated, calculate(input, year));
      // Liquidating every position makes the annual realized net independent
      // of LIFO allocation: gross sale proceeds minus gross acquisition costs.
      assert.equal(calculated.tax.net, canonical(expectedNet.get(year)), `sample ${sample}, year ${year}`);
      assert.equal(calculated.holdings.length, assets.length);
      for (const holding of calculated.holdings) {
        assert.equal(holding.quantity, '0');
        assert.equal(holding.cost, '0');
        assert.equal(holding.fiscalCost, '0');
      }
      const report = exportReportCsv(calculated.rows);
      assert.ok(report.startsWith('\uFEFF'));
      assert.ok(report.includes('"tx; ""è""-'));
    }
  }
});
