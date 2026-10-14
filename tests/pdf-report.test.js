import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../dist/engine.js';
import { buildPdfReport } from '../dist/pdf-report.js';

const dataset = overrides => ({ version: 1, openingDate: '2025-01-01', initialLots: [], transactions: [], carryLosses: [], ...overrides });
const buy = (id, overrides) => ({ id, date: '2025-02-01', order: 1, type: 'acquisto', asset: 'BTC', quantity: '1', unitPrice: '100', fees: '0', ...overrides });
const sell = (id, overrides) => buy(id, { type: 'vendita', ...overrides });
const lot = (id, overrides) => ({ id, asset: 'BTC', acquiredOn: '2024-01-01', order: 1, quantity: '1', unitCost: '100', ...overrides });
const report = (input, year = 2025) => buildPdfReport(calculate(input, year), input.openingDate);
const operationRows = html => [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].flatMap(match => [...match[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row => row[1]));

test('the PDF report identifies purchases as unrealized and includes acquisition fees', () => {
  const html = report(dataset({ transactions: [buy('purchase', { quantity: '2', unitPrice: '100', fees: '3' })] }));
  const [row] = operationRows(html);
  assert.match(row, /01\/02\/2025<br><small>Sequenza 1<\/small>/);
  assert.match(row, /<td>BTC<\/td><td>Acquisto<\/td>/);
  assert.match(row, /<td class="numeric">2<\/td>/);
  assert.match(row, /<td class="numeric">3,00 €<\/td><td class="numeric">—<\/td><td class="numeric">203,00 €<\/td><td class="numeric">Nessun realizzo<\/td>/);
  assert.match(html, /<dt>Plusvalenze<\/dt><dd>0,00 €<\/dd>/);
});

test('sale rows distinguish gains, losses and break-even after commissions', () => {
  const html = report(dataset({
    initialLots: [lot('btc'), lot('eth', { asset: 'ETH' }), lot('nespole', { asset: 'NESPOLE' })],
    transactions: [
      sell('gain', { unitPrice: '130', fees: '1' }),
      sell('loss', { asset: 'ETH', order: 2, unitPrice: '90', fees: '2' }),
      sell('even', { asset: 'NESPOLE', order: 3 })
    ]
  }));
  const [gain, loss, even] = operationRows(html);
  assert.match(gain, /129,00 €<\/td><td class="numeric">100,00 €<\/td><td class="numeric">Plusvalenza \+29,00 €/);
  assert.match(loss, /88,00 €<\/td><td class="numeric">100,00 €<\/td><td class="numeric">Minusvalenza −12,00 €/);
  assert.match(even, /Pareggio 0,00 €/);
  assert.match(html, /<dt>Risultato netto<\/dt><dd>17,00 €<\/dd>/);
  assert.match(html, /<dt>Imposta sostitutiva stimata<\/dt><dd>4,42 €<\/dd>/);
});

test('sale results use fiscal LIFO rather than the moving weighted average', () => {
  const html = report(dataset({
    initialLots: [lot('initial', { quantity: '2', unitCost: '10' })],
    transactions: [
      buy('purchase', { quantity: '2', unitPrice: '30', fees: '2' }),
      sell('sale', { date: '2025-02-02', quantity: '3', unitPrice: '50', fees: '3' })
    ]
  }));
  const [, sale] = operationRows(html);
  assert.match(sale, /147,00 €<\/td><td class="numeric">72,00 €<\/td><td class="numeric">Plusvalenza \+75,00 €/);
  assert.doesNotMatch(sale, /85,50/);
});

test('the report keeps every operation while the summary uses only the selected year', () => {
  const html = report(dataset({
    initialLots: [lot('btc', { quantity: '2' }), lot('eth', { asset: 'ETH', unitCost: '10' })],
    transactions: [
      sell('2025-gain', { date: '2025-02-01', unitPrice: '200' }),
      sell('2026-loss', { date: '2026-01-01', unitPrice: '50' }),
      sell('2026-gain', { date: '2026-05-01', asset: 'ETH', unitPrice: '35' })
    ]
  }), 2026);
  assert.equal(operationRows(html).length, 3);
  assert.match(html, /Periodo delle operazioni: 01\/02\/2025 – 01\/05\/2026\. Operazioni: 3\./);
  assert.match(html, /Riepilogo fiscale · anno 2026/);
  assert.match(html, /Plusvalenza \+100,00 €/);
  assert.match(html, /<dt>Plusvalenze<\/dt><dd>25,00 €<\/dd>/);
  assert.match(html, /<dt>Minusvalenze<\/dt><dd>50,00 €<\/dd>/);
  assert.match(html, /<dt>Risultato netto<\/dt><dd>−25,00 €<\/dd>/);
  assert.match(html, /<dt>Aliquota ordinaria<\/dt><dd>33%<\/dd>/);
});

test('formatting preserves eighteen decimal quantities and values beyond Number precision', () => {
  const html = report(dataset({ transactions: [
    buy('tiny', { quantity: '0.000000000000000001', unitPrice: '1' }),
    buy('huge', { date: '2025-02-02', asset: 'ETH', unitPrice: '123456789012345678901234567890.12', fees: '0.005' })
  ] }));
  assert.match(operationRows(html)[0], /<td class="numeric">0,000000000000000001<\/td>/);
  assert.match(operationRows(html)[1], /123\.456\.789\.012\.345\.678\.901\.234\.567\.890,13 €/);
  assert.doesNotMatch(html, /e\+\d/);
});

test('sub-cent results keep their exact gain or loss classification and totals', () => {
  const html = report(dataset({
    initialLots: [lot('btc', { unitCost: '1' }), lot('eth', { asset: 'ETH', unitCost: '1' })],
    transactions: [
      sell('tiny-gain', { unitPrice: '1.004' }),
      sell('tiny-loss', { asset: 'ETH', order: 2, unitPrice: '0.996' })
    ]
  }));
  const [gain, loss] = operationRows(html);
  assert.match(gain, /Plusvalenza inferiore a 0,005 €/);
  assert.match(loss, /Minusvalenza inferiore a 0,005 €/);
  assert.doesNotMatch(gain + loss, /Pareggio/);
  assert.match(html, /totali fiscali sono calcolati con la precisione del motore/);
});

test('gains and losses smaller than eighteen decimal places retain their exact classification', () => {
  const html = report(dataset({
    initialLots: [
      lot('btc', { quantity: '0.000000000000000001', unitCost: '1' }),
      lot('eth', { asset: 'ETH', quantity: '0.000000000000000001', unitCost: '1' })
    ],
    transactions: [
      sell('tiny-gain', { quantity: '0.000000000000000001', unitPrice: '1.000000000000000001' }),
      sell('tiny-loss', { asset: 'ETH', order: 2, quantity: '0.000000000000000001', unitPrice: '0.999999999999999999' })
    ]
  }));
  const [gain, loss] = operationRows(html);
  assert.match(gain, /Plusvalenza inferiore a 0,005 €/);
  assert.match(loss, /Minusvalenza inferiore a 0,005 €/);
  assert.doesNotMatch(gain + loss, /Pareggio|[+−]0,00/);
});

test('fractional LIFO amounts round once and distinguish results below and at half a cent', () => {
  const html = report(dataset({ transactions: [
    buy('fractional', { quantity: '3', unitPrice: '100', fees: '0.014999999999999999' }),
    sell('below-half', { order: 2, unitPrice: '100' }),
    buy('exact', { order: 3, asset: 'ETH', unitPrice: '100' }),
    sell('half-gain', { order: 4, asset: 'ETH', quantity: '0.5', unitPrice: '100.01' }),
    sell('half-loss', { order: 5, asset: 'ETH', quantity: '0.5', unitPrice: '99.99' })
  ] }));
  const rows = operationRows(html);
  assert.match(rows[1], /100,00 €<\/td><td class="numeric">100,00 €<\/td><td class="numeric">Minusvalenza inferiore a 0,005 €/);
  assert.match(rows[3], /Plusvalenza \+0,01 €/);
  assert.match(rows[4], /Minusvalenza −0,01 €/);
});

test('purchase costs, sale proceeds and annual totals round exact products directly to cents', () => {
  const html = report(dataset({
    initialLots: [lot('btc', { unitCost: '0' })],
    transactions: [
      buy('purchase', { asset: 'ETH', quantity: '0.3', unitPrice: '0.016666666666666666' }),
      sell('sale', { order: 2, quantity: '0.3', unitPrice: '0.016666666666666666' })
    ]
  }));
  const [purchase, sale] = operationRows(html);
  assert.match(purchase, /—<\/td><td class="numeric">0,00 €<\/td><td class="numeric">Nessun realizzo/);
  assert.match(sale, /0,00 €<\/td><td class="numeric">0,00 €<\/td><td class="numeric">Plusvalenza inferiore a 0,005 €/);
  for (const label of ['Plusvalenze', 'Risultato netto', 'Imponibile']) {
    assert.ok(html.includes(`<dt>${label}</dt><dd>0,00 €</dd>`), label);
  }
});

test('remaining and expired loss amounts avoid a second rounding after exact compensation', () => {
  const input = dataset({
    carryLosses: [{ id: 'carry', year: 2021, amount: '0.01' }],
    transactions: [
      buy('purchase', { quantity: '3', unitPrice: '100', fees: '0.014999999999999999' }),
      sell('sale', { order: 2, unitPrice: '100.01' })
    ]
  });
  const current = report(input, 2025);
  assert.match(current, /<dt>Minusvalenze pregresse utilizzate<\/dt><dd>0,01 €<\/dd>/);
  assert.match(current, /0,00 € · origine 2021 · scadenza 2025/);
  const nextYear = report(input, 2026);
  assert.match(nextYear, /Minusvalenze scadute, escluse dalla compensazione/);
  assert.match(nextYear, /0,00 € · origine 2021 · scadenza 2025/);
});

test('the report can still render calculation snapshots without display metadata', () => {
  const input = dataset({
    initialLots: [lot('initial')],
    transactions: [sell('sale', { unitPrice: '120' })],
    carryLosses: [{ id: 'carry', year: 2024, amount: '50' }]
  });
  const result = calculate(input, 2025);
  result.rows.forEach(row => { delete row.display; });
  delete result.tax.display;
  [...result.tax.remainingLosses, ...result.tax.expiredLosses].forEach(loss => { delete loss.displayAmount; });
  const html = buildPdfReport(result, input.openingDate);
  assert.match(html, /Plusvalenza \+20,00 €/);
  assert.match(html, /<dt>Plusvalenze<\/dt><dd>20,00 €<\/dd>/);
  assert.match(html, /30,00 € · origine 2024 · scadenza 2028/);
});

test('Unicode names survive and every untrusted text field is HTML-escaped', () => {
  const input = dataset({ transactions: [buy('unicode', { asset: 'Ξ BTC' })] });
  const result = calculate(input, 2025);
  assert.match(buildPdfReport(result, input.openingDate), /<td>Ξ BTC<\/td>/);
  result.rows[0].asset = '<svg onload="bad()">&\'';
  result.warnings.push('<img src="x" onerror="bad()"> & \'errore\'');
  const html = buildPdfReport(result, '<script>alert(1)</script>');
  assert.match(html, /&lt;svg onload=&quot;bad\(\)&quot;&gt;&amp;&#39;/);
  assert.match(html, /&lt;img src=&quot;x&quot; onerror=&quot;bad\(\)&quot;&gt; &amp; &#39;errore&#39;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<svg|<img|<script/);
});

test('remaining losses, expiry and actual calculation warnings are included', () => {
  const html = report(dataset({
    openingDate: '2025-06-01',
    initialLots: [lot('initial')],
    carryLosses: [{ id: 'expired', year: 2021, amount: '9.5' }, { id: 'available', year: 2024, amount: '7.5' }],
    transactions: [sell('loss', { date: '2026-01-01', unitPrice: '50' })]
  }), 2026);
  assert.match(html, /Minusvalenze residue al termine del 2026/);
  assert.match(html, /7,50 € · origine 2024 · scadenza 2028/);
  assert.match(html, /50,00 € · origine 2026 · scadenza 2030/);
  assert.match(html, /9,50 € · origine 2021 · scadenza 2025/);
  assert.match(html, /Il riepilogo annuale comprende solo le operazioni dalla data di apertura/);
  assert.match(html, /Le minusvalenze pregresse scadute sono escluse dalla compensazione/);
  assert.ok(html.indexOf('Avvertenze del calcolo') < html.indexOf('<table class="pdf-operations">'));
  assert.match(html, /persone fisiche residenti in Italia, fuori dall’attività d’impresa, in regime dichiarativo/);
  assert.match(html, /compravendite di cripto-attività ordinarie contro euro/);
});

test('an empty session produces a zero summary and explains the CSV needed to resume', () => {
  const html = report(dataset(), 2026);
  assert.equal(operationRows(html).length, 0);
  assert.match(html, /class="pdf-empty"/);
  assert.match(html, /Operazioni: 0\./);
  assert.match(html, /<dt>Imposta sostitutiva stimata<\/dt><dd>0,00 €<\/dd>/);
  assert.match(html, /non può essere importato per riprendere la sessione/);
  assert.match(html, /Esporta dati/);
  assert.match(html, /Restano ferme le responsabilità che non possono essere escluse per legge/);
});

test('rendering a full 5000-operation report neither truncates nor mutates calculation data', () => {
  const input = dataset({ transactions: [buy('purchase')] });
  const computed = calculate(input, 2025);
  const result = { ...computed, rows: Array.from({ length: 5000 }, (_, index) => ({ ...computed.rows[0], id: 'row-' + index, order: index + 1 })) };
  const snapshot = structuredClone(result);
  const freeze = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(result);
  const html = buildPdfReport(result, input.openingDate);
  assert.equal(operationRows(html).length, 5000);
  assert.match(html, /Operazioni: 5000\./);
  assert.match(html, /Sequenza 5000<\/small>/);
  assert.deepEqual(result, snapshot);
});
