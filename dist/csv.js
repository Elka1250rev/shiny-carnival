import { readCsvRecords } from './csv-reader.js';
import { EXCHANGE_CSV_COLUMNS } from './exchange-csv.js';

/**
 * Local, versioned interchange format. Every importer produces this same model;
 * fiscal and portfolio validation belongs to the calculation engine.
 */
export const CSV_COLUMNS = Object.freeze([
  'versione', 'tipo', 'id', 'data', 'ordine', 'cripto', 'quantita',
  'prezzo_unitario_eur', 'commissioni_eur', 'data_acquisto_originale',
  'anno_minusvalenza', 'importo_eur',
]);

export const CSV_COLUMNS_V2 = Object.freeze([...CSV_COLUMNS, 'dati_estesi']);

const TRANSACTION_TYPES = Object.freeze([
  'acquisto', 'vendita', 'permuta_neutrale', 'permuta_imponibile', 'provento', 'deposito_eur',
]);
const EXTENDED_FIELDS = Object.freeze([
  'totalEur', 'receivedAsset', 'receivedQuantity', 'lotDatePolicy', 'rewardCostEur', 'source',
]);
const BASE_TRANSACTION_FIELDS = Object.freeze([
  'id', 'date', 'order', 'type', 'asset', 'quantity', 'unitPrice', 'fees',
]);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 5000;
const DECIMAL = /^\d{1,30}(?:[.,]\d{1,18})?$/;
const UNBOUNDED_DECIMAL = /^\d+(?:[.,]\d+)?$/;
const SIGNED_DECIMAL = /^-?\d+(?:[.,]\d+)?$/;
const INTEGER = /^\d+$/;
const UNSAFE_TEXT = /^[\s\uFEFF]*[=+\-@]/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function error(line, message) {
  return new Error(`Riga ${line}: ${message}`);
}

function textField(value, name, line) {
  if (typeof value !== 'string' || !value.trim()) {
    throw error(line, `il campo ${name} è obbligatorio.`);
  }
  if (value.length > 64 || CONTROL_CHARACTERS.test(value)) {
    throw error(line, `il campo ${name} deve contenere al massimo 64 caratteri, senza caratteri di controllo.`);
  }
  if (UNSAFE_TEXT.test(value)) {
    throw error(line, `il campo ${name} non può iniziare con =, +, - o @.`);
  }
  return value;
}

function dateField(value, name, line) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw error(line, `il campo ${name} deve essere una data AAAA-MM-GG.`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw error(line, `il campo ${name} contiene una data non valida.`);
  }
  return value;
}

// Numeric JavaScript values are supported for callers, while textual scientific
// notation is deliberately rejected in imported files.
function numberText(value) {
  if (typeof value !== 'number') return value;
  if (!Number.isFinite(value)) return '';
  const raw = String(value);
  if (!/[eE]/.test(raw)) return raw;
  const [mantissa, exponentText] = raw.toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = whole + fraction;
  const point = whole.length + Number(exponentText);
  const expanded = point <= 0
    ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length
      ? `${digits}${'0'.repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${negative ? '-' : ''}${expanded}`;
}

function decimalField(value, name, line, signed = false, bounded = true) {
  const raw = numberText(value);
  const pattern = signed ? SIGNED_DECIMAL : bounded ? DECIMAL : UNBOUNDED_DECIMAL;
  if (typeof raw !== 'string' || !pattern.test(raw)) {
    throw error(line, `il campo ${name} deve essere un numero decimale ${signed ? '' : 'non negativo '}senza separatori delle migliaia${bounded ? ', con massimo 30 cifre intere e 18 decimali' : ''}.`);
  }
  return raw.replace(',', '.');
}

function integerField(value, name, line, year = false) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !INTEGER.test(raw) || (year && raw.length !== 4)) {
    throw error(line, `il campo ${name} deve essere ${year ? 'un anno di quattro cifre' : 'un numero intero non negativo'}.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw error(line, `il campo ${name} è troppo grande.`);
  return parsed;
}

function rejectUnused(row, allowed, line) {
  for (const name of Object.keys(row)) {
    if (!allowed.includes(name) && row[name] !== '') {
      throw error(line, `il campo ${name} deve essere vuoto per il tipo ${row.tipo}.`);
    }
  }
}

function objectFields(value, allowed, name, line) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw error(line, `il campo ${name} deve essere un oggetto.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw error(line, `campo non riconosciuto in ${name}: ${key}.`);
  }
  return value;
}

function exactDecimal(value, name, line) {
  if (typeof value !== 'string') throw error(line, `il campo ${name} deve essere una stringa decimale esatta.`);
  return decimalField(value, name, line);
}

// Exact source schema is archived as data; these strings are never HTML.
const SOURCE_DECISIONS = Object.freeze({
  swapTaxTreatment: ['neutral', 'taxable', 'not_applicable'],
  rewardTreatment: ['holding_income', 'documented_acquisition', 'not_applicable'],
  rewardCostPolicy: ['zero_confirmed', 'received_value_confirmed', 'manual', 'not_applicable'],
  amountsPolicy: ['as_reported_confirmed', 'manual'],
  feePolicy: ['already_included', 'separate_taxable_disposal', 'not_applicable'],
  lotDatePolicy: ['historical', 'exchange', 'not_applicable'],
  grossValuesConfirmed: null,
});

function sourceField(value, line) {
  objectFields(value, ['line', 'values', 'decisions', 'derived'], 'source', line);
  if (!Number.isSafeInteger(value.line) || value.line < 1) {
    throw error(line, 'il campo source.line deve essere un numero intero positivo.');
  }
  objectFields(value.values, EXCHANGE_CSV_COLUMNS, 'source.values', line);
  if (EXCHANGE_CSV_COLUMNS.some(name => !Object.hasOwn(value.values, name) || typeof value.values[name] !== 'string')) {
    throw error(line, 'il campo source.values deve contenere le 17 colonne originali come stringhe.');
  }
  const result = { line: value.line, values: Object.fromEntries(EXCHANGE_CSV_COLUMNS.map(name => [name, value.values[name]])) };
  if (Object.hasOwn(value, 'decisions')) {
    objectFields(value.decisions, Object.keys(SOURCE_DECISIONS), 'source.decisions', line);
    const decisions = {};
    for (const [name, decision] of Object.entries(value.decisions)) {
      const allowed = SOURCE_DECISIONS[name];
      if (allowed === null ? typeof decision !== 'boolean' : !allowed.includes(decision)) {
        throw error(line, `il campo source.decisions.${name} contiene un valore non supportato.`);
      }
      decisions[name] = decision;
    }
    result.decisions = decisions;
  }
  if (Object.hasOwn(value, 'derived')) {
    if (typeof value.derived !== 'boolean') throw error(line, 'il campo source.derived deve essere booleano.');
    result.derived = value.derived;
  }
  return result;
}

function extendedFields(value, line) {
  objectFields(value, EXTENDED_FIELDS, 'dati_estesi', line);
  const result = {};
  for (const name of ['totalEur', 'receivedQuantity', 'rewardCostEur']) {
    if (Object.hasOwn(value, name)) result[name] = exactDecimal(value[name], name, line);
  }
  if (Object.hasOwn(value, 'receivedAsset')) result.receivedAsset = textField(value.receivedAsset, 'receivedAsset', line);
  if (Object.hasOwn(value, 'lotDatePolicy')) {
    if (!['historical', 'exchange'].includes(value.lotDatePolicy)) {
      throw error(line, 'il campo lotDatePolicy deve essere historical o exchange.');
    }
    result.lotDatePolicy = value.lotDatePolicy;
  }
  if (Object.hasOwn(value, 'source')) result.source = sourceField(value.source, line);
  return result;
}

function parseExtended(raw, line, validator = extendedFields) {
  if (raw === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw, (key, value) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('chiave riservata');
      return value;
    });
  } catch {
    throw error(line, 'il campo dati_estesi deve contenere JSON valido, senza chiavi riservate.');
  }
  return validator(parsed, line);
}

function initialExtended(value, line) {
  objectFields(value, ['basisMethod'], 'dati_estesi del lotto iniziale', line);
  if (Object.hasOwn(value, 'basisMethod') && value.basisMethod !== 'estimated_average') throw error(line, 'basisMethod del lotto iniziale deve essere estimated_average.');
  return Object.hasOwn(value, 'basisMethod') ? { basisMethod: value.basisMethod } : {};
}

/** Parse the canonical format. Numeric amounts remain exact decimal strings. */
export function parseCsv(text) {
  const records = readCsvRecords(text, { maxRecords: 5002 });
  if (!records.length) throw error(1, 'il file CSV è vuoto.');
  const header = records[0];
  const seen = new Set();
  for (const column of header.fields) {
    if (seen.has(column)) throw error(header.line, `colonna duplicata: ${column || '(vuota)'}.`);
    seen.add(column);
    if (!CSV_COLUMNS_V2.includes(column)) throw error(header.line, `colonna non riconosciuta: ${column || '(vuota)'}.`);
  }
  const version = seen.has('dati_estesi') ? 2 : 1;
  const columns = version === 2 ? CSV_COLUMNS_V2 : CSV_COLUMNS;
  const missing = columns.filter(column => !seen.has(column));
  if (missing.length) throw error(header.line, `colonne mancanti: ${missing.join(', ')}.`);

  const dataset = { version, openingDate: '', initialLots: [], transactions: [], carryLosses: [] };
  let configurationFound = false;
  const initialDates = [];
  for (const record of records.slice(1)) {
    const { fields, line } = record;
    if (fields.length !== header.fields.length) {
      throw error(line, `numero di colonne errato: attese ${header.fields.length}, trovate ${fields.length}.`);
    }
    const row = Object.fromEntries(header.fields.map((column, index) => [column, fields[index]]));
    if (row.versione !== String(version)) throw error(line, `versione CSV non supportata: ${row.versione || '(vuota)'}.`);
    const common = ['versione', 'tipo'];
    if (row.tipo === 'configurazione') {
      rejectUnused(row, [...common, 'data'], line);
      if (configurationFound) throw error(line, 'è ammessa una sola riga configurazione.');
      configurationFound = true;
      dataset.openingDate = dateField(row.data, 'data', line);
    } else if (row.tipo === 'iniziale') {
      rejectUnused(row, [...common, 'id', 'data', 'ordine', 'cripto', 'quantita', 'prezzo_unitario_eur', 'data_acquisto_originale', ...(version === 2 ? ['dati_estesi'] : [])], line);
      initialDates.push({ date: dateField(row.data, 'data', line), line });
      const extra = version === 2 ? parseExtended(row.dati_estesi, line, initialExtended) : {};
      if (extra.basisMethod && row.data_acquisto_originale !== '') throw error(line, 'il saldo aggregato stimato deve avere data_acquisto_originale vuota.');
      dataset.initialLots.push({
        id: textField(row.id, 'id', line),
        asset: textField(row.cripto, 'cripto', line),
        acquiredOn: extra.basisMethod ? '' : dateField(row.data_acquisto_originale, 'data_acquisto_originale', line),
        order: integerField(row.ordine, 'ordine', line),
        quantity: decimalField(row.quantita, 'quantita', line),
        unitCost: decimalField(row.prezzo_unitario_eur, 'prezzo_unitario_eur', line),
        ...extra,
      });
    } else if ((version === 2 ? TRANSACTION_TYPES : ['acquisto', 'vendita']).includes(row.tipo)) {
      rejectUnused(row, [...common, 'id', 'data', 'ordine', 'cripto', 'quantita', 'prezzo_unitario_eur', 'commissioni_eur', ...(version === 2 ? ['dati_estesi'] : [])], line);
      dataset.transactions.push({
        id: textField(row.id, 'id', line),
        date: dateField(row.data, 'data', line),
        order: integerField(row.ordine, 'ordine', line),
        type: row.tipo,
        asset: textField(row.cripto, 'cripto', line),
        quantity: decimalField(row.quantita, 'quantita', line),
        unitPrice: decimalField(row.prezzo_unitario_eur, 'prezzo_unitario_eur', line),
        fees: decimalField(row.commissioni_eur, 'commissioni_eur', line),
        ...(version === 2 ? parseExtended(row.dati_estesi, line) : {}),
      });
    } else if (row.tipo === 'minusvalenza_pregressa') {
      rejectUnused(row, [...common, 'id', 'anno_minusvalenza', 'importo_eur'], line);
      dataset.carryLosses.push({
        id: textField(row.id, 'id', line),
        year: integerField(row.anno_minusvalenza, 'anno_minusvalenza', line, true),
        amount: decimalField(row.importo_eur, 'importo_eur', line),
      });
    } else throw error(line, `tipo di record non riconosciuto: ${row.tipo || '(vuoto)'}.`);
  }
  if (!configurationFound) throw error(1, 'manca la riga configurazione con la data della situazione iniziale.');
  for (const initial of initialDates) {
    if (initial.date !== dataset.openingDate) {
      throw error(initial.line, 'la data del lotto iniziale deve coincidere con la data della configurazione.');
    }
  }
  return dataset;
}

function quoted(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function writeCsv(columns, rows) {
  const lines = [columns, ...rows].map(row => row.map(quoted).join(';'));
  const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
  if (new TextEncoder().encode(csv).byteLength > MAX_BYTES) throw error(1, 'il file supera il limite di 5 MiB.');
  return csv;
}

/** Export inputs, opening settings and historical losses in a reloadable file. */
export function exportCsv(dataset) {
  if (!dataset || ![1, 2].includes(dataset.version)) throw error(1, 'versione del dataset non supportata.');
  const version = dataset.version;
  if (version === 2) objectFields(dataset, ['version', 'openingDate', 'initialLots', 'transactions', 'carryLosses'], 'dataset', 1);
  for (const name of ['initialLots', 'transactions', 'carryLosses']) {
    if (!Array.isArray(dataset[name])) throw error(1, `il campo ${name} deve essere un elenco.`);
  }
  const count = dataset.initialLots.length + dataset.transactions.length + dataset.carryLosses.length;
  if (count > MAX_RECORDS) throw error(1, 'il file supera il limite di 5000 record di dati.');
  const openingDate = dateField(dataset.openingDate, 'data', 2);
  const rows = [[version, 'configurazione', '', openingDate, '', '', '', '', '', '', '', '', ...(version === 2 ? [''] : [])]];
  for (const lot of dataset.initialLots) {
    const line = rows.length + 2;
    if (version === 2) objectFields(lot, ['id', 'asset', 'acquiredOn', 'order', 'quantity', 'unitCost', 'basisMethod'], 'lotto iniziale', line);
    if (version !== 2 && Object.hasOwn(lot, 'basisMethod')) throw error(line, 'i costi medi stimati richiedono il formato 2.');
    const extra = initialExtended(Object.hasOwn(lot, 'basisMethod') ? { basisMethod: lot.basisMethod } : {}, line);
    if (extra.basisMethod && lot.acquiredOn !== '') throw error(line, 'il saldo aggregato stimato deve avere data originaria vuota.');
    rows.push([version, 'iniziale', textField(lot.id, 'id', line), openingDate,
      integerField(lot.order, 'ordine', line), textField(lot.asset, 'cripto', line),
      decimalField(lot.quantity, 'quantita', line), decimalField(lot.unitCost, 'prezzo_unitario_eur', line), '',
      extra.basisMethod ? '' : dateField(lot.acquiredOn, 'data_acquisto_originale', line), '', '', ...(version === 2 ? [extra.basisMethod ? JSON.stringify(extra) : ''] : [])]);
  }
  for (const transaction of dataset.transactions) {
    const line = rows.length + 2;
    if (!(version === 2 ? TRANSACTION_TYPES : ['acquisto', 'vendita']).includes(transaction.type)) {
      throw error(line, `il tipo di transazione non è supportato nella versione ${version}.`);
    }
    let extra;
    if (version === 2) {
      objectFields(transaction, [...BASE_TRANSACTION_FIELDS, ...EXTENDED_FIELDS], 'transazione', line);
      extra = extendedFields(Object.fromEntries(EXTENDED_FIELDS.filter(name => Object.hasOwn(transaction, name)).map(name => [name, transaction[name]])), line);
    } else if (EXTENDED_FIELDS.some(name => Object.hasOwn(transaction, name))) {
      throw error(line, 'i dati estesi richiedono la versione 2 del dataset.');
    }
    rows.push([version, transaction.type, textField(transaction.id, 'id', line), dateField(transaction.date, 'data', line),
      integerField(transaction.order, 'ordine', line), textField(transaction.asset, 'cripto', line),
      decimalField(transaction.quantity, 'quantita', line), decimalField(transaction.unitPrice, 'prezzo_unitario_eur', line),
      decimalField(transaction.fees, 'commissioni_eur', line), '', '', '', ...(version === 2 ? [Object.keys(extra).length ? JSON.stringify(extra) : ''] : [])]);
  }
  for (const loss of dataset.carryLosses) {
    const line = rows.length + 2;
    if (version === 2) objectFields(loss, ['id', 'year', 'amount'], 'minusvalenza pregressa', line);
    rows.push([version, 'minusvalenza_pregressa', textField(loss.id, 'id', line), '', '', '', '', '', '', '',
      integerField(loss.year, 'anno_minusvalenza', line, true), decimalField(loss.amount, 'importo_eur', line), ...(version === 2 ? [''] : [])]);
  }
  return writeCsv(version === 2 ? CSV_COLUMNS_V2 : CSV_COLUMNS, rows);
}

const REPORT_COLUMNS = [
  'id', 'data', 'ordine', 'operazione', 'cripto', 'quantita', 'prezzo_unitario_eur', 'commissioni_eur',
  'quantita_prima', 'prezzo_medio_prima_eur', 'quantita_dopo', 'prezzo_medio_dopo_eur',
  'prezzo_medio_fiscale_prima_eur', 'prezzo_medio_fiscale_dopo_eur', 'corrispettivo_lordo_eur',
  'costo_fiscale_eur', 'risultato_fiscale_eur', 'risultato_gestionale_eur', 'dettaglio_lotti',
];
const EXTENDED_REPORT_COLUMNS = [
  'totale_eur', 'cripto_ricevuta', 'quantita_ricevuta', 'politica_data_lotti', 'costo_provento_eur', 'dati_origine',
  'quantita_ricevuta_prima', 'quantita_ricevuta_dopo',
];
const REPORT_AMOUNTS = [
  'quantity', 'unitPrice', 'fees', 'beforeQuantity', 'beforeAverage', 'afterQuantity', 'afterAverage',
  'fiscalBeforeAverage', 'fiscalAfterAverage', 'proceeds', 'costBasis', 'fiscalResult', 'managementResult',
];

/** Export the flat calculation rows. This report is distinct from input CSV. */
export function exportReportCsv(rows) {
  if (!Array.isArray(rows)) throw error(1, 'il prospetto deve essere un elenco di operazioni.');
  if (rows.length > MAX_RECORDS) throw error(1, 'il prospetto supera il limite di 5000 record.');
  const extended = rows.some(row => !['acquisto', 'vendita'].includes(row.type) || EXTENDED_FIELDS.some(name => Object.hasOwn(row, name)));
  const columns = extended ? [...REPORT_COLUMNS, ...EXTENDED_REPORT_COLUMNS] : REPORT_COLUMNS;
  return writeCsv(columns, rows.map((row, index) => {
    const line = index + 2;
    if (!TRANSACTION_TYPES.includes(row.type)) throw error(line, 'tipo di transazione non valido nel prospetto.');
    const amounts = REPORT_AMOUNTS.map(name => {
      const value = row[name];
      if (value === undefined || value === null || value === '') return '';
      return decimalField(value, name, line, name === 'proceeds' || name === 'fiscalResult' || name === 'managementResult', false);
    });
    const extra = [];
    if (extended) {
      for (const name of ['totalEur', 'receivedAsset', 'receivedQuantity', 'lotDatePolicy', 'rewardCostEur', 'source', 'receivedBeforeQuantity', 'receivedAfterQuantity']) {
        const value = row[name];
        if (value === undefined || value === null || value === '') extra.push('');
        else if (name === 'receivedAsset') extra.push(textField(value, name, line));
        else if (name === 'source') extra.push(JSON.stringify(sourceField(value, line)));
        else if (name === 'lotDatePolicy') {
          if (!['historical', 'exchange'].includes(value)) throw error(line, 'il campo lotDatePolicy deve essere historical o exchange.');
          extra.push(value);
        } else extra.push(decimalField(value, name, line, false, false));
      }
    }
    return [textField(row.id, 'id', line), dateField(row.date, 'data', line), integerField(row.order, 'ordine', line),
      row.type, textField(row.asset, 'cripto', line), ...amounts, JSON.stringify(row.lotDetails ?? []), ...extra];
  }));
}

export const importers = Object.freeze([
  Object.freeze({ id: 'csv', label: 'CSV', extensions: Object.freeze(['csv']), parse: parseCsv }),
]);

/** Resolve formats in one place, ready for a future spreadsheet importer. */
export function parseImport(text, filename) {
  const extension = String(filename ?? '').split('.').pop().toLowerCase();
  const importer = importers.find(candidate => candidate.extensions.includes(extension));
  if (importer) return importer.parse(text);
  if (extension === 'xlsx' || extension === 'xls') {
    throw new Error('Il formato Excel non è ancora supportato. Usa il formato CSV documentato.');
  }
  throw new Error('Formato di importazione non supportato. Usa un file CSV.');
}
