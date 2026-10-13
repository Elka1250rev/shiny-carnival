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
  assert.equal(original.rows[1].fiscalResult, '490');
  assert.equal(original.holdings[0].quantity, '0.25');
  assert.equal(original.tax.tax, '161.70');
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
  assert.equal(calculate(restored, 2025).tax.currentLoss, '210');
  const final = calculate(restored, 2026);
  assert.equal(final.tax.lossesUsed, '310');
  assert.equal(final.tax.taxable, '180');
  assert.equal(final.tax.tax, '59.40');
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
