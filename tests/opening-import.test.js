import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetDecimal, parseOpeningSheet, openingUnitCost, openingDateForSnapshot, convertOpeningSnapshot, OPENING_COLUMNS } from '../dist/opening-import.js';
import { calculate, validateDataset } from '../dist/engine.js';
import { buildPdfReportData } from '../dist/pdf-report.js';
import { exportCsv, parseCsv } from '../dist/csv.js';

const cell = (value, formula = null) => ({ value, formula, type: 'text' });
const row = (number, values) => ({ number, cells: Object.fromEntries(values.map((value, index) => [index + 1, typeof value === 'object' ? value : cell(value)])) });
const table = () => ({ name: 'Saldi inventati', rows: [row(1, ['SALDI AL 31.12.2024']), row(3, OPENING_COLUMNS),
  row(4, ['ALFA', '3', '900', cell('2700', 'PRODUCT(B4:C4)')]), row(5, ['EUR', '40', '2', cell('80', 'PRODUCT(B5:C5)')]),
  row(6, ['', 'TOTALE VALORE CRIPTO IN EURO:', '', cell('2780', 'SUM(D4:D5)')])] });
const current = version => ({ version: version || 1, openingDate: '2025-01-01', initialLots: [{ id: 'old', asset: 'OLD', acquiredOn: '2024-01-01', order: 1, quantity: '1', unitCost: '4' }],
  transactions: [{ id: 'sale', asset: 'ALFA', date: '2025-01-03', order: 1, type: 'vendita', quantity: '1', unitPrice: '25', fees: '0' }], carryLosses: [{ id: 'loss', year: 2024, amount: '2' }] });
const options = overrides => ({ snapshotDate: '2024-12-31', timing: 'end', valueMeaning: 'market', replaceConfirmed: true, costsConfirmed: true, euroConfirmed: true, idPrefix: 'synthetic',
  lots: { 4: [{ acquiredOn: '2024-04-10', quantity: '1', unitCost: '10' }, { acquiredOn: '2024-07-12', quantity: '2', unitCost: '20' }] }, ...overrides });

test('headers can follow notes and blank rows; totals and original values remain informative', () => {
  const parsed = parseOpeningSheet(table());
  assert.equal(parsed.headerRow, 3); assert.equal(parsed.rows.length, 2); assert.equal(parsed.totals.length, 1);
  assert.equal(parsed.rows[0].unitValue, '900'); assert.equal(parsed.rows[0].totalFormula, 'PRODUCT(B4:C4)');
  assert.match(parsed.notes[0].text, /31\.12\.2024/);
  assert.equal('snapshotDate' in parsed, false, 'The heading must not silently supply the snapshot date.');
});
test('a title containing CRIPTOVALUTA cannot hide the complete table header below it', () => {
  const input = table();
  input.rows[0] = row(1, ['CRIPTOVALUTA']);
  const parsed = parseOpeningSheet(input);
  assert.equal(parsed.headerRow, 3);
  assert.deepEqual(parsed.rows.map(item => item.asset), ['ALFA', 'EUR']);
  assert.equal(parsed.notes[0].text, 'CRIPTOVALUTA');
});
test('reordered columns work while missing, duplicate and unknown headers are rejected', () => {
  const reversed = { name: 'Reverse', rows: [row(1, [...OPENING_COLUMNS].reverse()), row(2, ['600', '300', '2', 'BETA'])] };
  assert.equal(parseOpeningSheet(reversed).rows[0].quantity, '2');
  for (const headers of [OPENING_COLUMNS.slice(0, 3), [...OPENING_COLUMNS, 'EURO'], [...OPENING_COLUMNS, 'OTHER']]) {
    assert.throws(() => parseOpeningSheet({ name: 'bad', rows: [row(1, headers)] }), /intestazion/);
  }
  assert.throws(() => parseOpeningSheet({ name: 'bad', rows: [row(1, ['ALFA', '1', '2', '2'])] }), /Intestazioni non trovate/);
});
test('ambiguous extra rows and formulas in quantities are never silently skipped or run', () => {
  const extra = table(); extra.rows.push(row(7, ['', 'unexplained', '', '1']));
  assert.throws(() => parseOpeningSheet(extra), /Riga Excel 7/);
  const computed = table(); computed.rows[2].cells[2] = cell('3', 'SUM(A1:A9)');
  assert.throws(() => parseOpeningSheet(computed), /senza formule/);
});
test('Excel logical values, dates and errors cannot become quantities or asset identifiers', () => {
  for (const type of ['b', 'e', 'd', 'unsupported']) {
    const quantity = table();
    quantity.rows[2].cells[2] = { type, value: '1', formula: null };
    assert.throws(() => parseOpeningSheet(quantity), /Riga Excel 4: la quantità/);
    const asset = table();
    asset.rows[2].cells[1] = { type, value: '1', formula: null };
    assert.throws(() => parseOpeningSheet(asset), /Riga Excel 4: identificatore/);
  }
});
test('unsafe source costs require a manual correction rather than silently copying a cached digit', () => {
  for (const sourceCell of [
    ...['b', 'e', 'd', 'unsupported'].map(type => ({ type, value: '1', formula: null })),
    { type: 'number', value: '1', formula: 'SUM(B1:B3)' }
  ]) {
    const input = table(); input.rows[2].cells[3] = sourceCell;
    const parsed = parseOpeningSheet(input);
    assert.throws(() => openingUnitCost(parsed.rows[0]), /Inserisci manualmente/);
    const corrected = convertOpeningSnapshot(parsed, current(), options({ valueMeaning: 'estimated_average',
      lots: { 4: [{ quantity: '3', unitCost: '12' }] } }));
    assert.equal(corrected.initialLots[0].unitCost, '12');
    assert.equal(corrected.initialLots[0].basisMethod, 'estimated_average');
  }
  for (const type of ['text', 'number']) {
    assert.equal(openingUnitCost({ unitType: type, unitValue: '1.23456789012345678E-1', unitFormula: null }), '0.123456789012345678');
  }
});
test('scientific numeric strings expand exactly and formatting never rounds quantities', () => {
  assert.equal(sheetDecimal('1.23456789012345678E-1'), '0.123456789012345678');
  assert.equal(sheetDecimal('5.0000000000000004'), '5.0000000000000004');
  assert.equal(sheetDecimal('7E+2'), '700'); assert.equal(sheetDecimal('0000.0000'), '0');
  assert.equal(sheetDecimal('1,25'), '1.25');
  for (const invalid of ['-1', '1.234,56', 'NaN', '=1+2', '1e999', '']) assert.throws(() => sheetDecimal(invalid));
});
test('snapshot date and start/end choice are explicit, including year and leap boundaries', () => {
  assert.throws(() => openingDateForSnapshot('', 'end'), /esplicitamente/);
  assert.throws(() => openingDateForSnapshot('2025-01-01', ''), /inizio o alla fine/);
  assert.equal(openingDateForSnapshot('2024-12-31', 'end'), '2025-01-01');
  assert.equal(openingDateForSnapshot('2025-01-01', 'start'), '2025-01-01');
  assert.equal(openingDateForSnapshot('2025-02-28', 'end'), '2025-03-01');
  for (const value of ['2025-02-29', '2025-13-01', '2026-12-31']) assert.throws(() => openingDateForSnapshot(value, 'end'));
});
test('market values do not become cost; documented split lots drive LIFO and CSV recovery', () => {
  for (const version of [1, 2]) {
    const source = parseOpeningSheet(table()); const old = current(version); const before = structuredClone(old);
    const result = convertOpeningSnapshot(source, old, options());
    assert.equal(result.openingDate, '2025-01-01'); assert.equal(result.initialLots.length, 2);
    assert.deepEqual(result.transactions, old.transactions); assert.deepEqual(result.carryLosses, old.carryLosses);
    assert.ok(result.initialLots.every(lot => lot.asset === 'ALFA'));
    assert.equal(calculate(result, 2025).rows[0].fiscalResult, '5', 'The recent documented lot costs20, never market value900.');
    assert.deepEqual(parseCsv(exportCsv(result)), result);
    assert.deepEqual(old, before);
  }
});
test('date, confirmations, per-lot costs and quantity reconciliation block incomplete imports', () => {
  const source = parseOpeningSheet(table());
  for (const overrides of [{ snapshotDate: '' }, { valueMeaning: undefined }, { valueMeaning: 'unknown' }, { replaceConfirmed: false }, { costsConfirmed: false }, { euroConfirmed: false }, { lots: {} },
    { lots: { 4: [{ acquiredOn: '', quantity: '3', unitCost: '10' }] } },
    { lots: { 4: [{ acquiredOn: '2025-01-01', quantity: '3', unitCost: '10' }] } },
    { lots: { 4: [{ acquiredOn: '2024-01-01', quantity: '3', unitCost: '' }] } },
    { lots: { 4: [{ acquiredOn: '2024-01-01', quantity: '2', unitCost: '10' }] } }]) assert.throws(() => convertOpeningSnapshot(source, current(), options(overrides)));
});
test('overprecise stored quantities need an explicit correction; no epsilon balances or rounding', () => {
  const input = table(); input.rows[2].cells[2] = cell('1.2345678901234567891');
  const source = parseOpeningSheet(input);
  assert.equal(source.rows[0].quantity, '1.2345678901234567891');
  assert.throws(() => convertOpeningSnapshot(source, current(), options()), /18 decimali/);
  const fixed = convertOpeningSnapshot(source, current(), options({ quantities: { 4: '1.23456789012345678' },
    lots: { 4: [{ acquiredOn: '2024-01-01', quantity: '1.23456789012345678', unitCost: '0' }] } }));
  assert.equal(fixed.initialLots[0].quantity, '1.23456789012345678');
  assert.equal(fixed.initialLots[0].unitCost, '0');
  assert.equal(source.rows[0].quantity, '1.2345678901234567891');
});

test('explicitly confirmed zero or fiat-only snapshots can clear opening lots without creating EUR holdings', () => {
  const sheet = table(); sheet.rows[2].cells[2] = cell('0');
  const source = parseOpeningSheet(sheet);
  const old = current(); old.transactions = [];
  const result = convertOpeningSnapshot(source, old, options({ lots: {} }));
  assert.deepEqual(result.initialLots, []);
  assert.equal(calculate(result, 2025).holdings.length, 0);
  assert.deepEqual(parseCsv(exportCsv(result)), result);
});

test('an explicitly estimated average is recoverable and editable without inventing purchase dates', () => {
  const source = parseOpeningSheet(table());
  const next = convertOpeningSnapshot(source, current(), options({ valueMeaning: 'estimated_average', lots: { 4: [{ quantity: '3', unitCost: '900', acquiredOn: '' }] } }));
  assert.equal(next.version, 2);
  assert.equal(next.initialLots[0].basisMethod, 'estimated_average');
  assert.equal(next.initialLots[0].acquiredOn, '');
  assert.equal(calculate(next, 2025).rows[0].fiscalResult, '-875');
  assert.deepEqual(parseCsv(exportCsv(next)), next);
  next.initialLots[0].unitCost = '15';
  const updated = calculate(next, 2025);
  assert.equal(updated.rows[0].fiscalResult, '10');
  assert.ok(updated.warnings.some(message => message.includes('stimato') && message.includes('indicativi')));
  assert.match(JSON.stringify(buildPdfReportData(updated, next.openingDate)), /prezzo medio storico stimato/);
  assert.deepEqual(parseCsv(exportCsv(next)), next, 'A later cost correction must preserve the estimated status and blank date.');
  assert.throws(() => exportCsv({ ...next, version: 1 }), /formato 2/);
});

test('new purchases precede undated opening aggregates in LIFO, including opening-day orders', () => {
  const next = convertOpeningSnapshot(parseOpeningSheet(table()), { ...current(), carryLosses: [], transactions: [
    { id: 'new', asset: 'ALFA', date: '2025-01-01', order: 0, type: 'acquisto', quantity: '1', unitPrice: '30', fees: '0' },
    { id: 'sale', asset: 'ALFA', date: '2025-01-01', order: 1, type: 'vendita', quantity: '2', unitPrice: '40', fees: '0' }
  ] }, options({ valueMeaning: 'estimated_average', lots: { 4: [{ quantity: '3', unitCost: '12' }] } }));
  const sale = calculate(next, 2025).rows[1];
  assert.equal(sale.costBasis, '42');
  assert.equal(sale.fiscalResult, '38');
  assert.deepEqual(sale.lotDetails.map(lot => lot.acquiredOn), ['2025-01-01', '']);
});

test('estimated flags reject false dates, unknown methods and mixed initial lots for the same asset', () => {
  const next = convertOpeningSnapshot(parseOpeningSheet(table()), current(), options({ valueMeaning: 'estimated_average', lots: { 4: [{ quantity: '3', unitCost: '12' }] } }));
  const dated = structuredClone(next); dated.initialLots[0].acquiredOn = '2024-12-31';
  assert.throws(() => exportCsv(dated), /vuota/);
  assert.ok(validateDataset(dated).some(error => error.location.endsWith('.acquiredOn')));
  const unknown = structuredClone(next); unknown.initialLots[0].basisMethod = 'market_value';
  assert.throws(() => exportCsv(unknown), /basisMethod/);
  const mixed = structuredClone(next); mixed.initialLots.push({ id: 'extra', asset: 'ALFA', acquiredOn: '2024-02-01', order: 1, quantity: '1', unitCost: '5' });
  assert.ok(validateDataset(mixed).some(error => error.message.includes('unico lotto iniziale')));
  const unmarked = structuredClone(next); delete unmarked.initialLots[0].basisMethod;
  assert.ok(validateDataset(unmarked).some(error => error.location.endsWith('.acquiredOn')));
});
