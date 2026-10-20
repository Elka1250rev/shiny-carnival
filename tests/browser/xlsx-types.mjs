import assert from 'node:assert/strict';
import { makeWorkbook, numeric as n, xmlText } from '../helpers/xlsx.mjs';

const headers = ['CRIPTOVALUTA', 'TOTALE CRIPTO', 'CRIPTO/EURO', 'EURO'];
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const attributes = values => Object.entries(values).map(([name, value]) => ` ${name}="${xmlText(value)}"`).join('');
const styles = ({ formats = [], cells = [{ numFmtId: 0 }, { numFmtId: 14 }], bases = [] } = {}) =>
  `<styleSheet xmlns="${ns}"><numFmts count="${formats.length}">${formats.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xmlText(code)}"/>`).join('')}</numFmts>`
  + `<cellStyleXfs count="${bases.length}">${bases.map(value => `<xf${attributes(value)}/>`).join('')}</cellStyleXfs>`
  + `<cellXfs count="${cells.length}">${cells.map(value => `<xf${attributes(value)}/>`).join('')}</cellXfs></styleSheet>`;
const fixture = ({ quantity = n('3'), cost = n('12'), stylesXml = styles(), transformXml, sharedStrings = false } = {}) => makeWorkbook([
  { name: 'Tipi sintetici', rows: [headers, ['ALFA', quantity, cost, n('36')]], transformXml }
], { stylesXml, sharedStrings });
const styled = (value, style = 1) => ({ ...n(value), style });

export async function verifyXlsxTypes({ page, label, results }) {
  const inspect = bytes => page.evaluate(async values => {
    const { readXlsxWorkbook } = await import('./xlsx-reader.js');
    const { parseOpeningSheet, openingUnitCost } = await import('./opening-import.js');
    try {
      const workbook = await readXlsxWorkbook(new Uint8Array(values));
      const sheet = workbook.sheets[0];
      const data = sheet.rows.find(row => row.number === 2);
      const result = { quantityType: data.cells[2].type, costType: data.cells[3].type,
        storedQuantity: data.cells[2].value, storedCost: data.cells[3].value };
      let source;
      try { source = parseOpeningSheet(sheet); result.quantity = source.rows[0].quantity; }
      catch (error) { result.quantityError = error.message; return result; }
      try { result.cost = openingUnitCost(source.rows[0]); }
      catch (error) { result.costError = error.message; }
      return result;
    } catch (error) { return { readError: error.message }; }
  }, Array.from(bytes));
  const dateFormats = [
    { name: 'built-in date', cells: [{ numFmtId: 0 }, { numFmtId: 14 }] },
    { name: 'built-in clock', cells: [{ numFmtId: 0 }, { numFmtId: 20 }] },
    { name: 'built-in elapsed time', cells: [{ numFmtId: 0 }, { numFmtId: 46 }] },
    { name: 'localized built-in date', cells: [{ numFmtId: 0 }, { numFmtId: 27 }] },
    { name: 'custom date', formats: [[164, 'dd/mm/yyyy']], cells: [{ numFmtId: 0 }, { numFmtId: 164 }] },
    { name: 'custom clock', formats: [[164, 'hh:mm:ss']], cells: [{ numFmtId: 0 }, { numFmtId: 164 }] },
    { name: 'custom duration', formats: [[164, '[h]:mm:ss']], cells: [{ numFmtId: 0 }, { numFmtId: 164 }] },
    { name: 'conditional temporal section', formats: [[164, '[>=1]yyyy-mm-dd;0.00']], cells: [{ numFmtId: 0 }, { numFmtId: 164 }] },
    { name: 'inherited base format', bases: [{ numFmtId: 14 }], cells: [{ numFmtId: 0 }, { xfId: 0 }] },
    { name: 'explicit temporal cell format with absent application flag', cells: [{ numFmtId: 0 }, { numFmtId: 14, applyNumberFormat: 0 }] }
  ];
  for (const entry of dateFormats) {
    const stylesXml = styles(entry);
    const quantity = await inspect(fixture({ quantity: styled('45657'), stylesXml }));
    assert.equal(quantity.quantityType, 'd', entry.name);
    assert.equal(quantity.storedQuantity, '45657', 'The stored serial is preserved, never converted or rounded.');
    assert.match(quantity.quantityError, /Riga Excel 2: la quantità/, entry.name);
    const cost = await inspect(fixture({ cost: styled('45657'), stylesXml }));
    assert.equal(cost.quantity, '3', entry.name);
    assert.equal(cost.costType, 'd', entry.name);
    assert.equal(cost.storedCost, '45657');
    assert.match(cost.costError, /Inserisci manualmente il costo verificato/, entry.name);
    assert.equal(cost.cost, undefined, 'A date serial cannot prefill or copy a fiscal cost.');
  }

  // Whole-row or whole-column formatting can apply without an s attribute on the cell.
  const inherited = [
    xml => xml.replace('<row r="2">', '<row r="2" s="1" customFormat="1">'),
    xml => xml.replace('<sheetData>', '<cols><col min="2" max="3" style="1"/></cols><sheetData>')
  ];
  for (const transformXml of inherited) {
    const result = await inspect(fixture({ quantity: n('45657'), transformXml }));
    assert.equal(result.quantityType, 'd');
    assert.match(result.quantityError, /Riga Excel 2: la quantità/);
  }
  const explicit = await inspect(fixture({ quantity: styled('3', 0), cost: styled('12', 0), transformXml: inherited[0] }));
  assert.equal(explicit.quantity, '3'); assert.equal(explicit.cost, '12');
  const inactiveRow = await inspect(fixture({ transformXml: xml => xml.replace('<row r="2">', '<row r="2" s="1" customFormat="0">') }));
  assert.equal(inactiveRow.quantity, '3'); assert.equal(inactiveRow.cost, '12');

  // A date format does not turn explicitly stored text into an Excel date serial.
  for (const sharedStrings of [false, true]) {
    const text = await inspect(fixture({ quantity: { type: 'inlineStr', value: '0.123456789012345678', style: 1 },
      cost: { type: 'inlineStr', value: '12.000000000000000001', style: 1 }, sharedStrings }));
    assert.equal(text.quantityType, 'text'); assert.equal(text.costType, 'text');
    assert.equal(text.quantity, '0.123456789012345678'); assert.equal(text.cost, '12.000000000000000001');
  }
  for (const code of ['[$USD-409]#,##0.00', '#,##0.00 "USD"', '0.00E+00', '##0.0E-0', '0\\m', '0_m', '0*m', '0.00;[Red](0.00);"-";"date text"']) {
    const amount = await inspect(fixture({ quantity: styled('1.23456789012345678E-1'), cost: styled('12.000000000000000001'),
      stylesXml: styles({ formats: [[164, code]], cells: [{ numFmtId: 0 }, { numFmtId: 164 }] }) }));
    assert.equal(amount.quantityType, 'number', code); assert.equal(amount.costType, 'number', code);
    assert.equal(amount.quantity, '0.123456789012345678', code); assert.equal(amount.cost, '12.000000000000000001', code);
  }

  const invalidStyles = [
    [fixture({ quantity: styled('3', 2) }), /indice dello stile/],
    [fixture({ quantity: styled('3', '-1') }), /indice dello stile/],
    [fixture({ quantity: styled('3', 1), stylesXml: null }), /indice dello stile/],
    [fixture({ stylesXml: styles({ cells: [{ numFmtId: 0 }, { xfId: 3 }] }) }), /stile base.*mancante/],
    [fixture({ stylesXml: styles({ formats: [[164, '0.00'], [164, 'yyyy-mm-dd']] }) }), /formato numerico.*duplicato/],
    [fixture({ transformXml: xml => xml.replace('<sheetData>', '<cols><col min="2" max="16385" style="1"/></cols><sheetData>') }), /intervallo dello stile/]
  ];
  for (const [bytes, pattern] of invalidStyles) assert.match((await inspect(bytes)).readError, pattern);
  for (const entry of [
    { cells: [{ numFmtId: 0 }, { numFmtId: 4096 }] },
    { cells: [{ numFmtId: 0 }, { numFmtId: 164 }], formats: [[164, '[$-F800]']] },
    { cells: [{ numFmtId: 0 }, { numFmtId: 164 }], formats: [[164, '0"unfinished']] }
  ]) {
    const stylesXml = styles(entry);
    const quantity = await inspect(fixture({ quantity: styled('45657'), stylesXml }));
    assert.equal(quantity.quantityType, 'unknown-number-format');
    assert.match(quantity.quantityError, /Riga Excel 2: la quantità/);
    const cost = await inspect(fixture({ cost: styled('45657'), stylesXml }));
    assert.equal(cost.costType, 'unknown-number-format');
    assert.match(cost.costError, /Inserisci manualmente il costo verificato/);
  }
  results.push({ name: 'xlsx-types-' + label, serialDatesBlocked: true, customDateAndTimeFormats: true,
    inheritedStylesChecked: true, explicitTextPreserved: true, currencyAndScientificFormatsPreserved: true,
    unsafeStyleReferencesRejected: true, unknownFormatsRequireReview: true });
  console.log(`PASS xlsx-types-${label}: date serials, inherited styles, precise numeric/text values and invalid styles.`);
}
