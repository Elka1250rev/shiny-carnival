import test from 'node:test';
import assert from 'node:assert/strict';
import { readCsvRecords } from '../dist/csv-reader.js';

test('comma CSV preserves quoted commas, semicolons, escaped quotes and Unicode', () => {
  const input = 'asset,note,empty\nBTC,"Virgola, punto e virgola; ""testo"" 石油",\n';
  assert.deepEqual(readCsvRecords(input, { delimiter: ',' }), [
    { fields: ['asset', 'note', 'empty'], line: 1 },
    { fields: ['BTC', 'Virgola, punto e virgola; "testo" 石油', ''], line: 2 },
  ]);
});

test('semicolon remains the default and decimal commas are untouched', () => {
  assert.deepEqual(readCsvRecords('asset;amount;note\nBTC;12,3400;"testo; altro, testo"'), [
    { fields: ['asset', 'amount', 'note'], line: 1 },
    { fields: ['BTC', '12,3400', 'testo; altro, testo'], line: 2 },
  ]);
});

test('BOM, empty physical lines and all three line endings retain source line numbers', () => {
  const input = '\uFEFF\r\nasset,amount\r\n\r\nBTC,1\rETH,2\n';
  assert.deepEqual(readCsvRecords(input, { delimiter: ',' }), [
    { fields: ['asset', 'amount'], line: 2 },
    { fields: ['BTC', '1'], line: 4 },
    { fields: ['ETH', '2'], line: 5 },
  ]);
});

test('quoted multiline fields preserve newline characters and advance physical lines', () => {
  const input = 'a,b\r\n"prima\r\nseconda\rterza\nquarta",ok\r\nnext,last';
  assert.deepEqual(readCsvRecords(input, { delimiter: ',' }), [
    { fields: ['a', 'b'], line: 1 },
    { fields: ['prima\r\nseconda\rterza\nquarta', 'ok'], line: 2 },
    { fields: ['next', 'last'], line: 6 },
  ]);
});

test('numbers remain strings with their exact precision and original spelling', () => {
  const values = ['9007199254740993.123456789012345678', '0.000000000000000001', '00012.3400', '12,3400', '1e-8'];
  const input = values.map(value => `"${value}"`).join(',');
  assert.deepEqual(readCsvRecords(input, { delimiter: ',' }), [{ fields: values, line: 1 }]);
});

test('malformed quoting identifies the physical line for either delimiter', () => {
  for (const delimiter of [';', ',']) {
    assert.throws(() => readCsvRecords(`header\n"value"x${delimiter}other`, { delimiter }), /Riga 2: carattere inatteso dopo la chiusura delle virgolette\./);
    assert.throws(() => readCsvRecords(`header\nval"ue${delimiter}other`, { delimiter }), /Riga 2: virgolette inattese in un campo non racchiuso tra virgolette\./);
    assert.throws(() => readCsvRecords('header\n"non\nchiuso', { delimiter }), /Riga 2: campo con virgolette non chiuse\./);
  }
});

test('empty files produce no records while explicit empty fields remain records', () => {
  for (const input of ['', '\uFEFF', '\r\n\n']) assert.deepEqual(readCsvRecords(input), []);
  assert.deepEqual(readCsvRecords('""\n;\n'), [
    { fields: [''], line: 1 },
    { fields: ['', ''], line: 2 },
  ]);
});

test('default record limit allows header, configuration and 5000 data records', () => {
  const input = ['header', 'configuration', ...Array(5000).fill('data')].join('\n');
  assert.equal(readCsvRecords(input).length, 5002);
  assert.throws(() => readCsvRecords(`${input}\nextra`), /Riga 5003: il file supera il limite di 5000 record di dati\./);
});

test('custom record limit counts logical records including the header but excludes blank lines', () => {
  const input = 'header\n\n"data\ncontinua"\n';
  assert.equal(readCsvRecords(input, { maxRecords: 2 }).length, 2);
  assert.throws(() => readCsvRecords(`${input}extra`, { maxRecords: 2 }), /Riga 5: il file supera il limite di 5000 record di dati\./);
});

test('invalid input, delimiters and limits fail explicitly', () => {
  assert.throws(() => readCsvRecords(null), /Riga 1: il contenuto CSV deve essere testo\./);
  for (const delimiter of ['|', '\t', '', ';;', null]) {
    assert.throws(() => readCsvRecords('a,b', { delimiter }), /Riga 1: il separatore CSV deve essere una virgola o un punto e virgola\./);
  }
  for (const maxRecords of [-1, 1.5, Infinity, NaN, '2']) {
    assert.throws(() => readCsvRecords('a', { maxRecords }), /Riga 1: il limite di record deve essere un intero non negativo\./);
  }
});

test('the size limit measures UTF-8 bytes rather than JavaScript character count', () => {
  assert.throws(() => readCsvRecords('é'.repeat(3 * 1024 * 1024)), /Riga 1: il file supera il limite di 5 MiB\./);
});
