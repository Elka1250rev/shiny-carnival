/**
 * Local, versioned interchange format. Every importer produces this same model;
 * fiscal and portfolio validation belongs to the calculation engine.
 */
export const CSV_COLUMNS = Object.freeze([
  'versione', 'tipo', 'id', 'data', 'ordine', 'cripto', 'quantita',
  'prezzo_unitario_eur', 'commissioni_eur', 'data_acquisto_originale',
  'anno_minusvalenza', 'importo_eur',
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

/** A strict CSV reader, including quoted delimiters and quoted newlines. */
function readRecords(text) {
  if (typeof text !== 'string') throw error(1, 'il contenuto CSV deve essere testo.');
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) {
    throw error(1, 'il file supera il limite di 5 MiB.');
  }
  const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const records = [];
  let fields = [];
  let value = '';
  let state = 'plain';
  let line = 1;
  let recordLine = 1;
  let touched = false;

  function finishRecord() {
    if (touched || fields.length || value.length) {
      fields.push(value);
      records.push({ fields, line: recordLine });
      // The header and the one required configuration row are metadata.
      if (records.length > MAX_RECORDS + 2) {
        throw error(recordLine, 'il file supera il limite di 5000 record di dati.');
      }
    }
    fields = [];
    value = '';
    state = 'plain';
    touched = false;
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (state === 'quoted') {
      if (character === '"') {
        if (source[index + 1] === '"') {
          value += '"';
          index += 1;
        } else state = 'closed';
      } else if (character === '\r' || character === '\n') {
        value += character;
        if (character === '\r' && source[index + 1] === '\n') {
          value += '\n';
          index += 1;
        }
        line += 1;
      } else value += character;
      continue;
    }
    if (character === ';') {
      fields.push(value);
      value = '';
      state = 'plain';
      touched = true;
    } else if (character === '\r' || character === '\n') {
      finishRecord();
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      line += 1;
      recordLine = line;
    } else if (state === 'closed') {
      throw error(line, 'carattere inatteso dopo la chiusura delle virgolette.');
    } else if (character === '"') {
      if (value.length) throw error(line, 'virgolette inattese in un campo non racchiuso tra virgolette.');
      state = 'quoted';
      touched = true;
    } else {
      value += character;
      touched = true;
    }
  }
  if (state === 'quoted') throw error(recordLine, 'campo con virgolette non chiuse.');
  finishRecord();
  return records;
}

function rejectUnused(row, allowed, line) {
  for (const name of CSV_COLUMNS) {
    if (!allowed.includes(name) && row[name] !== '') {
      throw error(line, `il campo ${name} deve essere vuoto per il tipo ${row.tipo}.`);
    }
  }
}

/** Parse the canonical format. Numeric amounts remain exact decimal strings. */
export function parseCsv(text) {
  const records = readRecords(text);
  if (!records.length) throw error(1, 'il file CSV è vuoto.');
  const header = records[0];
  const seen = new Set();
  for (const column of header.fields) {
    if (seen.has(column)) throw error(header.line, `colonna duplicata: ${column || '(vuota)'}.`);
    seen.add(column);
    if (!CSV_COLUMNS.includes(column)) throw error(header.line, `colonna non riconosciuta: ${column || '(vuota)'}.`);
  }
  const missing = CSV_COLUMNS.filter(column => !seen.has(column));
  if (missing.length) throw error(header.line, `colonne mancanti: ${missing.join(', ')}.`);

  const dataset = { version: 1, openingDate: '', initialLots: [], transactions: [], carryLosses: [] };
  let configurationFound = false;
  const initialDates = [];
  for (const record of records.slice(1)) {
    const { fields, line } = record;
    if (fields.length !== header.fields.length) {
      throw error(line, `numero di colonne errato: attese ${header.fields.length}, trovate ${fields.length}.`);
    }
    const row = Object.fromEntries(header.fields.map((column, index) => [column, fields[index]]));
    if (row.versione !== '1') throw error(line, `versione CSV non supportata: ${row.versione || '(vuota)'}.`);
    const common = ['versione', 'tipo'];
    if (row.tipo === 'configurazione') {
      rejectUnused(row, [...common, 'data'], line);
      if (configurationFound) throw error(line, 'è ammessa una sola riga configurazione.');
      configurationFound = true;
      dataset.openingDate = dateField(row.data, 'data', line);
    } else if (row.tipo === 'iniziale') {
      rejectUnused(row, [...common, 'id', 'data', 'ordine', 'cripto', 'quantita', 'prezzo_unitario_eur', 'data_acquisto_originale'], line);
      initialDates.push({ date: dateField(row.data, 'data', line), line });
      dataset.initialLots.push({
        id: textField(row.id, 'id', line),
        asset: textField(row.cripto, 'cripto', line),
        acquiredOn: dateField(row.data_acquisto_originale, 'data_acquisto_originale', line),
        order: integerField(row.ordine, 'ordine', line),
        quantity: decimalField(row.quantita, 'quantita', line),
        unitCost: decimalField(row.prezzo_unitario_eur, 'prezzo_unitario_eur', line),
      });
    } else if (row.tipo === 'acquisto' || row.tipo === 'vendita') {
      rejectUnused(row, [...common, 'id', 'data', 'ordine', 'cripto', 'quantita', 'prezzo_unitario_eur', 'commissioni_eur'], line);
      dataset.transactions.push({
        id: textField(row.id, 'id', line),
        date: dateField(row.data, 'data', line),
        order: integerField(row.ordine, 'ordine', line),
        type: row.tipo,
        asset: textField(row.cripto, 'cripto', line),
        quantity: decimalField(row.quantita, 'quantita', line),
        unitPrice: decimalField(row.prezzo_unitario_eur, 'prezzo_unitario_eur', line),
        fees: decimalField(row.commissioni_eur, 'commissioni_eur', line),
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
  if (!dataset || dataset.version !== 1) throw error(1, 'versione del dataset non supportata.');
  for (const name of ['initialLots', 'transactions', 'carryLosses']) {
    if (!Array.isArray(dataset[name])) throw error(1, `il campo ${name} deve essere un elenco.`);
  }
  const count = dataset.initialLots.length + dataset.transactions.length + dataset.carryLosses.length;
  if (count > MAX_RECORDS) throw error(1, 'il file supera il limite di 5000 record di dati.');
  const openingDate = dateField(dataset.openingDate, 'data', 2);
  const rows = [['1', 'configurazione', '', openingDate, '', '', '', '', '', '', '', '']];
  for (const lot of dataset.initialLots) {
    const line = rows.length + 2;
    rows.push(['1', 'iniziale', textField(lot.id, 'id', line), openingDate,
      integerField(lot.order, 'ordine', line), textField(lot.asset, 'cripto', line),
      decimalField(lot.quantity, 'quantita', line), decimalField(lot.unitCost, 'prezzo_unitario_eur', line), '',
      dateField(lot.acquiredOn, 'data_acquisto_originale', line), '', '']);
  }
  for (const transaction of dataset.transactions) {
    const line = rows.length + 2;
    if (transaction.type !== 'acquisto' && transaction.type !== 'vendita') {
      throw error(line, 'il tipo di transazione deve essere acquisto o vendita.');
    }
    rows.push(['1', transaction.type, textField(transaction.id, 'id', line), dateField(transaction.date, 'data', line),
      integerField(transaction.order, 'ordine', line), textField(transaction.asset, 'cripto', line),
      decimalField(transaction.quantity, 'quantita', line), decimalField(transaction.unitPrice, 'prezzo_unitario_eur', line),
      decimalField(transaction.fees, 'commissioni_eur', line), '', '', '']);
  }
  for (const loss of dataset.carryLosses) {
    const line = rows.length + 2;
    rows.push(['1', 'minusvalenza_pregressa', textField(loss.id, 'id', line), '', '', '', '', '', '', '',
      integerField(loss.year, 'anno_minusvalenza', line, true), decimalField(loss.amount, 'importo_eur', line)]);
  }
  return writeCsv(CSV_COLUMNS, rows);
}

const REPORT_COLUMNS = [
  'id', 'data', 'ordine', 'operazione', 'cripto', 'quantita', 'prezzo_unitario_eur', 'commissioni_eur',
  'quantita_prima', 'prezzo_medio_prima_eur', 'quantita_dopo', 'prezzo_medio_dopo_eur',
  'prezzo_medio_fiscale_prima_eur', 'prezzo_medio_fiscale_dopo_eur', 'ricavo_netto_eur',
  'costo_fiscale_eur', 'risultato_fiscale_eur', 'risultato_gestionale_eur', 'dettaglio_lotti',
];
const REPORT_AMOUNTS = [
  'quantity', 'unitPrice', 'fees', 'beforeQuantity', 'beforeAverage', 'afterQuantity', 'afterAverage',
  'fiscalBeforeAverage', 'fiscalAfterAverage', 'proceeds', 'costBasis', 'fiscalResult', 'managementResult',
];

/** Export the flat calculation rows. This report is distinct from input CSV. */
export function exportReportCsv(rows) {
  if (!Array.isArray(rows)) throw error(1, 'il prospetto deve essere un elenco di operazioni.');
  if (rows.length > MAX_RECORDS) throw error(1, 'il prospetto supera il limite di 5000 record.');
  return writeCsv(REPORT_COLUMNS, rows.map((row, index) => {
    const line = index + 2;
    if (row.type !== 'acquisto' && row.type !== 'vendita') throw error(line, 'tipo di transazione non valido nel prospetto.');
    const amounts = REPORT_AMOUNTS.map(name => {
      const value = row[name];
      if (value === undefined || value === null || value === '') return '';
      return decimalField(value, name, line, name === 'proceeds' || name === 'fiscalResult' || name === 'managementResult', false);
    });
    return [textField(row.id, 'id', line), dateField(row.date, 'data', line), integerField(row.order, 'ordine', line),
      row.type, textField(row.asset, 'cripto', line), ...amounts, JSON.stringify(row.lotDetails ?? [])];
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
