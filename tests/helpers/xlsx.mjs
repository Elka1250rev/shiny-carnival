import { deflateRawSync } from 'node:zlib';

// Synthetic OOXML fixtures only. This helper is never shipped in the site.
export const xmlText = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const numeric = value => ({ value: String(value), type: 'n' });
export const formula = (expression, value) => ({ value: String(value), type: 'n', formula: expression });
const crc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
};
export function makeZip(entries, compressed = true) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const [path, value] of entries) {
    const name = Buffer.from(path);
    const data = Buffer.from(value);
    const packed = compressed ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compressed ? 8 : 0, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(header, name, packed);
    directory.push(central, name);
    offset += header.length + name.length + packed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
function column(index) {
  let value = index + 1; let result = '';
  while (value) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}
export function makeWorkbook(sheets, { compressed = true, sharedStrings = false } = {}) {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const shared = [];
  const sharedIndex = new Map();
  const entries = [
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + (sharedStrings ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : '') + '</Types>'],
    ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="book" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xmlText(sheet.name)}" sheetId="${index + 1}" r:id="r${index + 1}"${sheet.hidden ? ' state="hidden"' : ''}/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="r${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}${sharedStrings ? '<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' : ''}</Relationships>`]
  ];
  for (const [index, sheet] of sheets.entries()) entries.push([`xl/worksheets/sheet${index + 1}.xml`, `<worksheet xmlns="${ns}"><sheetData>${sheet.rows.map((values, row) => `<row r="${row + 1}">${values.map((input, col) => {
    if (input === undefined || input === null) return '';
    let value = typeof input === 'object' ? input : { value: String(input), type: 'inlineStr' };
    if (sharedStrings && value.type === 'inlineStr') {
      if (!sharedIndex.has(value.value)) { sharedIndex.set(value.value, shared.length); shared.push(value.value); }
      value = { type: 's', value: String(sharedIndex.get(value.value)) };
    }
    return `<c r="${column(col)}${row + 1}" t="${value.type || 'n'}">${value.formula !== undefined ? `<f>${xmlText(value.formula)}</f>` : ''}${value.type === 'inlineStr' ? `<is><t>${xmlText(value.value)}</t></is>` : `<v>${xmlText(value.value)}</v>`}</c>`;
  }).join('')}</row>`).join('')}</sheetData></worksheet>`]);
  if (sharedStrings) entries.push(['xl/sharedStrings.xml', `<sst xmlns="${ns}">${shared.map(value => `<si><t>${xmlText(value)}</t></si>`).join('')}</sst>`]);
  return makeZip(entries, compressed);
}
