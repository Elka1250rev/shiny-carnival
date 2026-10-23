import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculate } from '../dist/engine.js';
import { exportCsv } from '../dist/csv.js';
import { selectLedgerRecords, renderLedgerCards, renderConsumedLots, fiscalResultText, unitMoney } from '../dist/ledger-view.js';

const dataset = overrides => ({ version: 1, openingDate: '2025-01-01', initialLots: [], transactions: [], carryLosses: [], ...overrides });
const operation = (id, overrides = {}) => ({ id, date: '2026-02-01', order: 1, asset: 'BTC', type: 'acquisto', quantity: '1', unitPrice: '10', fees: '0', ...overrides });

test('year and crypto filters select calculated rows without changing historical LIFO balances or exports', () => {
  const data = dataset({ version: 2, transactions: [
    operation('previous-year', { date: '2025-12-31', quantity: '2', unitPrice: '20' }),
    operation('sale', { type: 'vendita', unitPrice: '30' }),
    operation('other-asset', { asset: 'ETH', order: 2 }),
  ] });
  const originalCsv = exportCsv(data);
  const result = calculate(data, 2026);
  const originalResult = structuredClone(result);
  const selected = selectLedgerRecords('transactions', result, data, { year: 2026, assetFilter: 'btc' });
  assert.equal(selected.sourceCount, 3);
  assert.equal(selected.yearCount, 2);
  assert.deepEqual(selected.pageRows.map(row => row.id), ['sale']);
  assert.equal(selected.pageRows[0].beforeQuantity, '2');
  assert.equal(selected.pageRows[0].costBasis, '20');
  assert.equal(result.tax.net, '10');
  assert.deepEqual(result, originalResult);
  assert.equal(exportCsv(data), originalCsv);
  assert.equal(selectLedgerRecords('transactions', result, data, { year: 2026, showAllYears: true }).records.length, 3);
  assert.equal(selectLedgerRecords('holdings', result, data, { year: 2025 }).records.length, 2);
});

test('pagination keeps all matching records and clamps pages after filtering or deletion', () => {
  const data = dataset({ transactions: Array.from({ length: 62 }, (_, index) => operation('purchase-' + index, { order: index + 1, asset: index < 30 ? 'BTC' : 'ETH' })) });
  const result = calculate(data, 2026);
  const second = selectLedgerRecords('transactions', result, data, { year: 2026, page: 2 });
  assert.equal(second.records.length, 62);
  assert.equal(second.pageRows.length, 25);
  assert.equal(second.from, 26);
  assert.equal(second.to, 50);
  assert.equal(second.totalPages, 3);
  const filtered = selectLedgerRecords('transactions', result, data, { year: 2026, page: 20, assetFilter: 'BTC' });
  assert.equal(filtered.page, 2);
  assert.equal(filtered.pageRows.length, 5);
  const empty = selectLedgerRecords('transactions', result, data, { year: 2025, page: 2 });
  assert.deepEqual([empty.page, empty.from, empty.to, empty.yearCount, empty.sourceCount], [1, 0, 0, 0, 62]);
});

test('search includes the incoming asset of a swap and cards show both balances without disclosure controls', () => {
  const data = dataset({ version: 2, transactions: [
    operation('purchase', { quantity: '2' }),
    operation('swap', { date: '2026-02-02', type: 'permuta_neutrale', quantity: '1', unitPrice: '0', receivedAsset: 'ETH', receivedQuantity: '3', lotDatePolicy: 'historical' }),
  ] });
  const result = calculate(data, 2026);
  const selected = selectLedgerRecords('transactions', result, data, { year: 2026, assetFilter: 'eth' });
  assert.deepEqual(selected.records.map(row => row.id), ['swap']);
  const html = renderLedgerCards('transactions', selected.records);
  assert.match(html, /Prima l’operazione/);
  assert.match(html, /Dopo l’operazione/);
  assert.equal((html.match(/Quantità BTC/g) || []).length, 2);
  assert.equal((html.match(/Quantità ETH/g) || []).length, 2);
  assert.match(html, /Costo storico trasferito: nessun realizzo/);
  assert.doesNotMatch(html, /<details/);
});

test('sale cards expose actual consumed lot cost and exact engine display rounding', () => {
  const data = dataset({ transactions: [
    operation('old-lot', { date: '2025-01-01', unitPrice: '10' }),
    operation('new-lot', { date: '2026-01-01', unitPrice: '20' }),
    operation('sale', { type: 'vendita', quantity: '1.5', unitPrice: '30' }),
  ] });
  const row = calculate(data, 2026).rows.at(-1);
  assert.equal(row.costBasis, '25');
  const html = renderLedgerCards('transactions', [row]);
  assert.match(html, /Corrispettivo fiscale lordo<\/dt><dd>45,00 €/);
  assert.match(html, /Costo fiscale di carico LIFO<\/dt><dd>25,00 €/);
  assert.match(html, /Plusvalenza<\/dt><dd>\+20,00 €/);
  const details = renderConsumedLots(row.lotDetails);
  assert.match(details, /new-lot/);
  assert.match(details, /old-lot/);
  assert.match(details, /Quantità ceduta<\/dt><dd>0,5/);
  const rounding = { ...row, fiscalResult: '0.015', display: { ...row.display, fiscalResult: '0.01', fiscalSign: 1 } };
  assert.equal(fiscalResultText(rounding), '+0,01 €');
  assert.equal(fiscalResultText({ ...rounding, display: { ...rounding.display, fiscalResult: '0.00' } }), '+ < 0,005 €');
});

test('cards escape original asset and lot identifiers and keep unit prices below a cent readable', () => {
  const row = calculate(dataset({ transactions: [operation('safe')] }), 2026).rows[0];
  const html = renderLedgerCards('transactions', [{ ...row, asset: 'A<B', id: 'x" onclick="bad' }]);
  assert.match(html, /A&lt;B/);
  assert.match(html, /data-record-id="x&quot; onclick=&quot;bad"/);
  assert.doesNotMatch(html, /<B|id="x" onclick/);
  assert.equal(unitMoney('0.00000001'), '0,00000001 €');
  const detail = renderConsumedLots([{ lotId: '<lot>', acquiredOn: null, order: 1, quantity: '1', unitCost: '0', cost: '0', display: { unitCost: '0.000000000000000000', unitCostSign: 1, cost: '0.00' } }]);
  assert.match(detail, /Inferiore a 0,000000000000000001 €/);
  assert.match(detail, /&lt;lot&gt;/);
});

test('rounded sale amounts explain a visible difference of one cent without changing the exact result', () => {
  const data = dataset({ transactions: [
    operation('purchase', { date: '2025-01-01', unitPrice: '25.004' }),
    operation('sale', { type: 'vendita', unitPrice: '45.005' }),
  ] });
  const row = calculate(data, 2026).rows.at(-1);
  const html = renderLedgerCards('transactions', [row]);
  assert.equal(row.fiscalResult, '20.001');
  assert.match(html, /45,01 €/);
  assert.match(html, /25,00 €/);
  assert.match(html, /\+20,00 €/);
  assert.match(html, /arrotondati ai centesimi; il risultato usa i valori esatti/);
});
