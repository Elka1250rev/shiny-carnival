// Small, local reader for .xlsx tables. Formulas, macros and links are never run.
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EXPANDED = 20 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const invalid = message => new Error('File Excel: ' + message);
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
};

/** ZIP validation is separate so malformed archives can be tested without a DOM. */
export function readXlsxArchive(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX_BYTES) throw invalid('il limite è di 5 MiB.');
  if (bytes.length < 22) throw invalid('archivio .xlsx incompleto o non riconosciuto.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === bytes.length) { end = at; break; }
  }
  if (end < 0) throw invalid('archivio .xlsx incompleto; usa un file Excel non cifrato.');
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)
    || view.getUint16(end + 8, true) !== count || !count || count > 256
    || centralOffset + centralSize > end) throw invalid('struttura ZIP non supportata (massimo 256 elementi, senza ZIP64).');
  const entries = new Map();
  let offset = centralOffset;
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw invalid('indice ZIP non valido.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameSize = view.getUint16(offset + 28, true);
    const extraSize = view.getUint16(offset + 30, true);
    const commentSize = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    if (next > centralOffset + centralSize || flags & 1 || ![0, 8].includes(method)
      || view.getUint16(offset + 34, true) || size === 0xffffffff || compressedSize === 0xffffffff) throw invalid('elemento ZIP cifrato o non supportato.');
    let name;
    try { name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameSize)); }
    catch { throw invalid('nome di elemento ZIP non valido.'); }
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.')
      || /[\u0000-\u001f]/.test(name) || entries.has(name)) throw invalid('percorso ZIP non valido o duplicato.');
    expanded += size;
    if (expanded > MAX_EXPANDED) throw invalid('il contenuto decompresso supera 20 MiB.');
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50
      || view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== method) throw invalid('intestazione ZIP incoerente.');
    const localNameSize = view.getUint16(localOffset + 26, true);
    const start = localOffset + 30 + localNameSize + view.getUint16(localOffset + 28, true);
    if (start + compressedSize > centralOffset || decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize)) !== name) throw invalid('dati ZIP incompleti o incoerenti.');
    entries.set(name, { method, size, crc: view.getUint32(offset + 16, true), data: bytes.subarray(start, start + compressedSize) });
    offset = next;
  }
  if (offset !== centralOffset + centralSize) throw invalid('dimensione dell’indice ZIP incoerente.');
  if ([...entries.keys()].some(name => /vbaProject|macrosheets|activeX/i.test(name))) throw invalid('sono ammessi soltanto fogli .xlsx senza macro.');
  return {
    has: name => entries.has(name),
    async text(name) {
      const entry = entries.get(name);
      if (!entry) throw invalid('elemento mancante: ' + name + '.');
      let output;
      if (entry.method === 0) output = entry.data;
      else {
        if (typeof DecompressionStream !== 'function') throw invalid('questo browser non supporta la decompressione locale; aggiorna il browser.');
        let reader;
        try { reader = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(); }
        catch { throw invalid('decompressione locale non disponibile in questo browser.'); }
        const chunks = [];
        let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > entry.size || length > MAX_EXPANDED) { await reader.cancel(); throw invalid('dimensione decompressa incoerente.'); }
            chunks.push(value);
          }
        } catch { throw invalid('contenuto compresso danneggiato o dimensione non valida.'); }
        output = new Uint8Array(length);
        let at = 0;
        for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; }
      }
      if (output.length !== entry.size || crc32(output) !== entry.crc) throw invalid('integrità del contenuto non valida.');
      try { return decoder.decode(output); }
      catch { throw invalid('testo XML non valido.'); }
    }
  };
}

function xml(text, root) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw invalid('dichiarazioni XML esterne non ammesse.');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || doc.documentElement.localName !== root) throw invalid('struttura XML non valida: ' + root + '.');
  return doc;
}
const children = (parent, name) => [...parent.children].filter(node => node.localName === name);
const child = (parent, name) => children(parent, name)[0];
const descendants = (parent, name) => [...parent.getElementsByTagNameNS('*', name)];
const richText = parent => descendants(parent, 't').filter(node => !node.closest('rPh')).map(node => node.textContent).join('');

function sheetPath(target) {
  if (!target || target.includes('\\') || /[?#:]/.test(target)) throw invalid('percorso del foglio non supportato.');
  const parts = target.startsWith('/') ? [] : ['xl'];
  for (const part of target.replace(/^\//, '').split('/')) {
    if (part === '..') { if (!parts.length) throw invalid('percorso del foglio non valido.'); parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  const result = parts.join('/');
  if (!result.startsWith('xl/worksheets/') || !result.endsWith('.xml')) throw invalid('percorso del foglio non supportato.');
  return result;
}

/** Return cell strings, never numeric JavaScript values or evaluated formulas. */
export async function readXlsxWorkbook(input) {
  const archive = readXlsxArchive(input);
  const types = xml(await archive.text('[Content_Types].xml'), 'Types');
  if (!descendants(types, 'Override').some(node => node.getAttribute('ContentType') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')) throw invalid('il documento non è una cartella .xlsx ordinaria.');
  const workbook = xml(await archive.text('xl/workbook.xml'), 'workbook');
  const rels = xml(await archive.text('xl/_rels/workbook.xml.rels'), 'Relationships');
  const relationships = new Map();
  for (const relation of children(rels.documentElement, 'Relationship')) {
    const id = relation.getAttribute('Id');
    if (!id || relationships.has(id)) throw invalid('relazioni della cartella non valide.');
    relationships.set(id, relation);
  }
  const shared = [];
  if (archive.has('xl/sharedStrings.xml')) {
    const strings = xml(await archive.text('xl/sharedStrings.xml'), 'sst');
    for (const item of children(strings.documentElement, 'si')) {
      if (shared.length >= 30000) throw invalid('troppi testi condivisi.');
      shared.push(richText(item));
    }
  }
  const sheets = descendants(workbook, 'sheet');
  if (!sheets.length || sheets.length > 20) throw invalid('sono ammessi da 1 a 20 fogli.');
  const result = [];
  for (const sheet of sheets) {
    const name = sheet.getAttribute('name');
    const id = [...sheet.attributes].find(attribute => attribute.localName === 'id')?.value;
    const relation = relationships.get(id);
    if (!name || name.length > 128 || !relation || relation.getAttribute('TargetMode') === 'External'
      || !relation.getAttribute('Type')?.endsWith('/worksheet')) throw invalid('foglio o relazione non supportati.');
    const document = xml(await archive.text(sheetPath(relation.getAttribute('Target'))), 'worksheet');
    const data = child(document.documentElement, 'sheetData');
    if (!data) throw invalid('tabella del foglio mancante.');
    const rows = [];
    const rowNumbers = new Set();
    let cellsCount = 0;
    for (const row of children(data, 'row')) {
      const number = Number(row.getAttribute('r'));
      if (!Number.isSafeInteger(number) || number < 1 || rowNumbers.has(number)) throw invalid('numerazione delle righe non valida.');
      rowNumbers.add(number);
      if (rows.length >= 10000) throw invalid('troppi record nel foglio (massimo 10.000 righe).');
      const cells = {};
      for (const cell of children(row, 'c')) {
        if (++cellsCount > 30000) throw invalid('troppe celle nel foglio (massimo 30.000).');
        const reference = cell.getAttribute('r');
        const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(reference || '');
        if (!match || Number(match[2]) !== number) throw invalid('riferimento di cella non valido.');
        let column = 0;
        for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
        if (column > 64 || Object.hasOwn(cells, column)) throw invalid('colonna fuori limite o duplicata.');
        const type = cell.getAttribute('t') || 'n';
        const formula = child(cell, 'f')?.textContent ?? null;
        const raw = child(cell, 'v')?.textContent ?? '';
        let value = raw;
        if (type === 's') {
          if (!/^\d+$/.test(raw) || !Object.hasOwn(shared, raw)) throw invalid('testo condiviso non valido.');
          value = shared[Number(raw)];
        } else if (type === 'inlineStr') value = richText(child(cell, 'is') || cell);
        if (value.length > 5000) throw invalid('testo di cella troppo lungo.');
        cells[column] = { reference, value, type: ['s', 'inlineStr', 'str'].includes(type) ? 'text' : type === 'n' ? 'number' : type, formula };
      }
      if (Object.values(cells).some(cell => cell.value !== '' || cell.formula !== null)) rows.push({ number, cells });
    }
    result.push({ name, hidden: ['hidden', 'veryHidden'].includes(sheet.getAttribute('state')), rows });
  }
  return { kind: 'opening-xlsx', sheets: result };
}
