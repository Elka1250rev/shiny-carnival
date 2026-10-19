import { readCsvRecords } from './csv-reader.js';

export const EXCHANGE_CSV_COLUMNS = Object.freeze([
  'id', 'datetime_tz_CET', 'type', 'label', 'market_model_type', 'order_type',
  'sent_amount', 'sent_currency', 'sent_value_EUR', 'sent_address',
  'received_amount', 'received_currency', 'received_value_EUR', 'received_address',
  'fee_amount', 'fee_currency', 'fee_value_EUR'
]);

const AMOUNTS = Object.freeze([
  'sent_amount', 'sent_value_EUR', 'received_amount', 'received_value_EUR',
  'fee_amount', 'fee_value_EUR'
]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const UNSAFE_ID = /^[\s\uFEFF]*[=+\-@]/u;
const failure = (line, message) => new Error(`Riga ${line}: ${message}`);

function validTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59;
}

/**
 * Read source records without interpreting fees, exchange valuations or taxes.
 * This is deliberately separate from the importers that produce a tax dataset.
 */
export function parseExchangeCsv(text) {
  const records = readCsvRecords(text, { delimiter: ',', maxRecords: 5001 });
  if (!records.length) throw failure(1, 'il file CSV è vuoto.');
  const header = records[0];
  const seen = new Set();
  for (const name of header.fields) {
    if (seen.has(name)) throw failure(header.line, `colonna duplicata: ${name || '(vuota)'}.`);
    seen.add(name);
    if (!EXCHANGE_CSV_COLUMNS.includes(name)) throw failure(header.line, `colonna non riconosciuta: ${name || '(vuota)'}.`);
  }
  const missing = EXCHANGE_CSV_COLUMNS.filter(name => !seen.has(name));
  if (missing.length) throw failure(header.line, `colonne mancanti: ${missing.join(', ')}.`);
  if (records.length === 1) throw failure(header.line, 'il file non contiene operazioni.');

  const ids = new Set();
  const counts = new Map();
  let firstTimestamp = null;
  let lastTimestamp = null;
  const rows = records.slice(1).map(record => {
    if (record.fields.length !== header.fields.length) {
      throw failure(record.line, `numero di colonne errato: attese ${header.fields.length}, trovate ${record.fields.length}.`);
    }
    const values = Object.fromEntries(header.fields.map((name, index) => [name, record.fields[index]]));
    if (!values.id.trim() || values.id.length > 64 || CONTROL.test(values.id) || UNSAFE_ID.test(values.id)) {
      throw failure(record.line, 'id obbligatorio, fino a 64 caratteri, senza caratteri di controllo o prefissi =, +, - o @.');
    }
    if (ids.has(values.id)) throw failure(record.line, 'id duplicato nel file.');
    ids.add(values.id);
    if (!validTimestamp(values.datetime_tz_CET)) {
      throw failure(record.line, 'datetime_tz_CET deve contenere una data e ora valide nel formato AAAA-MM-GG-HH:mm:ss.');
    }
    if (!values.type.trim() || values.type.length > 64 || CONTROL.test(values.type)) {
      throw failure(record.line, 'type deve contenere un tipo di operazione non vuoto, fino a 64 caratteri e senza caratteri di controllo.');
    }
    for (const name of AMOUNTS) {
      if (!/^\d+(?:\.\d+)?$/.test(values[name])) {
        throw failure(record.line, `${name} deve essere un numero non negativo con punto decimale, senza separatori delle migliaia.`);
      }
    }
    // Original order, timestamps, decimal spelling and metadata remain intact.
    // No time-zone conversion or unit-price calculation is performed here.
    counts.set(values.type, (counts.get(values.type) || 0) + 1);
    if (firstTimestamp === null || values.datetime_tz_CET < firstTimestamp) firstTimestamp = values.datetime_tz_CET;
    if (lastTimestamp === null || values.datetime_tz_CET > lastTimestamp) lastTimestamp = values.datetime_tz_CET;
    return { line: record.line, values };
  });
  return {
    kind: 'exchange-csv', columns: [...header.fields], rows,
    summary: {
      rowCount: rows.length, firstTimestamp, lastTimestamp,
      types: [...counts].map(([type, count]) => ({ type, count }))
    }
  };
}
