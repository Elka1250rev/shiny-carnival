import { Decimal } from './decimal.js';

export const OPENING_COLUMNS = Object.freeze(['CRIPTOVALUTA', 'TOTALE CRIPTO', 'CRIPTO/EURO', 'EURO']);
const key = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
const bounded = /^\d{1,30}(?:\.\d{1,18})?$/;
const usableCell = cell => cell && ['text', 'number'].includes(cell.type);
const fail = (row, message) => { throw new Error((row ? `Riga Excel ${row}: ` : '') + message); };

/** Expand XML numeric spelling directly, without a floating-point conversion. */
export function sheetDecimal(raw) {
  const text = String(raw).trim().replace(',', '.');
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (!match || text.length > 256) throw new Error('Usa un numero non negativo con punto o virgola decimale, senza separatori delle migliaia.');
  const [, whole, fraction = '', exponent = '0'] = match;
  const point = whole.length + Number(exponent);
  if (Math.abs(Number(exponent)) > 100) throw new Error('Esponente numerico fuori limite.');
  const digits = whole + fraction;
  const value = point <= 0 ? '0.' + '0'.repeat(-point) + digits
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
      : digits.slice(0, point) + '.' + digits.slice(point);
  return value.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function parseOpeningSheet(sheet) {
  if (!sheet || !Array.isArray(sheet.rows)) throw new Error('Seleziona un foglio Excel valido.');
  const candidates = sheet.rows.slice(0, 100).map((row, index) => ({ row, index,
    names: new Set(Object.values(row.cells).map(cell => key(cell.value))) }));
  // A one-word title is not the table header when a complete header follows.
  const full = candidates.find(candidate => OPENING_COLUMNS.every(name => candidate.names.has(name)));
  const partial = candidates.find(candidate => candidate.names.has('CRIPTOVALUTA'));
  const headerIndex = (full || partial)?.index ?? -1;
  if (headerIndex < 0) throw new Error('Intestazioni non trovate: servono CRIPTOVALUTA, TOTALE CRIPTO, CRIPTO/EURO ed EURO.');
  const header = sheet.rows[headerIndex];
  const columns = {};
  for (const [column, cell] of Object.entries(header.cells)) {
    const name = key(cell.value);
    if (!name) continue;
    if (!usableCell(cell) || cell.formula !== null || !OPENING_COLUMNS.includes(name)) fail(header.number, 'intestazione non riconosciuta: ' + name + '.');
    if (Object.hasOwn(columns, name)) fail(header.number, 'intestazione duplicata: ' + name + '.');
    columns[name] = Number(column);
  }
  const missing = OPENING_COLUMNS.filter(name => !Object.hasOwn(columns, name));
  if (missing.length) fail(header.number, 'intestazioni mancanti: ' + missing.join(', ') + '.');
  const rows = [];
  const totals = [];
  for (const row of sheet.rows.slice(headerIndex + 1)) {
    const get = name => row.cells[columns[name]] || { value: '', formula: null, type: 'text' };
    const assetCell = get('CRIPTOVALUTA');
    const quantityCell = get('TOTALE CRIPTO');
    const unitCell = get('CRIPTO/EURO');
    const totalCell = get('EURO');
    const used = new Set(Object.values(columns));
    if (Object.entries(row.cells).some(([column, cell]) => !used.has(Number(column)) && (cell.value !== '' || cell.formula !== null))) fail(row.number, 'sono presenti dati in colonne aggiuntive.');
    if (!assetCell.value && Object.values(row.cells).some(cell => /^TOTALE VALORE CRIPTO IN EURO:?$/.test(key(cell.value)))) {
      totals.push({ row: row.number, value: totalCell.value, formula: totalCell.formula });
      continue;
    }
    const asset = key(assetCell.value);
    if (!usableCell(assetCell) || assetCell.formula !== null || !/^[\p{L}\p{N}][\p{L}\p{N} ._:/-]{0,49}$/u.test(asset)) fail(row.number, 'identificatore crypto mancante o non valido.');
    if (!usableCell(quantityCell) || quantityCell.formula !== null) fail(row.number, 'la quantità deve essere un numero o testo numerico esplicito, senza formule, date, orari, durate, formati non riconosciuti, valori logici VERO/FALSO o errori Excel.');
    let quantity;
    try { quantity = sheetDecimal(quantityCell.value); }
    catch (error) { fail(row.number, 'TOTALE CRIPTO: ' + error.message); }
    rows.push({ row: row.number, asset, quantity, unitValue: unitCell.value,
      unitFormula: unitCell.formula, unitType: unitCell.type, totalValue: totalCell.value, totalFormula: totalCell.formula,
      source: { quantity: quantityCell.value, unitValue: unitCell.value, totalValue: totalCell.value } });
    if (rows.length > 5000) fail(row.number, 'il limite è di 5.000 posizioni.');
  }
  if (!rows.length) throw new Error('Il foglio non contiene posizioni dopo le intestazioni.');
  return { kind: 'opening-sheet', name: sheet.name, headerRow: header.number, rows, totals,
    notes: sheet.rows.slice(0, headerIndex).map(row => ({ row: row.number, text: Object.values(row.cells).map(cell => cell.value).filter(Boolean).join(' · ') })) };
}

export function openingUnitCost(row) {
  if (!['text', 'number'].includes(row.unitType) || row.unitFormula !== null) {
    throw new Error('CRIPTO/EURO deve essere un numero o testo numerico esplicito, senza formule, date, orari, durate, formati non riconosciuti, valori logici o errori Excel. Inserisci manualmente il costo verificato.');
  }
  return sheetDecimal(row.unitValue);
}

function date(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Inserisci esplicitamente ' + label + '.');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(label + ' non valida.');
  return parsed;
}

export function openingDateForSnapshot(snapshotDate, timing) {
  const parsed = date(snapshotDate, 'la data della situazione');
  if (!['start', 'end'].includes(timing)) throw new Error('Indica se i saldi si riferiscono all’inizio o alla fine della giornata.');
  if (timing === 'end') parsed.setUTCDate(parsed.getUTCDate() + 1);
  const openingDate = parsed.toISOString().slice(0, 10);
  if (openingDate < '2025-01-01' || openingDate > '2026-12-31') throw new Error('L’apertura risultante deve ricadere nel 2025 o 2026. I saldi di fine 31/12/2024 corrispondono all’apertura del 01/01/2025.');
  return openingDate;
}

function amount(value, label, positive = false) {
  const normalized = typeof value === 'string' ? value.trim().replace(',', '.') : '';
  if (!bounded.test(normalized)) throw new Error(label + ': usa massimo 30 cifre intere e 18 decimali, senza separatori delle migliaia.');
  const decimal = Decimal.from(normalized);
  if (positive && decimal.cmp('0') <= 0) throw new Error(label + ': la quantità deve essere maggiore di zero.');
  return { text: normalized, decimal };
}

/** Only explicitly documented lot data becomes fiscal opening inventory. */
export function convertOpeningSnapshot(source, current, options) {
  if (!source || source.kind !== 'opening-sheet' || !Array.isArray(source.rows)) throw new Error('Seleziona una tabella iniziale valida.');
  const openingDate = openingDateForSnapshot(options?.snapshotDate, options?.timing);
  if (!['estimated_average', 'market', 'average_cost', 'unit_cost'].includes(options.valueMeaning)) throw new Error('Conferma il significato di CRIPTO/EURO scegliendo uno dei criteri disponibili.');
  const estimated = options.valueMeaning === 'estimated_average';
  if (options.replaceConfirmed !== true) throw new Error('Conferma la sostituzione dei lotti iniziali e della data di apertura.');
  if (options.costsConfirmed !== true) throw new Error(estimated ? 'Conferma l’uso dei prezzi medi storici stimati e dei saldi aggregati: i risultati saranno indicativi.' : 'Conferma quantità, date originarie e costi fiscali documentati dei lotti.');
  if (source.rows.some(row => row.asset === 'EUR') && options.euroConfirmed !== true) throw new Error('Conferma che la riga EUR sia liquidità informativa, esclusa dai lotti crypto.');
  const idPrefix = options.idPrefix || 'apertura-' + crypto.randomUUID();
  const lots = [];
  for (const row of source.rows) {
    if (row.asset === 'EUR') continue;
    const target = amount(options.quantities?.[row.row] ?? row.quantity, `Riga Excel ${row.row}, quantità confermata`);
    const details = options.lots?.[row.row] || [];
    if (!Array.isArray(details)) fail(row.row, 'i lotti devono essere un elenco.');
    if (target.decimal.cmp('0') === 0 && !details.length) continue;
    if (!details.length) fail(row.row, 'inserisci almeno un lotto con data e costo documentati per ' + row.asset + '.');
    if (estimated && details.length !== 1) fail(row.row, 'la stima da prezzo medio storico usa un solo saldo aggregato per crypto; scegli i lotti documentati per suddividerlo.');
    let sum = Decimal.from('0');
    for (const [index, lot] of details.entries()) {
      const label = `Riga Excel ${row.row}, lotto ${index + 1}`;
      if (!estimated) {
        date(lot.acquiredOn, label + ': data originaria di acquisto');
        if (lot.acquiredOn > options.snapshotDate) throw new Error(label + ': l’acquisto non può essere successivo alla data dei saldi.');
      }
      const quantity = amount(lot.quantity, label, true);
      const cost = amount(lot.unitCost, label + ': costo unitario fiscale');
      sum = sum.add(quantity.decimal);
      lots.push({ id: `${idPrefix}-${row.row}-${index}`, asset: row.asset, acquiredOn: estimated ? '' : lot.acquiredOn,
        order: lots.length + 1, quantity: quantity.text, unitCost: cost.text,
        ...(estimated ? { basisMethod: 'estimated_average' } : {}) });
      if (lots.length > 5000) throw new Error('Il limite è di 5.000 lotti; considera anche le operazioni e le minusvalenze esistenti.');
    }
    if (sum.cmp(target.decimal) !== 0) fail(row.row, `la somma dei lotti di ${row.asset} deve coincidere con la quantità confermata (${target.text}).`);
  }
  const next = structuredClone(current);
  if (estimated) next.version = 2;
  next.openingDate = openingDate;
  next.initialLots = lots;
  return next;
}
