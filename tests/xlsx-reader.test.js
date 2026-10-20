import test from 'node:test';
import assert from 'node:assert/strict';
import { readXlsxArchive, classifyXlsxNumberFormat } from '../dist/xlsx-reader.js';
import { makeZip } from './helpers/xlsx.mjs';

test('stored and deflated XML is read locally with byte and CRC verification', async () => {
  for (const compressed of [false, true]) {
    const archive = readXlsxArchive(makeZip([['xl/worksheets/test.xml', '<worksheet>caffè 石油</worksheet>']], compressed));
    assert.equal(archive.has('xl/worksheets/test.xml'), true);
    assert.equal(await archive.text('xl/worksheets/test.xml'), '<worksheet>caffè 石油</worksheet>');
    await assert.rejects(archive.text('missing.xml'), /elemento mancante/);
  }
});
test('truncation, invalid files and oversized compressed inputs are rejected', () => {
  assert.throws(() => readXlsxArchive(Buffer.from('not Excel')), /incompleto|riconosciuto/);
  const zip = makeZip([['a.xml', '<a/>']]);
  assert.throws(() => readXlsxArchive(zip.subarray(0, zip.length - 1)), /incompleto/);
  assert.throws(() => readXlsxArchive(new Uint8Array(5 * 1024 * 1024 + 1)), /5 MiB/);
});
test('duplicate paths, traversal, macros and encryption do not enter the reader', () => {
  for (const path of ['../a.xml', '/a.xml', 'xl/./a.xml', 'xl\\a.xml']) assert.throws(() => readXlsxArchive(makeZip([[path, '<a/>']])), /percorso/);
  assert.throws(() => readXlsxArchive(makeZip([['a.xml', 'a'], ['a.xml', 'b']])), /duplicato/);
  assert.throws(() => readXlsxArchive(makeZip([['xl/vbaProject.bin', 'macro']])), /macro/);
  const encrypted = makeZip([['a.xml', '<a/>']]);
  const at = encrypted.readUInt32LE(encrypted.length - 6);
  encrypted.writeUInt16LE(1, at + 8);
  assert.throws(() => readXlsxArchive(encrypted), /cifrato/);
});
test('corrupt bytes and false uncompressed lengths are bounded and rejected', async () => {
  const stored = makeZip([['a.xml', '<a>value</a>']], false);
  stored[30 + Buffer.byteLength('a.xml')] ^= 1;
  await assert.rejects(readXlsxArchive(stored).text('a.xml'), /integrità/);
  const oversized = makeZip([['a.xml', '<a/>']]);
  const central = oversized.readUInt32LE(oversized.length - 6);
  oversized.writeUInt32LE(21 * 1024 * 1024, central + 24);
  assert.throws(() => readXlsxArchive(oversized), /20 MiB/);
  const understated = makeZip([['a.xml', '<a>' + 'a'.repeat(10000) + '</a>']]);
  const at = understated.readUInt32LE(understated.length - 6);
  understated.writeUInt32LE(1, at + 24);
  await assert.rejects(readXlsxArchive(understated).text('a.xml'), /dimensione/);
});

test('date, clock and elapsed-time formats cannot disguise stored serials as financial amounts', () => {
  for (const format of ['dd/mm/yyyy', 'yyyy-mm-dd"T"hh:mm:ss', 'h:mm AM/PM', '[h]:mm:ss', '[mm]:ss', '[ss].00',
    '[>=1]dd/mm/yyyy;0.00', '[$-411]ggge"年"m"月"d"日"']) {
    assert.equal(classifyXlsxNumberFormat(format), 'date', format);
  }
});

test('quoted currency text, escaped date letters and scientific notation remain numeric', () => {
  for (const format of ['General', '#,##0.00', '0.00E+00', '##0.0E-0', '[$USD-409]#,##0.00',
    '0.00 "USD"', '0\\m', '0_m', '0*m', '0.00;[Red](0.00);"-";"day month year"', '[DBNum1][$-804]General']) {
    assert.equal(classifyXlsxNumberFormat(format), 'number', format);
  }
});

test('incomplete formats and system date/time formats stay unclassified for explicit review', () => {
  for (const format of ['0"unfinished', '[Red', '0\\', '0_', '0*', '[$-F800]', '[$-F400]', '0'.repeat(5001), null]) {
    assert.equal(classifyXlsxNumberFormat(format), 'unknown', String(format).slice(0, 30));
  }
});
