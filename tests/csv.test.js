import test from 'node:test';
import assert from 'node:assert/strict';
import { CSV_COLUMNS, exportCsv, parseCsv, exportReportCsv, importers, parseImport } from '../dist/csv.js';

function dataset() {
  return {
    version: 1,
    openingDate: '2026-01-01',
    initialLots: [{ id: 'lotto-1', asset: 'BTC', acquiredOn: '2025-03-01', order: 1, quantity: '0.20000000', unitCost: '40000.00' }],
    transactions: [
      { id: 'acquisto-1', date: '2026-01-10', order: 1, type: 'acquisto', asset: 'BTC', quantity: '0.10000000', unitPrice: '50000.00', fees: '10.00' },
      { id: 'vendita-1', date: '2026-02-10', order: 2, type: 'vendita', asset: 'BTC', quantity: '0.05000000', unitPrice: '60000.00', fees: '5.00' },
    ],
    carryLosses: [{ id: 'minusvalenza-1', year: 2025, amount: '1234.5600' }],
  };
}

function csv(rows, columns = CSV_COLUMNS) {
  const quote = value => `"${String(value).replaceAll('"', '""')}"`;
  return [columns, ...rows].map(row => row.map(quote).join(';')).join('\r\n');
}

const configuration = ['1', 'configurazione', '', '2026-01-01', '', '', '', '', '', '', '', ''];
const transaction = ['1', 'acquisto', 'tx-1', '2026-01-10', '1', 'BTC', '0.1', '50000', '10', '', '', ''];

test('all inputs, opening lots, fees and historical losses survive a full round trip', () => {
  const original = dataset();
  const exported = exportCsv(original);
  assert.equal(exported.charCodeAt(0), 0xFEFF);
  assert.ok(exported.endsWith('\r\n'));
  assert.equal(exported.includes('\n') && /(?<!\r)\n/.test(exported), false);
  assert.deepEqual(parseCsv(exported), original);
  assert.deepEqual(parseCsv(exportCsv(parseCsv(exported))), original);
});

test('quoted delimiters, quotes, apostrophes and Unicode names are preserved', () => {
  const original = dataset();
  original.initialLots[0].asset = 'Nespole; "d’autunno"';
  original.transactions[0].asset = "L'olio d’oliva";
  original.transactions[0].id = 'ordine; "uno"';
  original.transactions[1].asset = '石油';
  const output = exportCsv(original);
  assert.ok(output.includes('"Nespole; ""d’autunno"""'));
  assert.deepEqual(parseCsv(output), original);
});

test('unquoted input, BOM, blank physical lines and Windows newlines are accepted', () => {
  const input = `\uFEFF\r\n${CSV_COLUMNS.join(';')}\r\n\r\n${configuration.join(';')}\r\n${transaction.join(';')}\r\n`;
  const parsed = parseCsv(input);
  assert.equal(parsed.openingDate, '2026-01-01');
  assert.equal(parsed.transactions[0].quantity, '0.1');
});

test('columns can be reordered when every canonical name is present once', () => {
  const reversed = [...CSV_COLUMNS].reverse();
  const parsed = parseCsv(csv([[...configuration].reverse(), [...transaction].reverse()], reversed));
  assert.equal(parsed.transactions[0].asset, 'BTC');
  assert.equal(parsed.transactions[0].fees, '10');
});

test('Italian decimal comma is normalized without losing decimal precision', () => {
  const row = [...transaction];
  row[6] = '0,000000000000000001';
  row[7] = '50000,1200';
  row[8] = '10,00';
  const parsed = parseCsv(csv([configuration, row]));
  assert.equal(parsed.transactions[0].quantity, '0.000000000000000001');
  assert.equal(parsed.transactions[0].unitPrice, '50000.1200');
  assert.equal(parsed.transactions[0].fees, '10.00');
  assert.deepEqual(parseCsv(exportCsv(parsed)), parsed);
});

test('scientific notation is expanded for JavaScript numeric callers only', () => {
  const original = dataset();
  original.transactions[0].quantity = 1e-8;
  assert.equal(parseCsv(exportCsv(original)).transactions[0].quantity, '0.00000001');
  original.transactions[0].quantity = '1e-8';
  assert.throws(() => exportCsv(original), /Riga 4.*quantita/);
});

test('malformed quote syntax and wrong row lengths identify the physical line', () => {
  const header = CSV_COLUMNS.join(';');
  assert.throws(() => parseCsv(`${header}\n"1"x;configurazione`), /Riga 2.*dopo la chiusura/);
  assert.throws(() => parseCsv(`${header}\n1;configur"azione`), /Riga 2.*virgolette inattese/);
  assert.throws(() => parseCsv(`${header}\n"1;configurazione`), /Riga 2.*non chiuse/);
  assert.throws(() => parseCsv(`${header}\n${configuration.join(';')}\n1;acquisto`), /Riga 3.*numero di colonne/);
});

test('the schema rejects missing, duplicate and unknown column names', () => {
  assert.throws(() => parseCsv(csv([], CSV_COLUMNS.slice(0, -1))), /Riga 1.*colonne mancanti.*importo_eur/);
  assert.throws(() => parseCsv(csv([], [...CSV_COLUMNS, 'tipo'])), /Riga 1.*colonna duplicata.*tipo/);
  const changed = [...CSV_COLUMNS];
  changed[0] = 'version';
  assert.throws(() => parseCsv(csv([], changed)), /Riga 1.*colonna non riconosciuta.*version/);
});

test('empty files, missing settings, duplicate settings and unsupported versions fail', () => {
  for (const input of ['', '\uFEFF', '\r\n\n']) assert.throws(() => parseCsv(input), /Riga 1.*vuoto/);
  assert.throws(() => parseCsv(csv([transaction])), /manca la riga configurazione/);
  assert.throws(() => parseCsv(csv([configuration, configuration])), /Riga 3.*una sola riga configurazione/);
  const nextVersion = [...transaction];
  nextVersion[0] = '2';
  assert.throws(() => parseCsv(csv([configuration, nextVersion])), /Riga 3.*versione CSV non supportata.*2/);
  assert.throws(() => exportCsv({ ...dataset(), version: 3 }), /versione del dataset non supportata/);
});

test('unknown operation types and nonempty reserved fields are rejected', () => {
  const unknown = [...transaction];
  unknown[1] = 'staking';
  assert.throws(() => parseCsv(csv([configuration, unknown])), /Riga 3.*tipo di record non riconosciuto.*staking/);
  const reserved = [...transaction];
  reserved[9] = '2025-01-01';
  assert.throws(() => parseCsv(csv([configuration, reserved])), /Riga 3.*data_acquisto_originale.*deve essere vuoto/);
  const invalidSetting = [...configuration];
  invalidSetting[2] = 'unexpected';
  assert.throws(() => parseCsv(csv([invalidSetting])), /Riga 2.*id.*deve essere vuoto/);
  const invalidCarry = ['1', 'minusvalenza_pregressa', 'loss-1', '', '', 'BTC', '', '', '', '', '2025', '100'];
  assert.throws(() => parseCsv(csv([configuration, invalidCarry])), /Riga 3.*cripto.*deve essere vuoto/);
});

test('invalid number spellings are rejected instead of silently coerced', () => {
  for (const spelling of ['1.000,50', '1,000.50', '1e3', ' 2', '2 ', 'Infinity', 'NaN', '-1', '+1', '1,2,3', '.', '']) {
    const row = [...transaction];
    row[6] = spelling;
    assert.throws(() => parseCsv(csv([configuration, row])), /Riga 3.*quantita.*numero decimale/, spelling);
  }
  const row = [...transaction];
  row[4] = '1.5';
  assert.throws(() => parseCsv(csv([configuration, row])), /Riga 3.*ordine.*numero intero/);
  row[4] = '9007199254740992';
  assert.throws(() => parseCsv(csv([configuration, row])), /Riga 3.*ordine.*troppo grande/);
});

test('dates must exist and initial lot dates must match the opening setting', () => {
  for (const date of ['10/01/2026', '2026-02-29', '2026-13-01', '2026-00-01', '0000-01-01']) {
    const row = [...transaction];
    row[3] = date;
    assert.throws(() => parseCsv(csv([configuration, row])), /Riga 3.*data/);
  }
  const row = [...transaction];
  row[3] = '2024-02-29';
  assert.equal(parseCsv(csv([configuration, row])).transactions[0].date, '2024-02-29');
  const initial = ['1', 'iniziale', 'lot-1', '2025-01-01', '1', 'BTC', '0.2', '40000', '', '2024-01-01', '', ''];
  assert.throws(() => parseCsv(csv([configuration, initial])), /Riga 3.*coincidere con la data/);
});

test('formula prefixes, control characters and oversized IDs or asset names are refused', () => {
  for (const value of ['=SUM(A1:A2)', '+BTC', '-BTC', '@BTC', '  =1', '\t+1', '\uFEFF@BTC', 'BTC\nETH', 'BTC\rETH', 'a'.repeat(65)]) {
    const row = [...transaction];
    row[5] = value;
    assert.throws(() => parseCsv(csv([configuration, row])), /Riga 3.*cripto/, JSON.stringify(value));
    const original = dataset();
    original.transactions[0].asset = value;
    assert.throws(() => exportCsv(original), /cripto/);
  }
  const row = [...transaction];
  row[2] = '=HYPERLINK("https://example.org")';
  assert.throws(() => parseCsv(csv([configuration, row])), /Riga 3.*id/);
  const original = dataset();
  original.initialLots[0].id = '@lot';
  assert.throws(() => exportCsv(original), /id/);
});

test('the record limit allows 5000 data records plus the configuration', () => {
  const rows = Array.from({ length: 5000 }, (_, index) => {
    const row = [...transaction];
    row[2] = `tx-${index}`;
    return row;
  });
  assert.equal(parseCsv(csv([configuration, ...rows])).transactions.length, 5000);
  assert.throws(() => parseCsv(csv([configuration, ...rows, transaction])), /limite di 5000 record/);
  const original = dataset();
  original.transactions = Array.from({ length: 4998 }, () => ({ ...original.transactions[0] }));
  assert.equal(parseCsv(exportCsv(original)).transactions.length, 4998);
  original.transactions.push({ ...original.transactions[0] });
  assert.throws(() => exportCsv(original), /limite di 5000 record/);
});

test('input decimal fields allow at most 30 integer digits and 18 fractional digits', () => {
  const row = [...transaction];
  row[6] = '9'.repeat(30) + '.' + '1'.repeat(18);
  assert.equal(parseCsv(csv([configuration, row])).transactions[0].quantity, row[6]);
  for (const number of ['9'.repeat(31), '0.' + '1'.repeat(19)]) {
    row[6] = number;
    assert.throws(() => parseCsv(csv([configuration, row])), /Riga 3.*massimo 30 cifre intere e 18 decimali/);
    const original = dataset();
    original.transactions[0].quantity = number;
    assert.throws(() => exportCsv(original), /massimo 30 cifre intere e 18 decimali/);
  }
});

test('the byte limit is measured in UTF-8 bytes', () => {
  assert.throws(() => parseCsv('à'.repeat(3 * 1024 * 1024)), /limite di 5 MiB/);
});

test('the report includes flat before/after state and signed gains without losing precision', () => {
  const report = exportReportCsv([{
    id: 'sale-1', date: '2026-02-10', order: 1, type: 'vendita', asset: 'BTC',
    quantity: '0.05', unitPrice: '60000', fees: '5', beforeQuantity: '0.3', beforeAverage: '43366.666666666666666666',
    afterQuantity: '0.25', afterAverage: '43366.666666666666666666',
    fiscalBeforeAverage: '43366.666666666666666666', fiscalAfterAverage: '42020',
    proceeds: '2995', costBasis: '3000', fiscalResult: '-5.0000', managementResult: '826.666666666666666666',
    lotDetails: [{ lotId: 'lot-1', quantity: '0.05' }],
  }]);
  assert.equal(report.charCodeAt(0), 0xFEFF);
  assert.ok(report.includes('"quantita_prima";"prezzo_medio_prima_eur";"quantita_dopo"'));
  assert.ok(report.includes('"-5.0000"'));
  assert.ok(report.includes('"43366.666666666666666666"'));
  assert.ok(report.includes('"[{""lotId"":""lot-1"",""quantity"":""0.05""}]"'));
  assert.throws(() => parseCsv(report), /colonna non riconosciuta/);
});

test('the importer registry uses the common dataset and declines Excel explicitly', () => {
  assert.equal(importers.length, 1);
  assert.equal(importers[0].id, 'csv');
  assert.deepEqual(importers[0].extensions, ['csv']);
  assert.deepEqual(parseImport(exportCsv(dataset()), 'operazioni.CSV'), dataset());
  assert.throws(() => parseImport('anything', 'operazioni.xlsx'), /Excel non è ancora supportato/);
  assert.throws(() => parseImport('anything', 'operazioni.xls'), /Excel non è ancora supportato/);
  assert.throws(() => parseImport('anything', 'operazioni.json'), /Formato di importazione non supportato/);
});

test('a sale report keeps negative management results separate from gross fiscal proceeds', () => {
  const output = exportReportCsv([{
    id: 'sale-1', date: '2026-02-10', order: 1, type: 'vendita', asset: 'BTC',
    quantity: '0.01', unitPrice: '1', fees: '2', proceeds: '0.01', costBasis: '1', fiscalResult: '-0.99', managementResult: '-2.99',
  }]);
  assert.ok(output.includes('"0.01"'));
  assert.ok(output.includes('"-0.99"'));
  assert.ok(output.includes('"-2.99"'));
});
