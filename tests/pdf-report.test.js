import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../dist/engine.js';
import { buildPdfReport, buildPdfReportData } from '../dist/pdf-report.js';

const dataset = overrides => ({ version: 1, openingDate: '2025-01-01', initialLots: [], transactions: [], carryLosses: [], ...overrides });
const buy = (id, overrides) => ({ id, date: '2025-02-01', order: 1, type: 'acquisto', asset: 'BTC', quantity: '1', unitPrice: '100', fees: '0', ...overrides });
const sell = (id, overrides) => buy(id, { type: 'vendita', ...overrides });
const lot = (id, overrides) => ({ id, asset: 'BTC', acquiredOn: '2024-01-01', order: 1, quantity: '1', unitCost: '100', ...overrides });
const report = (input, year = 2025) => buildPdfReport(calculate(input, year), input.openingDate);
const operationRows = html => [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].flatMap(match => [...match[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row => row[1]));

test('the PDF report separates acquisition fees from the fiscal purchase basis', () => {
  const html = report(dataset({ transactions: [buy('purchase', { quantity: '2', unitPrice: '100', fees: '3' })] }));
  const [row] = operationRows(html);
  assert.match(row, /01\/02\/2025<br><small>Sequenza 1<\/small>/);
  assert.match(row, /<td>BTC<\/td><td>Acquisto<\/td>/);
  assert.match(row, /<td class="numeric">2<\/td>/);
  assert.match(row, /<td class="numeric">3,00 €<\/td><td class="numeric">—<\/td><td class="numeric">200,00 €<\/td><td class="numeric">Nessun realizzo<\/td>/);
  assert.match(html, /<dt>Plusvalenze<\/dt><dd>0,00 €<\/dd>/);
});

test('sale rows use gross fiscal proceeds and distinguish gains, losses and break-even', () => {
  const html = report(dataset({
    initialLots: [lot('btc'), lot('eth', { asset: 'ETH' }), lot('nespole', { asset: 'NESPOLE' })],
    transactions: [
      sell('gain', { unitPrice: '130', fees: '1' }),
      sell('loss', { asset: 'ETH', order: 2, unitPrice: '90', fees: '2' }),
      sell('even', { asset: 'NESPOLE', order: 3 })
    ]
  }));
  const [gain, loss, even] = operationRows(html);
  assert.match(gain, /130,00 €<\/td><td class="numeric">100,00 €<\/td><td class="numeric">Plusvalenza \+30,00 €/);
  assert.match(loss, /90,00 €<\/td><td class="numeric">100,00 €<\/td><td class="numeric">Minusvalenza −10,00 €/);
  assert.match(even, /Pareggio 0,00 €/);
  assert.match(html, /<dt>Risultato netto<\/dt><dd>20,00 €<\/dd>/);
  assert.match(html, /<dt>Imposta sostitutiva stimata<\/dt><dd>5,20 €<\/dd>/);
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
  assert.match(sale, /150,00 €<\/td><td class="numeric">70,00 €<\/td><td class="numeric">Plusvalenza \+80,00 €/);
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
  assert.match(operationRows(html)[1], /123\.456\.789\.012\.345\.678\.901\.234\.567\.890,12 €/);
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
  const html = report(dataset({ version: 2, transactions: [
    buy('fractional', { quantity: '3', unitPrice: '0', totalEur: '300.014999999999999999' }),
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
    version: 2, carryLosses: [{ id: 'carry', year: 2021, amount: '0.01' }],
    transactions: [
      buy('purchase', { quantity: '3', unitPrice: '0', totalEur: '300.014999999999999999' }),
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
  const data = buildPdfReportData(result, input.openingDate);
  assert.equal(data.rows[0][1], result.rows[0].asset);
  assert.equal(data.warnings.at(-1), result.warnings.at(-1));
  const html = buildPdfReport(result, '<script>alert(1)</script>');
  assert.match(html, /&lt;svg onload=&quot;bad\(\)&quot;&gt;&amp;&#39;/);
  assert.match(html, /&lt;img src=&quot;x&quot; onerror=&quot;bad\(\)&quot;&gt; &amp; &#39;errore&#39;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<svg|<img|<script/);
});

test('the plain report model and HTML share exact formatted values without a DOM', () => {
  const input = dataset({
    initialLots: [lot('tiny', { quantity: '0.000000000000000001', unitCost: '1' })],
    transactions: [
      sell('tiny-gain', { quantity: '0.000000000000000001', unitPrice: '1.000000000000000001' }),
      buy('unicode', { asset: '石油', order: 2, unitPrice: '123456789012345678901234567890.12', fees: '0.005' })
    ]
  });
  const result = calculate(input, 2025);
  const data = buildPdfReportData(result, input.openingDate);
  const html = buildPdfReport(result, input.openingDate);
  assert.deepEqual(Object.keys(data), [
    'title', 'header', 'summaryTitle', 'scope', 'summary', 'warnings', 'columns',
    'rows', 'notes', 'lossSections', 'recoveryNote', 'disclaimer', 'emptyNote'
  ]);
  assert.equal(data.columns.length, 8);
  assert.deepEqual(data.rows[0], [
    '01/02/2025\nSequenza 1', 'BTC', 'Vendita', '0,000000000000000001', '0,00 €',
    '0,00 €', '0,00 €', 'Plusvalenza inferiore a 0,005 €'
  ]);
  assert.equal(data.rows[1][1], '石油');
  assert.equal(data.rows[1][6], '123.456.789.012.345.678.901.234.567.890,12 €');
  for (const row of data.rows) {
    assert.equal(row.length, data.columns.length);
    for (const value of row.slice(1)) assert.ok(html.includes(value), value);
  }
  for (const { label, value } of data.summary) {
    assert.ok(html.includes(`<dt>${label}</dt><dd>${value}</dd>`), label);
  }
  const onlyStringLeaves = value => {
    if (value && typeof value === 'object') Object.values(value).forEach(onlyStringLeaves);
    else assert.equal(typeof value, 'string');
  };
  onlyStringLeaves(data);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
});

test('plain report arrays are detached from calculation data and include loss notes', () => {
  const input = dataset({
    carryLosses: [{ id: 'carry', year: 2024, amount: '7.5' }]
  });
  const result = calculate(input, 2026);
  const snapshot = structuredClone(result);
  const data = buildPdfReportData(result, input.openingDate);
  assert.deepEqual(data.lossSections, [{
    title: 'Minusvalenze residue al termine del 2026',
    items: ['7,50 € · origine 2024 · scadenza 2028']
  }]);
  assert.equal(data.summaryTitle, 'Riepilogo fiscale · anno 2026');
  assert.match(data.header[2], /Nessuna operazione inserita\. Operazioni: 0\./);
  data.warnings.push('Avvertenza aggiunta solo alla copia');
  data.rows.push(['modifica locale']);
  data.lossSections[0].items[0] = 'modifica locale';
  assert.deepEqual(result, snapshot);
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

test('neutral exchanges show both assets, precise quantities and the transferred historical cost', () => {
  const input = dataset({
    version: 2,
    initialLots: [lot('btc', { quantity: '3', unitCost: '10' })],
    transactions: [buy('swap', {
      type: 'permuta_neutrale', quantity: '1', unitPrice: '0', receivedAsset: 'Ξ ETH',
      receivedQuantity: '0.123456789012345678', lotDatePolicy: 'historical',
    })],
  });
  const calculated = calculate(input, 2025);
  const data = buildPdfReportData(calculated, input.openingDate);
  assert.deepEqual(data.rows[0], [
    '01/02/2025\nSequenza 1', 'BTC / Ξ ETH', 'Permuta neutrale',
    'Ceduta: 1 BTC\nRicevuta: 0,123456789012345678 Ξ ETH', '0,00 €', '—', '10,00 €',
    'Nessun realizzo; costo storico trasferito',
  ]);
  const html = buildPdfReport(calculated, input.openingDate);
  const [row] = operationRows(html);
  assert.match(row, /Nessun realizzo; costo storico trasferito/);
  assert.doesNotMatch(row, /Plusvalenza|Minusvalenza|Pareggio/);
  assert.match(html, /soltanto le permute tra cripto-attività con eguali caratteristiche e funzioni/);
  assert.match(html, /trasferiscono il costo storico ai lotti ricevuti/);
});

test('taxable exchanges use the received normal value and remain distinct from neutral exchanges', () => {
  const input = dataset({
    version: 2, initialLots: [lot('btc')],
    transactions: [
      buy('taxable-swap', { type: 'permuta_imponibile', unitPrice: '0', receivedAsset: 'ETH', receivedQuantity: '2', totalEur: '150' }),
      sell('following-sale', { date: '2025-02-02', asset: 'ETH', unitPrice: '100' }),
    ],
  });
  const data = buildPdfReportData(calculate(input, 2025), input.openingDate);
  assert.deepEqual(data.rows[0].slice(1), [
    'BTC / ETH', 'Permuta imponibile', 'Ceduta: 1 BTC\nRicevuta: 2 ETH',
    '0,00 €', '150,00 €', '100,00 €', 'Plusvalenza +50,00 €',
  ]);
  assert.equal(data.rows[1][6], '75,00 €');
  assert.equal(data.rows[1][7], 'Plusvalenza +25,00 €');
  assert.deepEqual(data.summary[0], { label: 'Plusvalenze', value: '75,00 €' });
  assert.ok(data.columns.includes('Corrispettivo / provento lordo (€)'));
  assert.ok(data.columns.includes('Costo fiscale / trasferito (€)'));
});

test('holding rewards are income at receipt and are separated from capital gains in the annual summary', () => {
  const input = dataset({
    version: 2, initialLots: [lot('btc', { quantity: '2' })],
    transactions: [
      sell('gain', { unitPrice: '120' }),
      buy('reward', { type: 'provento', order: 2, asset: 'ETH', quantity: '0.123456789012345678', unitPrice: '0', totalEur: '12', rewardCostEur: '0' }),
      sell('loss', { order: 3, unitPrice: '95' }),
    ],
  });
  const result = calculate(input, 2025);
  const data = buildPdfReportData(result, input.openingDate);
  assert.deepEqual(data.rows[1].slice(1), [
    'ETH', 'Provento da detenzione', '0,123456789012345678', '0,00 €', '12,00 €', '0,00 €', 'Provento imponibile 12,00 €',
  ]);
  const summary = Object.fromEntries(data.summary.map(item => [item.label, item.value]));
  assert.equal(summary.Plusvalenze, '20,00 €');
  assert.equal(summary['Proventi da detenzione'], '12,00 €');
  assert.equal(summary.Minusvalenze, '5,00 €');
  assert.equal(summary['Risultato netto'], '27,00 €');
  assert.equal(summary['Imposta sostitutiva stimata'], '7,02 €');
  const [_, reward] = operationRows(buildPdfReport(result, input.openingDate));
  assert.doesNotMatch(reward, /Plusvalenza|Minusvalenza|Pareggio/);
  assert.match(data.notes.join(' '), /non viene assunto automaticamente pari a zero/);
  assert.match(data.notes.join(' '), /non è una deduzione dal reddito ricevuto/);
});

test('documented subsequent reward basis does not reduce the gross receipt income', () => {
  const input = dataset({ version: 2, transactions: [
    buy('reward', { type: 'provento', asset: 'ETH', unitPrice: '0', totalEur: '12', rewardCostEur: '12' }),
    sell('sale', { order: 2, asset: 'ETH', unitPrice: '20' }),
  ] });
  const data = buildPdfReportData(calculate(input, 2025), input.openingDate);
  assert.equal(data.rows[0][6], '12,00 €');
  assert.equal(data.rows[0][7], 'Provento imponibile 12,00 €');
  assert.equal(data.rows[1][6], '12,00 €');
  assert.equal(data.rows[1][7], 'Plusvalenza +8,00 €');
  assert.ok(data.summary.some(item => item.label === 'Risultato netto' && item.value === '20,00 €'));
});

test('sub-cent holding rewards retain their income classification and selected-year boundaries', () => {
  const input = dataset({ version: 2, transactions: [
    buy('tiny-reward', { type: 'provento', asset: 'ETH', unitPrice: '0', totalEur: '0.000000000000000001', rewardCostEur: '0' }),
  ] });
  const result = calculate(input, 2026);
  const data = buildPdfReportData(result, input.openingDate);
  assert.equal(data.rows[0][7], 'Provento imponibile inferiore a 0,005 €');
  assert.ok(data.summary.some(item => item.label === 'Proventi da detenzione' && item.value === '0,00 €'));
  assert.equal(data.summaryTitle, 'Riepilogo fiscale · anno 2026');
  delete result.rows[0].display;
  assert.equal(buildPdfReportData(result, input.openingDate).rows[0][7], data.rows[0][7]);
});

test('euro deposits are explicitly informational and never represented as sales or break-even', () => {
  const input = dataset({ version: 2, transactions: [
    buy('fiat', { type: 'deposito_eur', asset: 'EUR', quantity: '100.25', unitPrice: '1' }),
  ] });
  const data = buildPdfReportData(calculate(input, 2025), input.openingDate);
  assert.deepEqual(data.rows[0].slice(1), ['EUR', 'Deposito EUR', '100,25', '0,00 €', '—', '—', 'Informativo, nessun reddito']);
  const [row] = operationRows(report(input));
  assert.doesNotMatch(row, /Vendita|Plusvalenza|Minusvalenza|Pareggio/);
  assert.equal(data.columns.length, 8);
  assert.equal(data.rows[0].length, 8);
});

test('received asset names are escaped in both exchange cells without changing the plain PDF model', () => {
  const input = dataset({ version: 2, initialLots: [lot('btc')], transactions: [
    buy('swap', { type: 'permuta_neutrale', unitPrice: '0', receivedAsset: 'ETH', receivedQuantity: '1', lotDatePolicy: 'exchange' }),
  ] });
  const result = calculate(input, 2025);
  result.rows[0].receivedAsset = '<svg onload="bad()">&';
  const data = buildPdfReportData(result, input.openingDate);
  assert.match(data.rows[0][1], /<svg onload="bad\(\)">&/);
  assert.match(data.rows[0][3], /Ricevuta: 1 <svg/);
  const html = buildPdfReport(result, input.openingDate);
  assert.equal((html.match(/&lt;svg onload=&quot;bad\(\)&quot;&gt;&amp;/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<svg/);
});

test('imported commissions preserve original unit, currency and every EUR digit without changing calculated costs', () => {
  const input = dataset({ version: 2, transactions: [buy('included', {
    source: { line: 2, values: {
      fee_amount: '0.0010000000000000000000001', fee_currency: 'BNB', fee_value_EUR: '0.1234567890123456789012300',
    }, decisions: { feePolicy: 'already_included' } },
  })] });
  const result = calculate(input, 2025);
  const snapshot = structuredClone(result);
  const data = buildPdfReportData(result, input.openingDate);
  assert.equal(data.columns[4], 'Commissioni');
  assert.equal(data.rows[0][4], '0,0010000000000000000000001 BNB (0,1234567890123456789012300 €) · già compresa');
  assert.equal(data.rows[0][6], '100,00 €');
  assert.equal(result.rows[0].fees, '0');
  assert.deepEqual(result, snapshot);
  assert.match(data.notes.join(' '), /commissioni manuali incidono solo sui risultati gestionali/);
  assert.match(data.notes.join(' '), /già inclusa negli importi confermati e non va applicata nuovamente/);
});

test('separate commission disposals are identified once and do not duplicate the original fee', () => {
  const original = { line: 2, values: { fee_amount: '0.0100', fee_currency: 'BNB', fee_value_EUR: '3.000' }, decisions: { feePolicy: 'separate_taxable_disposal' } };
  const input = dataset({ version: 2, initialLots: [lot('bnb', { asset: 'BNB', quantity: '0.01', unitCost: '100' })], transactions: [
    buy('purchase', { source: original }),
    sell('fee-disposal', { order: 2, asset: 'BNB', quantity: '0.01', unitPrice: '0', totalEur: '3', source: { ...structuredClone(original), derived: true } }),
  ] });
  const result = calculate(input, 2025);
  const data = buildPdfReportData(result, input.openingDate);
  assert.equal(data.rows[0][4], '0,0100 BNB (3,000 €) · cessione separata');
  assert.equal(data.rows[1][2], 'Cessione commissione');
  assert.equal(data.rows[1][4], '—');
  assert.equal(data.rows[1][5], '3,00 €');
  assert.equal(data.rows[1][7], 'Plusvalenza +2,00 €');
  assert.equal(data.rows.flat().filter(value => value.includes('0,0100 BNB')).length, 1);
  assert.equal(result.tax.gains, '2');
});

test('archived commission amounts remain plain text even with much more precision than engine inputs', () => {
  const huge = '1'.repeat(100_000);
  const input = dataset({ version: 2, transactions: [buy('source-text', {
    source: { line: 2, values: { fee_amount: huge, fee_currency: '<BNB & "fee">', fee_value_EUR: '0.000000000000000000000001' }, decisions: { feePolicy: 'already_included' } },
  })] });
  const result = calculate(input, 2025);
  const data = buildPdfReportData(result, input.openingDate);
  assert.equal(data.rows[0][4], huge + ' <BNB & "fee"> (0,000000000000000000000001 €) · già compresa');
  const html = buildPdfReport(result, input.openingDate);
  assert.ok(html.includes(huge));
  assert.match(html, /&lt;BNB &amp; &quot;fee&quot;&gt;/);
  assert.doesNotMatch(html, /<BNB/);
});

test('documented promotional acquisitions identify the confirmed cost without certifying an exemption', () => {
  const input = dataset({ version: 2, transactions: [buy('promotion', {
    unitPrice: '0', totalEur: '42.12',
    source: { line: 2, values: { fee_amount: '0', fee_currency: '', fee_value_EUR: '0' }, decisions: { rewardTreatment: 'documented_acquisition', feePolicy: 'not_applicable' } },
  })] });
  const result = calculate(input, 2025);
  const data = buildPdfReportData(result, input.openingDate);
  assert.equal(data.rows[0][2], 'Premio: costo documentato');
  assert.equal(data.rows[0][6], '42,12 €');
  assert.equal(data.rows[0][7], 'Ingresso; altri obblighi da verificare');
  assert.equal(result.tax.income, '0');
  assert.equal(result.rows[0].type, 'acquisto');
  assert.match(data.notes.join(' '), /non certifica l’esenzione del premio/);
});
