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

const opening = overrides => ({
  title: 'Situazione iniziale al 01/01/2026',
  columns: ['Crypto', 'Quantità iniziale', 'Prezzo medio di carico (€ / unità)', 'Costo fiscale iniziale (€)'],
  rows: [['BTC', '3', '23,333333333333333333 €', '70,00 €']],
  note: 'Il prezzo medio ponderato riepiloga i lotti iniziali; le cessioni usano il costo LIFO.',
  lotTitle: 'Lotti della situazione iniziale',
  lotColumns: ['Crypto', 'Lotto / data di acquisto', 'Quantità iniziale', 'Costo unitario di carico (€)', 'Costo fiscale totale (€)'],
  lotRows: [['BTC', 'iniziale-vecchio · 01/01/2024', '1', '10 €', '10,00 €'],
    ['BTC', 'iniziale-recente · 01/07/2024', '2', '30 €', '60,00 €']],
  emptyNote: 'Nessun lotto iniziale inserito.',
  ...overrides
});
const disposalLots = overrides => ({
  title: 'Lotti ceduti in LIFO · 01/02/2026 · sequenza 1 · BTC',
  columns: ['Lotto / data di acquisto', 'Quantità ceduta', 'Costo unitario (€)', 'Costo attribuito (€)'],
  rows: [['iniziale-recente · 01/07/2024', '2', '30 €', '60,00 €'],
    ['iniziale-vecchio · 01/01/2024', '1', '10 €', '10,00 €']],
  total: 'Costo fiscale attribuito alla vendita: 70,00 €',
  verification: 'Verifica: 150,00 € − 70,00 € = Plusvalenza +80,00 €',
  ...overrides
});

test('the first page contains the opening assets and their original lot prices before the annual summary', async () => {
  const input = report({ opening: opening(), rows: [] });
  const output = await inspect(await buildPdfDocument(input));
  const firstPage = output.pages[0].texts;
  for (const text of [input.opening.title, ...input.opening.columns, ...input.opening.rows[0],
    input.opening.lotTitle, ...input.opening.lotColumns, ...input.opening.lotRows.flat()]) {
    assert.ok(firstPage.includes(text), `Opening data missing from page one: ${text}`);
  }
  assert.ok(output.texts.indexOf(input.opening.title) < output.texts.indexOf(input.summaryTitle));
  assert.ok(output.texts.indexOf('iniziale-recente · 01/07/2024') < output.texts.indexOf(input.summaryTitle));
  assert.ok(output.texts.includes(input.emptyNote), 'Opening inventory does not become a fictitious operation.');
  assert.ok(!output.texts.includes(input.columns[0]), 'A session with only opening inventory needs no empty operations table.');
});

test('an empty opening is explicitly described on page one while the existing operations are retained', async () => {
  const input = report({ opening: opening({ rows: [], lotRows: [] }) });
  const output = await inspect(await buildPdfDocument(input));
  assert.ok(output.pages[0].texts.includes(input.opening.title));
  assert.ok(output.pages[0].texts.includes(input.opening.emptyNote));
  assert.ok(output.texts.includes(input.rows[0][1]));
});

test('an opening section does not detach fiscal cards from the annual summary heading and scope', async () => {
  const input = report({ opening: opening(), rows: [], summary: Array.from({ length: 9 }, (_, index) => ({
    label: `Elemento fiscale ${index + 1}`, value: `${index + 1},00 €`
  })) });
  const output = await inspect(await buildPdfDocument(input));
  const summaryPage = output.pages.find(page => page.texts.includes(input.summaryTitle));
  assert.ok(summaryPage);
  for (const text of [...input.scope, ...input.summary.flatMap(item => [item.label, item.value])]) {
    assert.ok(summaryPage.texts.includes(text), `Fiscal summary detached from its heading: ${text}`);
  }
});

test('long opening inventory repeats its lot header and preserves every original amount', async () => {
  const initial = Array.from({ length: 120 }, (_, index) => ['BTC', `OPENING-${String(index).padStart(3, '0')} · 01/07/2024`,
    '0,000000000000000001', '123456789012345678901234567890,123456789012345678 €', '0,000000000000000001 €']);
  const input = report({ rows: [], opening: opening({ lotRows: initial }) });
  const output = await inspect(await buildPdfDocument(input));
  assert.ok(output.pages.length > 2);
  assert.ok(output.pages[0].texts.includes(input.opening.title));
  for (const expected of initial) {
    const containingPage = output.pages.find(page => page.texts.includes(expected[1]));
    assert.ok(containingPage, expected[1]);
    assert.equal(output.texts.filter(text => text === expected[1]).length, 1);
    for (const cell of expected) assert.ok(containingPage.texts.includes(cell), `Opening lot split unexpectedly: ${cell}`);
    for (const label of input.opening.lotColumns) assert.ok(containingPage.texts.includes(label));
    assert.ok(containingPage.texts.includes(input.opening.lotTitle));
  }
});

test('each sale is followed by the quantities and prices of the actual lots before the next operation', async () => {
  const first = ['01/02/2026\nSequenza 1', 'BTC-SALE-ONE', 'Vendita', '3', '0,00 €', '150,00 €', '70,00 €', 'Plusvalenza +80,00 €'];
  const next = ['01/02/2026\nSequenza 2', 'BTC-NEXT-OPERATION', 'Acquisto', '1', '0,00 €', '—', '30,00 €', 'Nessun realizzo'];
  const lots = disposalLots();
  const output = await inspect(await buildPdfDocument(report({ rows: [first, next], operationLots: [lots, null] })));
  for (const text of [...first, ...next, lots.title, ...lots.columns, ...lots.rows.flat(), lots.total]) assert.ok(output.texts.includes(text), text);
  assert.ok(output.texts.includes(lots.verification.replace('−', '-')));
  assert.ok(output.texts.indexOf(first[1]) < output.texts.indexOf(lots.title));
  assert.ok(output.texts.indexOf(lots.title) < output.texts.indexOf(lots.total));
  assert.ok(output.texts.indexOf(lots.total) < output.texts.indexOf(next[1]));
});

test('a sale consuming hundreds of lots keeps its identity, lot headers and financial verification on every continuation', async () => {
  const details = disposalLots({
    rows: Array.from({ length: 200 }, (_, index) => [`SOLD-LOT-${String(index).padStart(3, '0')} · 01/07/2024`, '1', '2 €', '2,00 €']),
    total: 'Costo fiscale attribuito alla vendita: 400,00 €',
    verification: 'Verifica: 1.000,00 € − 400,00 € = Plusvalenza +600,00 €'
  });
  const input = report({ rows: [['01/02/2026\nSequenza 1', 'BTC', 'Vendita', '200', '0,00 €', '1.000,00 €', '400,00 €', 'Plusvalenza +600,00 €']],
    operationLots: [details] });
  const output = await inspect(await buildPdfDocument(input));
  assert.ok(output.pages.length > 3);
  for (const expected of details.rows) {
    const containingPage = output.pages.find(page => page.texts.includes(expected[0]));
    assert.ok(containingPage, expected[0]);
    assert.equal(output.texts.filter(text => text === expected[0]).length, 1);
    assert.ok(containingPage.texts.includes(details.title), 'Every continuation identifies the sale whose cost is explained.');
    for (const label of [...details.columns, ...input.columns]) assert.ok(containingPage.texts.includes(label), label);
    for (const cell of expected) assert.ok(containingPage.texts.includes(cell));
  }
  assert.equal(output.texts.filter(text => text === details.total).length, 1);
  assert.equal(output.texts.filter(text => text === details.verification.replace('−', '-')).length, 1);
  assert.ok(output.texts.indexOf(details.rows.at(-1)[0]) < output.texts.indexOf(details.total));
});

test('a lot heading and its column labels stay with the actual multiline first row', async () => {
  const details = disposalLots({
    columns: ['Lotto / data', 'Quantità', 'Costo unitario', 'Costo attribuito'],
    rows: [['LOT-FIRST\nAcquisto 01/01/2024\nOrigine documentata\nPorzione residua iniziale', '3', '23,333333333333333333 €', '70,00 €']]
  });
  const input = report({
    warnings: Array.from({ length: 9 }, (_, index) => `Avvertenza sintetica ${index}`),
    rows: [['01/02/2026\nSequenza 1', 'BTC', 'Vendita', '3', '0,00 €', '150,00 €', '70,00 €', 'Plusvalenza +80,00 €']],
    operationLots: [details]
  });
  const output = await inspect(await buildPdfDocument(input));
  const headingPages = output.pages.filter(page => page.texts.includes(details.title));
  assert.equal(headingPages.length, 1, 'Do not leave an empty lot heading at the foot of the previous page.');
  for (const text of [...details.columns, ...details.rows[0]]) assert.ok(headingPages[0].texts.includes(text), text);
  assert.ok(!output.pages[0].texts.includes(details.title), 'The full heading and first row move together to the next page.');
});

test('very long opening labels continue without truncating text or losing their table context', async () => {
  const longLabel = 'T'.repeat(5000);
  const input = report({ rows: [], opening: opening({ lotRows: [[longLabel, 'long-label-lot · 01/01/2024', '1', '10 €', '10,00 €']] }) });
  const output = await inspect(await buildPdfDocument(input));
  const parts = output.texts.filter(text => /^[T\n]+$/.test(text));
  assert.equal(parts.join('').replaceAll('\n', ''), longLabel);
  for (const page of output.pages.filter(page => page.texts.some(text => /^[T\n]+$/.test(text)))) {
    assert.ok(page.texts.includes(input.opening.lotTitle));
    for (const label of input.opening.lotColumns) assert.ok(page.texts.includes(label));
  }
});

test('incomplete opening lots or detached sale details fail explicitly', async () => {
  await assert.rejects(buildPdfDocument(report({ opening: opening({ lotRows: [['BTC']] }) })), /lotto con colonne incomplete/);
  await assert.rejects(buildPdfDocument(report({ operationLots: [] })), /dettagli dei lotti devono corrispondere/);
  await assert.rejects(buildPdfDocument(report({ operationLots: [disposalLots({ rows: [['lot-only']] })] })), /lotto con colonne incomplete/);
});
