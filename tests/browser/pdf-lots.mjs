import assert from 'node:assert/strict';

const compact = value => value.replace(/\s+/gu, ' ').trim();
const occurrences = (value, text) => value.split(text).length - 1;
const base = overrides => ({ version: 1, openingDate: '2025-01-01', initialLots: [], transactions: [], carryLosses: [], ...overrides });
const initial = (id, quantity, unitCost, acquiredOn, order, asset = 'BTC') => ({ id, asset, acquiredOn, order, quantity, unitCost });
const operation = (id, date, order, type, quantity, unitPrice) => ({ id, asset: 'BTC', date, order, type, quantity, unitPrice, fees: '0' });
const multiLot = base({
  initialLots: [
    initial('initial-btc-old', '2', '10', '2024-01-01', 1),
    initial('initial-btc-recent', '1', '20', '2024-12-01', 2),
    initial('initial-unicode', '0.5', '9', '2024-01-02', 3, '石油')
  ],
  transactions: [
    operation('purchase-latest', '2025-02-01', 1, 'acquisto', '2', '30'),
    operation('sale-multi', '2025-02-02', 2, 'vendita', '3', '50'),
    operation('sale-loss', '2025-02-03', 3, 'vendita', '1', '5')
  ]
});
const manyOpeningLots = base({
  initialLots: Array.from({ length: 30 }, (_, index) => initial(
    'opening-lot-' + String(index + 1).padStart(3, '0'), '1', String(index + 1), '2024-01-01', index + 1
  )),
  transactions: [operation('sale-all-opening', '2025-03-01', 1, 'vendita', '30', '40')]
});

const operationTitle = (date, order, id) => `Lotti ceduti in LIFO · ${date} · sequenza ${order} · BTC · ${id}`;
const detailBlock = (raw, title) => {
  const start = raw.indexOf(title);
  assert.ok(start >= 0, 'Every disposal detail must identify its operation: ' + title);
  const end = raw.indexOf('Costo fiscale attribuito:', start);
  assert.ok(end > start, 'The lot details must end with their attributable fiscal cost.');
  return raw.slice(start, end);
};

// Real browser downloads plus Poppler extraction verify the visible artifact,
// including rows outside the screen filter and inventory already fully sold.
export async function verifyPdfLots({ page, label, importDataset, exportPdf }) {
  await importDataset(page, multiLot, 'BTC', 3);
  await page.locator('#tax-year').selectOption('2025');
  await exportPdf(page, 'lifo-lots-' + label, 3, 2025, pdf => {
    const first = compact(pdf.text.split('\f')[0]);
    assert.match(first, /Situazione iniziale al 01\/01\/2025/);
    assert.match(first, /Quantità iniziale/);
    assert.match(first, /Prezzo medio di carico/);
    assert.match(first, /Costo fiscale iniziale/);
    assert.match(first, /BTC/);
    assert.match(first, /石油/, 'The opening inventory must include every asset, including the one hidden by the active BTC filter.');
    const firstRaw = pdf.raw.split('\f')[0].replace(/\s+/gu, '');
    assert.ok(firstRaw.includes('13,333333333333333333'), 'The first page must display the actual weighted opening BTC unit cost, 40 / 3.');
    assert.match(first, /40,00/, 'The opening BTC basis is 2 × 10 + 1 × 20, independent of later purchases or disposals.');
    assert.match(first, /4,50/, 'The Unicode asset must retain its initial quantity and cost.');

    const raw = compact(pdf.raw);
    const gain = detailBlock(raw, operationTitle('02/02/2025', 2, 'sale-multi'));
    assert.ok(gain.indexOf('purchase-latest') < gain.indexOf('initial-btc-recent'), 'The detail must retain the actual LIFO consumption order.');
    assert.match(gain, /purchase-latest[\s\S]*?2\s+30(?:,0+)?\s*(?:€\s*)?60,00\s*€/);
    assert.match(gain, /initial-btc-recent[\s\S]*?1\s+20(?:,0+)?\s*(?:€\s*)?20,00\s*€/);
    assert.doesNotMatch(gain, /initial-btc-old/, 'A more recent lot must be consumed before the older opening lot.');
    assert.match(raw, /Costo fiscale attribuito: 80,00 €\./);
    assert.match(raw, /Verifica del risultato fiscale: 150,00 € [-−] 80,00 € = \+70,00 €\./);
    const loss = detailBlock(raw, operationTitle('03/02/2025', 3, 'sale-loss'));
    assert.match(loss, /initial-btc-old[\s\S]*?1\s+10(?:,0+)?\s*(?:€\s*)?10,00\s*€/);
    assert.doesNotMatch(loss, /purchase-latest|initial-btc-recent/);
    assert.match(raw, /Verifica del risultato fiscale: 5,00 € [-−] 10,00 € = [-−]5,00 €\./);
    assert.match(pdf.normalized, /Plusvalenza \+70,00 €/);
    assert.match(pdf.normalized, /Minusvalenza [-−]5,00 €/);
    assert.match(pdf.normalized, /16,90 €/);
  });

  await importDataset(page, manyOpeningLots, 'BTC', 1);
  await page.locator('#tax-year').selectOption('2025');
  await exportPdf(page, 'lifo-lots-continuation-' + label, 1, 2025, pdf => {
    assert.ok(pdf.pages > 2, 'Opening inventory and one sale consuming 30 lots must exercise page continuations.');
    const first = compact(pdf.text.split('\f')[0]);
    assert.match(first, /Situazione iniziale al 01\/01\/2025/);
    assert.match(first, /465,00/, 'Fully liquidated inventory must still be present in the first-page opening summary.');
    const raw = compact(pdf.raw);
    const saleTitle = operationTitle('01/03/2025', 1, 'sale-all-opening');
    const sale = detailBlock(raw, saleTitle);
    for (let number = 1; number <= 30; number += 1) {
      const id = 'opening-lot-' + String(number).padStart(3, '0');
      assert.equal(occurrences(pdf.raw, id), 2, id + ' must appear once in opening inventory and once in the consumed lots.');
      assert.ok(sale.includes(id), 'The sale detail must retain every consumed lot: ' + id);
    }
    assert.ok(sale.indexOf('opening-lot-030') < sale.indexOf('opening-lot-001'));
    assert.match(raw, /Costo fiscale attribuito: 465,00 €\./);
    assert.match(raw, /Verifica del risultato fiscale: 1\.200,00 € [-−] 465,00 € = \+735,00 €\./);
    const lotPages = pdf.text.split('\f').filter(text => /opening-lot-\d{3}/.test(text));
    assert.ok(lotPages.length > 2);
    for (const text of lotPages) {
      const content = compact(text);
      assert.match(content, /Lotti della situazione iniziale|Lotti ceduti in LIFO/,
        'Every continued lot table must repeat its context.');
      assert.match(content, /Quantità/);
      assert.match(content, /Costo/);
      if (content.includes('Lotti ceduti in LIFO')) {
        assert.match(content, /sale-all-opening/, 'A continued disposal detail must still identify the relevant operation.');
      }
    }
  });
}
