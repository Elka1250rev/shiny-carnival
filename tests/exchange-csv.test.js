import test from 'node:test';
import assert from 'node:assert/strict';
import { EXCHANGE_CSV_COLUMNS, parseExchangeCsv } from '../dist/exchange-csv.js';

const sourceRow = overrides => ({
  id: 'synthetic-1', datetime_tz_CET: '2025-08-01-23:15:30', type: 'Buy',
  label: '', market_model_type: 'SPOT', order_type: 'LIMIT',
  sent_amount: '100.00', sent_currency: 'EUR', sent_value_EUR: '100.00', sent_address: '',
  received_amount: '0.02000000', received_currency: 'ALFA', received_value_EUR: '99.50', received_address: '',
  fee_amount: '0.00002000', fee_currency: 'ALFA', fee_value_EUR: '0.09950',
  ...overrides
});
const quoted = value => '"' + value.replaceAll('"', '""') + '"';
const file = (rows, columns = EXCHANGE_CSV_COLUMNS) => '\uFEFF' + [columns, ...rows.map(row => columns.map(name => row[name]))]
  .map(row => row.map(quoted).join(',')).join('\r\n');

test('source quantities, nonmatching euro values and crypto fees remain exact and distinct', () => {
  const input = sourceRow({ received_value_EUR: '99.123456789012345678901234567890' });
  const result = parseExchangeCsv(file([input]));
  assert.deepEqual(result.rows, [{ line: 2, values: input }]);
  assert.equal(result.rows[0].values.sent_amount, '100.00');
  assert.equal(result.rows[0].values.received_amount, '0.02000000');
  assert.equal(result.rows[0].values.fee_currency, 'ALFA');
  assert.equal('transactions' in result, false, 'source records must not be mistaken for a calculated tax dataset');
});

test('all categories survive in source order, including ties and unknown future operation types', () => {
  const types = ['Buy', 'Sell', 'Trade', 'Receive', 'Deposit', 'FutureType'];
  const rows = types.map((type, index) => sourceRow({
    id: 'synthetic-' + (types.length - index), type,
    datetime_tz_CET: index === 0 ? '2025-08-02-00:00:00' : '2025-08-01-23:15:30',
    label: type === 'Receive' ? 'Reward' : '', market_model_type: type === 'Receive' ? 'EARN' : 'SPOT'
  }));
  const result = parseExchangeCsv(file(rows));
  assert.deepEqual(result.rows.map(row => row.values), rows);
  assert.equal(result.summary.rowCount, 6);
  assert.deepEqual(result.summary.types, types.map(type => ({ type, count: 1 })));
  assert.equal(result.summary.firstTimestamp, '2025-08-01-23:15:30');
  assert.equal(result.summary.lastTimestamp, '2025-08-02-00:00:00');
});

test('reordered headers and quoted delimiters preserve every named source field', () => {
  const row = sourceRow({ label: 'Note, "due"; parti' });
  assert.deepEqual(parseExchangeCsv(file([row], [...EXCHANGE_CSV_COLUMNS].reverse())).rows[0].values, row);
});

test('missing, duplicate and unknown columns or short rows cannot silently shift amounts', () => {
  const row = sourceRow();
  assert.throws(() => parseExchangeCsv(file([row], EXCHANGE_CSV_COLUMNS.slice(1))), /colonne mancanti.*id/);
  assert.throws(() => parseExchangeCsv(file([row], [...EXCHANGE_CSV_COLUMNS, 'id'])), /colonna duplicata/);
  assert.throws(() => parseExchangeCsv(file([{ ...row, extra: '' }], [...EXCHANGE_CSV_COLUMNS, 'extra'])), /non riconosciuta/);
  assert.throws(() => parseExchangeCsv(file([row]).replace(/,"0\.09950"$/, '')), /Riga 2.*numero di colonne/);
});

test('invalid timestamps, malformed decimals and duplicate source ids identify the source row', () => {
  for (const timestamp of ['2025-02-29-00:00:00', '2025-01-01-24:00:00', '2025-01-01-23:60:00', '2025-01-01T00:00:00Z']) {
    assert.throws(() => parseExchangeCsv(file([sourceRow({ datetime_tz_CET: timestamp })])), /Riga 2.*data e ora valide/);
  }
  assert.equal(parseExchangeCsv(file([sourceRow({ datetime_tz_CET: '2024-02-29-23:59:59' })])).rows.length, 1);
  for (const amount of ['1e-8', '1,234', '-1', '', ' 1']) {
    assert.throws(() => parseExchangeCsv(file([sourceRow({ fee_amount: amount })])), /Riga 2.*fee_amount/);
  }
  assert.throws(() => parseExchangeCsv(file([sourceRow(), sourceRow()])), /Riga 3.*id duplicato/);
});

test('quoted source newlines keep accurate physical line numbers for subsequent errors', () => {
  const text = file([sourceRow({ label: 'prima\nseconda' }), sourceRow({ id: 'synthetic-2', sent_amount: 'bad' })]);
  assert.throws(() => parseExchangeCsv(text), /Riga 4.*sent_amount/);
});
