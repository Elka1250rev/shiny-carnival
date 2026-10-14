import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, PDFRawStream, PDFHexString, decodePDFRawStream } from '../dist/vendor/pdf-lib.esm.min.js';
import { buildPdfDocument } from '../dist/pdf-document.js';

const row = (asset, value = '123,45 €') => ['01/02/2026\nSequenza 1', asset, 'Vendita', '1,000000000000000001', '0,00 €', value, '100,00 €', 'Plusvalenza +23,45 €'];
const report = overrides => ({
  title: 'Riepilogo delle operazioni',
  header: ['Situazione iniziale al 01/01/2026.', 'Tutte le operazioni della sessione.'],
  summaryTitle: 'Riepilogo fiscale · anno 2026',
  scope: ['Persone fisiche residenti in Italia, regime dichiarativo.'],
  summary: [{ label: 'Imposta sostitutiva stimata', value: '7,74 €' }],
  warnings: [],
  columns: ['Data / sequenza', 'Crypto', 'Tipo', 'Quantità', 'Commissioni (€)', 'Ricavo netto (€)', 'Costo acquisto / LIFO (€)', 'Risultato fiscale (€)'],
  rows: [row('BTC')],
  notes: ['Gli importi sono arrotondati ai centesimi.'],
  lossSections: [],
  recoveryNote: 'Usa “Esporta dati” per salvare il CSV ricaricabile.',
  disclaimer: { title: 'Avvertenza fiscale', text: 'Verifica i risultati prima di presentare la dichiarazione dei redditi.' },
  emptyNote: 'Non ci sono operazioni da riepilogare.',
  ...overrides
});

async function inspect(bytes) {
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  const document = await PDFDocument.load(bytes);
  const pages = document.getPages().map(page => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index, PDFRawStream))
      : [contents];
    const operators = streams.map(stream => new TextDecoder().decode(decodePDFRawStream(stream).decode())).join('\n');
    const texts = [...operators.matchAll(/\/ActualText\s*<([a-f\d]+)>/gi)].map(match => PDFHexString.of(match[1]).decodeText());
    return { page, operators, texts };
  });
  return { document, pages, texts: pages.flatMap(page => page.texts) };
}

test('a standalone landscape PDF contains the complete report and selectable Italian text', async () => {
  const input = report({
    warnings: ['Il risultato va verificato.'],
    lossSections: [{ title: 'Minusvalenze residue', items: ['10,00 € · origine 2025 · scadenza 2029'] }]
  });
  const output = await inspect(await buildPdfDocument(input));
  assert.equal(output.document.getTitle(), input.title);
  assert.equal(output.document.getAuthor(), 'CriptoConti');
  for (const { page } of output.pages) {
    assert.equal(page.getWidth(), 841.89);
    assert.equal(page.getHeight(), 595.28);
  }
  for (const text of [input.title, ...input.header, input.summaryTitle, '7,74 €', '• ' + input.warnings[0], ...input.rows[0], '• ' + input.lossSections[0].items[0], input.recoveryNote, input.disclaimer.text]) {
    assert.ok(output.texts.includes(text), `Missing PDF text: ${text}`);
  }
  assert.ok(output.pages.every(({ operators }) => /\bTj\b/.test(operators)), 'the report must contain actual text operators');
  assert.ok(output.texts.indexOf('• ' + input.warnings[0]) < output.texts.indexOf('BTC'));
});

test('long reports keep every row together and repeat the complete header on each table page', async () => {
  const input = report({ rows: Array.from({ length: 250 }, (_, index) => row(`ASSET${String(index).padStart(3, '0')}`)) });
  const { pages, texts } = await inspect(await buildPdfDocument(input));
  assert.ok(pages.length > 2);
  for (let index = 0; index < input.rows.length; index++) {
    const asset = input.rows[index][1];
    assert.equal(texts.filter(text => text === asset).length, 1, `${asset} must occur once`);
    const page = pages.find(page => page.texts.includes(asset));
    for (const cell of input.rows[index]) assert.ok(page.texts.includes(cell), `${asset} must fit on a single page`);
  }
  for (const page of pages.filter(page => page.texts.some(text => /^ASSET\d+$/.test(text)))) {
    for (const label of input.columns) assert.equal(page.texts.filter(text => text === label).length, 1);
  }
  assert.ok(pages[0].texts.includes(input.title));
  assert.ok(pages.at(-1).texts.includes(input.disclaimer.text));
});

test('wrapping preserves full precision, large amounts and identifiers without truncation', async () => {
  const quantity = '999.999.999.999.999.999.999.999.999.999,123456789012345678';
  const amount = '999.999.999.999.999.999.999.999.999.999.999.999.999.999.999.999.999.999.999.999,12 €';
  const asset = 'N'.repeat(50);
  const input = report({
    rows: [['01/02/2026\nSequenza 1', asset, 'Vendita', quantity, '0,00 €', amount, '0,00 €', 'Plusvalenza +' + amount]],
    summary: [{ label: 'Imposta sostitutiva stimata', value: amount }]
  });
  const output = await inspect(await buildPdfDocument(input));
  for (const cell of input.rows[0]) assert.ok(output.texts.includes(cell), cell);
  assert.equal(output.texts.filter(text => text === amount).length, 2);
  assert.ok(!output.texts.some(text => text.includes('…')));
});

test('empty sessions retain the summary and recovery instructions without an empty table', async () => {
  const input = report({ rows: [] });
  const { texts } = await inspect(await buildPdfDocument(input));
  assert.ok(texts.includes(input.emptyNote));
  assert.ok(texts.includes('7,74 €'));
  assert.ok(texts.includes(input.recoveryNote));
  assert.ok(!texts.includes('Data / sequenza'));
});

test('negative values normalize the unsupported minus sign without losing their sign', async () => {
  const input = report({ rows: [row('BTC', '−123,45 €')], summary: [{ label: 'Risultato netto', value: '−123,45 €' }] });
  const { texts } = await inspect(await buildPdfDocument(input));
  assert.equal(texts.filter(text => text === '-123,45 €').length, 2);
});

test('Unicode names have lossless ActualText and reuse only their cached glyph image', async () => {
  const drawn = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
  const document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return {
        getContext: () => ({
          measureText: value => ({ width: Array.from(value).length * 8, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 2 }),
          scale() {}, fillText: text => drawn.push(text)
        }),
        toDataURL: () => 'data:image/png;base64,' + png
      };
    }
  };
  const output = await inspect(await buildPdfDocument(report({ rows: [row('石油'), row('石油')] }), { document }));
  assert.equal(output.texts.filter(text => text === '石油').length, 2);
  assert.deepEqual(drawn, ['石油']);
  assert.ok(output.pages.some(({ operators }) => /\bDo\b/.test(operators)), 'Unicode fallback must draw its image');
  assert.ok(output.texts.includes('Plusvalenza +23,45 €'), 'the remainder of the report stays selectable text');
});

test('unsupported Unicode without a browser fails explicitly instead of corrupting the name', async () => {
  await assert.rejects(buildPdfDocument(report({ rows: [row('石油')] })), /browser con supporto canvas/);
});

test('an incomplete row fails instead of silently dropping financial columns', async () => {
  await assert.rejects(buildPdfDocument(report({ rows: [['BTC']] })), /colonne incomplete/);
});
