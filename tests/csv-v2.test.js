import test from 'node:test';
import assert from 'node:assert/strict';
import { CSV_COLUMNS, CSV_COLUMNS_V2, exportCsv, parseCsv, parseImport, exportReportCsv } from '../dist/csv.js';
import { EXCHANGE_CSV_COLUMNS } from '../dist/exchange-csv.js';
import { readCsvRecords } from '../dist/csv-reader.js';
import { calculate } from '../dist/engine.js';

function source() {
  return {
    line: 42,
    values: Object.fromEntries(EXCHANGE_CSV_COLUMNS.map(name => [name, `${name}: originale`])),
    decisions: {
      swapTaxTreatment: 'neutral', rewardTreatment: 'holding_income', rewardCostPolicy: 'zero_confirmed',
      amountsPolicy: 'as_reported_confirmed', feePolicy: 'already_included', lotDatePolicy: 'historical',
      grossValuesConfirmed: true,
    },
    derived: false,
  };
}
function transaction(type = 'acquisto', extra = {}) {
  return {
    id: `tx-${type}`, date: '2026-03-04', order: 1, type, asset: 'BTC',
    quantity: '3.000000000000000000', unitPrice: '0', fees: '0', ...extra,
  };
}
function dataset(transactions = [transaction('acquisto', { totalEur: '100.000000000000000001', source: source() })]) {
  return {
    version: 2, openingDate: '2026-01-01',
    initialLots: [{ id: 'lot-1', asset: 'BTC', acquiredOn: '2024-02-29', order: 1, quantity: '0.000000000000000001', unitCost: '50000.00' }],
    transactions, carryLosses: [{ id: 'loss-1', year: 2025, amount: '10.0000' }],
  };
}
function csv(rows, columns = CSV_COLUMNS_V2) {
  return [columns, ...rows].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(';')).join('\r\n');
}
const setting = ['2', 'configurazione', '', '2026-01-01', '', '', '', '', '', '', '', '', ''];
function row(extra = '{}', type = 'acquisto') {
  return ['2', type, 'tx-1', '2026-03-04', '1', 'BTC', '3', '0', '0', '', '', '', extra];
}

test('version 2 preserves all new operations and exact totals in repeated round trips', () => {
  const original = dataset([
    transaction('acquisto', { totalEur: '100.000000000000000001', source: source() }),
    transaction('vendita', { totalEur: '500.00' }),
    transaction('permuta_neutrale', {
      receivedAsset: 'ETH', receivedQuantity: '0.123456789012345678', lotDatePolicy: 'historical', source: source(),
    }),
    transaction('permuta_imponibile', {
      totalEur: '999999999999999999999999999999.123456789012345678',
      receivedAsset: '石油', receivedQuantity: '2', lotDatePolicy: 'exchange',
    }),
    transaction('provento', { totalEur: '12.00', rewardCostEur: '0.000000000000000000' }),
    transaction('deposito_eur', { asset: 'EUR', unitPrice: '1' }),
  ]);
  const output = exportCsv(original);
  assert.equal(readCsvRecords(output)[0].fields.length, 13);
  assert.deepEqual(readCsvRecords(output)[0].fields, CSV_COLUMNS_V2);
  assert.ok(readCsvRecords(output).slice(1).every(record => record.fields[0] === '2'));
  assert.deepEqual(parseCsv(output), original);
  assert.deepEqual(parseImport(exportCsv(parseCsv(output)), 'backup.CSV'), original);
  assert.equal(parseCsv(output).transactions[0].totalEur, '100.000000000000000001');
  assert.equal(parseCsv(output).transactions[0].unitPrice, '0');
});

test('version 2 also preserves transactions without extended values and optional metadata', () => {
  const original = dataset([transaction()]);
  assert.deepEqual(parseCsv(exportCsv(original)), original);
  const withEmptyDecisions = dataset([transaction('provento', { source: { line: 1, values: source().values, decisions: {}, derived: true } })]);
  assert.deepEqual(parseCsv(exportCsv(withEmptyDecisions)), withEmptyDecisions);
});

test('version 1 keeps its original 12 columns and refuses extended columns, types or values', () => {
  const old = { ...dataset([transaction()]), version: 1 };
  const output = exportCsv(old);
  assert.deepEqual(readCsvRecords(output)[0].fields, CSV_COLUMNS);
  assert.deepEqual(parseCsv(output), old);
  assert.throws(() => parseCsv(csv([[...setting].map((value, index) => index === 0 ? '1' : value)])), /versione CSV non supportata.*1/);
  const oldSetting = ['1', ...setting.slice(1, -1)];
  const oldSwap = ['1', ...row('{}', 'permuta_neutrale').slice(1, -1)];
  assert.throws(() => parseCsv(csv([oldSetting, oldSwap], CSV_COLUMNS)), /tipo di record non riconosciuto/);
  assert.throws(() => exportCsv({ ...old, transactions: [transaction('acquisto', { totalEur: '100' })] }), /dati estesi.*versione 2/);
  assert.throws(() => exportCsv({ ...old, transactions: [transaction('provento')] }), /tipo di transazione.*versione 1/);
});

test('all records must agree with the canonical header version', () => {
  const v1Row = row();
  v1Row[0] = '1';
  assert.throws(() => parseCsv(csv([setting, v1Row])), /Riga 3.*versione CSV non supportata.*1/);
  const v3Setting = [...setting];
  v3Setting[0] = '3';
  assert.throws(() => parseCsv(csv([v3Setting])), /Riga 2.*versione CSV non supportata.*3/);
});

test('version 2 extended columns can be reordered and stay empty on reserved record types', () => {
  const columns = [...CSV_COLUMNS_V2].reverse();
  assert.equal(parseCsv(csv([[...setting].reverse(), [...row('{"totalEur":"100"}')].reverse()], columns)).transactions[0].totalEur, '100');
  const nonempty = [...setting];
  nonempty[12] = '{}';
  assert.throws(() => parseCsv(csv([nonempty])), /Riga 2.*dati_estesi.*deve essere vuoto/);
});

test('extended JSON must be an object and rejects unknown or reserved keys', () => {
  for (const invalid of ['null', '[]', '1', '"test"', 'true', '{', '{"unknown":"100"}', '{"__proto__":{}}', '{"constructor":{}}', '{"source":{"prototype":{}}}']) {
    assert.throws(() => parseCsv(csv([setting, row(invalid)])), /Riga 3.*(?:dati_estesi|source)/, invalid);
  }
  assert.equal({}.polluted, undefined);
});

test('extended decimal values are exact strings with no exponent or numeric coercion', () => {
  for (const name of ['totalEur', 'receivedQuantity', 'rewardCostEur']) {
    for (const value of [0.1, null, true, '1e-8', '-1', '1.000,00', '9'.repeat(31), '0.' + '1'.repeat(19)]) {
      assert.throws(() => parseCsv(csv([setting, row(JSON.stringify({ [name]: value }))])), new RegExp(`Riga 3.*${name}`));
      assert.throws(() => exportCsv(dataset([transaction('acquisto', { [name]: value })])), new RegExp(name));
    }
  }
  const parsed = parseCsv(csv([setting, row('{"totalEur":"100,000000000000000001"}')]));
  assert.equal(parsed.transactions[0].totalEur, '100.000000000000000001');
});

test('policies and received assets reject unsupported values', () => {
  for (const extra of [{ lotDatePolicy: 'estimate' }, { lotDatePolicy: 1 }, { receivedAsset: '=BTC' }, { receivedAsset: '' }]) {
    assert.throws(() => parseCsv(csv([setting, row(JSON.stringify(extra))])), /Riga 3/);
    assert.throws(() => exportCsv(dataset([transaction('permuta_neutrale', extra)])), /Riga 4/);
  }
});

test('source metadata requires exact original columns, types and documented decisions', () => {
  const invalidSources = [
    { ...source(), line: 0 }, { ...source(), line: '42' }, { ...source(), line: 1.1 },
    { ...source(), values: [] }, { ...source(), values: { ...source().values, extra: '' } },
    { ...source(), values: { ...source().values, fee_amount: 0 } },
    { ...source(), values: Object.fromEntries(Object.entries(source().values).slice(1)) },
    { ...source(), decisions: [] }, { ...source(), decisions: { feePolicy: 'estimated' } },
    { ...source(), decisions: { grossValuesConfirmed: 'true' } },
    { ...source(), decisions: { unknown: 'manual' } }, { ...source(), derived: 1 }, { ...source(), unknown: 'x' },
  ];
  for (const invalid of invalidSources) {
    assert.throws(() => parseCsv(csv([setting, row(JSON.stringify({ source: invalid }))])), /Riga 3.*source/);
    assert.throws(() => exportCsv(dataset([transaction('acquisto', { source: invalid })])), /Riga 4.*source/);
  }
});

test('unknown version 2 input properties are rejected rather than lost during export', () => {
  const input = dataset();
  for (const invalid of [
    { ...input, unexpected: 'not saved' },
    { ...input, initialLots: [{ ...input.initialLots[0], unexpected: 'not saved' }] },
    { ...input, transactions: [{ ...input.transactions[0], unexpected: 'not saved' }] },
    { ...input, carryLosses: [{ ...input.carryLosses[0], unexpected: 'not saved' }] },
  ]) assert.throws(() => exportCsv(invalid), /campo non riconosciuto.*unexpected/);
});

test('untrusted source labels, addresses, formulas and multiline content remain quoted JSON strings', () => {
  const metadata = source();
  metadata.values.label = '<img src=x onerror="alert(1)">; "etichetta"\nseconda riga';
  metadata.values.sent_address = '=HYPERLINK("https://example.org")';
  metadata.values.received_address = '@SUM(1;2)';
  metadata.values.received_amount = '0.123456789012345678901234567890';
  const original = dataset([transaction('provento', { source: metadata })]);
  const output = exportCsv(original);
  const data = readCsvRecords(output)[3].fields[12];
  assert.equal(data[0], '{');
  assert.deepEqual(JSON.parse(data).source, metadata);
  assert.deepEqual(parseCsv(output), original);
});

test('version 2 keeps the existing data record and UTF-8 byte limits', () => {
  const input = dataset(Array.from({ length: 4998 }, (_, index) => transaction('acquisto', { id: `tx-${index}` })));
  assert.equal(parseCsv(exportCsv(input)).transactions.length, 4998);
  input.transactions.push(transaction());
  assert.throws(() => exportCsv(input), /limite di 5000 record/);
  const metadata = source();
  metadata.values.label = 'à'.repeat(3 * 1024 * 1024);
  assert.throws(() => exportCsv(dataset([transaction('provento', { source: metadata })])), /limite di 5 MiB/);
  assert.throws(() => parseCsv(csv([setting, row(JSON.stringify({ source: metadata }))])), /limite di 5 MiB/);
});

test('extended reports preserve received amounts, exact totals and source without rounding', () => {
  const reportRow = {
    ...transaction('permuta_neutrale'), totalEur: '100.000000000000000001', receivedAsset: 'ETH',
    receivedQuantity: '0.123456789012345678', lotDatePolicy: 'historical', rewardCostEur: '0',
    receivedBeforeQuantity: '0.000000000000000001', receivedAfterQuantity: '0.123456789012345679',
    fiscalResult: null, source: source(),
  };
  const records = readCsvRecords(exportReportCsv([reportRow]));
  const report = Object.fromEntries(records[0].fields.map((name, index) => [name, records[1].fields[index]]));
  assert.equal(report.operazione, 'permuta_neutrale');
  assert.equal(report.risultato_fiscale_eur, '');
  assert.equal(report.totale_eur, '100.000000000000000001');
  assert.equal(report.quantita_ricevuta, '0.123456789012345678');
  assert.equal(report.quantita_ricevuta_prima, '0.000000000000000001');
  assert.equal(report.quantita_ricevuta_dopo, '0.123456789012345679');
  assert.deepEqual(JSON.parse(report.dati_origine), source());
  const old = readCsvRecords(exportReportCsv([transaction()]));
  assert.equal(old[0].fields.length, 19);
  assert.equal(old[0].fields.includes('totale_eur'), false);
});


test('new-operation inputs reconstruct the same fiscal results and report after CSV recovery', () => {
  const input = {
    version: 2, openingDate: '2026-01-01', carryLosses: [],
    initialLots: [{ id: 'lot-1', asset: 'BTC', acquiredOn: '2025-01-01', order: 1, quantity: '3', unitCost: '20' }],
    transactions: [
      transaction('acquisto', { order: 1, quantity: '3', totalEur: '100', source: source() }),
      transaction('permuta_neutrale', { order: 2, quantity: '3', receivedAsset: 'ETH', receivedQuantity: '1', lotDatePolicy: 'historical' }),
      transaction('permuta_imponibile', { order: 3, asset: 'ETH', quantity: '1', receivedAsset: 'SOL', receivedQuantity: '10', totalEur: '150' }),
      transaction('provento', { order: 4, asset: 'ETH', quantity: '1', totalEur: '12', rewardCostEur: '0' }),
      transaction('deposito_eur', { order: 5, asset: 'EUR', quantity: '100', unitPrice: '1' }),
      transaction('vendita', { order: 6, quantity: '1', totalEur: '40' }),
    ],
  };
  const before = calculate(input, 2026);
  const after = calculate(parseCsv(exportCsv(input)), 2026);
  assert.deepEqual(after, before);
  assert.equal(after.tax.net, '82');
  assert.equal(after.tax.tax, '27.06');
  assert.equal(exportReportCsv(after.rows), exportReportCsv(before.rows));
  assert.equal(readCsvRecords(exportReportCsv(after.rows)).length, 7);
});


test('documented promotional acquisitions retain their explicit source classification without holding income', () => {
  const metadata = source();
  metadata.decisions.rewardTreatment = 'documented_acquisition';
  metadata.decisions.rewardCostPolicy = 'manual';
  const input = dataset([transaction('acquisto', { quantity: '1', totalEur: '42.123456789012345678', source: metadata })]);
  const recovered = parseCsv(exportCsv(input));
  assert.deepEqual(recovered, input);
  const result = calculate(recovered, 2026);
  assert.equal(result.tax.income, '0');
  assert.equal(result.rows[0].fiscalResult, null);
  assert.equal(result.rows[0].costBasis, '42.123456789012345678');
});

test('the consultation report labels fiscal proceeds as gross including when fees are present', () => {
  const input = dataset([transaction('vendita', { quantity: '0.000000000000000001', unitPrice: '60000', fees: '0.01' })]);
  const result = calculate(input, 2026);
  const records = readCsvRecords(exportReportCsv(result.rows));
  const report = Object.fromEntries(records[0].fields.map((name, index) => [name, records[1].fields[index]]));
  assert.equal(report.corrispettivo_lordo_eur, '0.00000000000006');
  assert.equal(report.commissioni_eur, '0.01');
  assert.equal(Object.hasOwn(report, 'ricavo_netto_eur'), false);
});
