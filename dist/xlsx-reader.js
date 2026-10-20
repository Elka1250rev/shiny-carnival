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

function workbookPartPath(target) {
  if (!target || target.includes('\\') || /[?#:]/.test(target)) throw invalid('percorso del documento non supportato.');
  const parts = target.startsWith('/') ? [] : ['xl'];
  for (const part of target.replace(/^\//, '').split('/')) {
    if (part === '..') { if (!parts.length) throw invalid('percorso del foglio non valido.'); parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  const result = parts.join('/');
  if (!result.startsWith('xl/') || !result.endsWith('.xml')) throw invalid('percorso del documento non supportato.');
  return result;
}

function sheetPath(target) {
  const result = workbookPartPath(target);
  if (!result.startsWith('xl/worksheets/')) throw invalid('percorso del foglio non supportato.');
  return result;
}

/** Classify Excel format tokens, excluding literals, currency tags and text sections.
 * The serial value is deliberately never converted into a date or an amount.
 * Mixed numeric/date sections require manual review, regardless of their conditions.
 * References: ISO/IEC 29500 §18.8.30–31; MS-OI29500 §2.1.712.
 */
export function classifyXlsxNumberFormat(formatCode) {
  if (typeof formatCode !== 'string' || formatCode.length > 5000) return 'unknown';
  let tokens = '';
  let section = 0;
  for (let index = 0; index < formatCode.length; index += 1) {
    const character = formatCode[index];
    if (character === ';') { if (++section === 3) break; tokens += ';'; }
    else if (character === '"') {
      const end = formatCode.indexOf('"', index + 1);
      if (end < 0) return 'unknown';
      index = end;
    } else if ('\\_*'.includes(character)) {
      if (++index >= formatCode.length) return 'unknown';
    } else if (character === '[') {
      const end = formatCode.indexOf(']', index + 1);
      if (end < 0) return 'unknown';
      const tag = formatCode.slice(index + 1, end);
      if (/^(h+|m+|s+)$/i.test(tag)) tokens += 'h';
      // System-defined date/time locale formats cannot safely be treated as numbers.
      else if (/^\$.*-(?:f400|f800)$/i.test(tag)) return 'unknown';
      index = end;
    } else tokens += character;
  }
  tokens = tokens.replace(/general/gi, '').replace(/e[+-]0+/gi, '');
  // e/g are era/year tokens; the scientific exponent was removed above.
  return /[ymdhseg]/i.test(tokens) ? 'date' : 'number';
}

function builtinNumberFormat(id) {
  // The locale-specific IDs are defined in ISO/IEC 29500 §18.8.30.
  if (id >= 14 && id <= 22 || id >= 27 && id <= 36 || id >= 45 && id <= 47
    || id >= 50 && id <= 58 || id >= 71 && id <= 81) return 'date';
  if (id >= 0 && id <= 13 || id >= 37 && id <= 44 || id === 48 || id === 49
    || id >= 59 && id <= 70) return 'number';
  return 'unknown';
}

function unsignedAttribute(node, attribute, fallback = null) {
  const raw = node.getAttribute(attribute);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) > 4294967295) throw invalid('attributo dello stile non valido: ' + attribute + '.');
  return Number(raw);
}

async function readNumberStyles(archive, relationships) {
  const relations = [...relationships.values()].filter(relation => relation.getAttribute('Type')?.endsWith('/styles'));
  if (relations.length > 1 || relations[0]?.getAttribute('TargetMode') === 'External') throw invalid('relazione degli stili non valida.');
  const path = relations.length ? workbookPartPath(relations[0].getAttribute('Target')) : archive.has('xl/styles.xml') ? 'xl/styles.xml' : null;
  let formats = ['number'];
  if (path) {
    const document = xml(await archive.text(path), 'styleSheet').documentElement;
    const custom = new Map();
    const definitions = children(child(document, 'numFmts') || document, 'numFmt');
    if (definitions.length > 30000) throw invalid('troppi formati numerici.');
    for (const definition of definitions) {
      const id = unsignedAttribute(definition, 'numFmtId');
      const code = definition.getAttribute('formatCode');
      if (id === null || code === null || custom.has(id)) throw invalid('formato numerico mancante o duplicato.');
      custom.set(id, classifyXlsxNumberFormat(code));
    }
    const base = children(child(document, 'cellStyleXfs') || document, 'xf');
    const cells = children(child(document, 'cellXfs') || document, 'xf');
    if (cells.length > 30000 || base.length > 30000) throw invalid('troppi stili di cella.');
    if (cells.length) formats = cells.map(cell => {
      const parent = unsignedAttribute(cell, 'xfId');
      if (parent !== null && !base[parent]) throw invalid('stile base della cella mancante.');
      // Excel keeps the current cell format in cellXfs even when applyNumberFormat
      // is absent/false (MS-OI29500 §18.8.45). Never discard that explicit format.
      const id = unsignedAttribute(cell, 'numFmtId', parent === null ? 0 : unsignedAttribute(base[parent], 'numFmtId', 0));
      return custom.has(id) ? custom.get(id) : builtinNumberFormat(id);
    });
  }
  return raw => {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || !Object.hasOwn(formats, Number(raw))) throw invalid('indice dello stile di cella non valido.');
    return formats[Number(raw)];
  };
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
  const numberStyle = await readNumberStyles(archive, relationships);
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
    const columnStyles = Array.from({ length: 65 }, () => new Set());
    for (const columns of children(document.documentElement, 'cols')) {
      for (const column of children(columns, 'col')) {
        if (!column.hasAttribute('style')) continue;
        const min = unsignedAttribute(column, 'min');
        const max = unsignedAttribute(column, 'max');
        if (min === null || max === null || min < 1 || min > max || max > 16384) throw invalid('intervallo dello stile di colonna non valido.');
        const style = numberStyle(column.getAttribute('style'));
        for (let at = min; at <= Math.min(max, 64); at += 1) columnStyles[at].add(style);
      }
    }
    const rows = [];
    const rowNumbers = new Set();
    let cellsCount = 0;
    for (const row of children(data, 'row')) {
      const number = Number(row.getAttribute('r'));
      if (!Number.isSafeInteger(number) || number < 1 || number > 1048576 || rowNumbers.has(number)) throw invalid('numerazione delle righe non valida.');
      rowNumbers.add(number);
      if (rowNumbers.size > 10000) throw invalid('troppi record nel foglio (massimo 10.000 righe, incluse quelle vuote).');
      const customFormat = row.getAttribute('customFormat');
      if (customFormat !== null && !['0', '1', 'false', 'true'].includes(customFormat)) throw invalid('formato della riga non valido.');
      const rowStyle = row.hasAttribute('s') ? numberStyle(row.getAttribute('s')) : null;
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
        if (!['n', 's', 'inlineStr', 'str', 'b', 'd', 'e'].includes(type)) throw invalid('tipo di cella non riconosciuto: ' + reference + '.');
        const explicitStyle = cell.hasAttribute('s') ? numberStyle(cell.getAttribute('s')) : null;
        // A numeric cell without an explicit style can carry row/column formatting.
        // Review any temporal/unknown candidate rather than guessing an inheritance
        // rule and silently accepting its date serial as a financial amount.
        const candidates = explicitStyle === null ? [numberStyle('0'), ...columnStyles[column], ...(!['0', 'false'].includes(customFormat) && rowStyle ? [rowStyle] : [])] : [explicitStyle];
        const numberType = candidates.includes('date') ? 'd' : candidates.includes('unknown') ? 'unknown-number-format' : 'number';
        const formula = child(cell, 'f')?.textContent ?? null;
        const raw = child(cell, 'v')?.textContent ?? '';
        let value = raw;
        if (type === 's') {
          const index = Number(raw);
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(index) || !Object.hasOwn(shared, index)) throw invalid('testo condiviso non valido.');
          value = shared[index];
        } else if (type === 'inlineStr') value = richText(child(cell, 'is') || cell);
        if (value.length > 5000) throw invalid('testo di cella troppo lungo.');
        cells[column] = { reference, value, type: ['s', 'inlineStr', 'str'].includes(type) ? 'text' : type === 'n' ? numberType : type, formula };
      }
      if (Object.values(cells).some(cell => cell.value !== '' || cell.formula !== null)) rows.push({ number, cells });
    }
    rows.sort((left, right) => left.number - right.number);
    result.push({ name, hidden: ['hidden', 'veryHidden'].includes(sheet.getAttribute('state')), rows });
  }
  return { kind: 'opening-xlsx', sheets: result };
}
