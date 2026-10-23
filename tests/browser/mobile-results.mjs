import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { calculate } from '../../dist/engine.js';
import { exportCsv, parseCsv } from '../../dist/csv.js';

const compact = value => value.replace(/\s+/gu, ' ').trim();
const money = value => Number(value).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const base = overrides => ({ version: 2, openingDate: '2025-01-01', initialLots: [], transactions: [], carryLosses: [], ...overrides });
const lot = (id, asset, quantity, unitCost, acquiredOn = '2024-01-01', order = 1) => ({ id, asset, quantity, unitCost, acquiredOn, order });
const operation = (id, overrides) => ({ id, asset: 'BTC', date: '2026-01-01', order: 1,
  type: 'acquisto', quantity: '1', unitPrice: '0', fees: '0', ...overrides });
const longAsset = 'ASSET' + 'N'.repeat(45);
const largeQuantity = '999999999999999999999999999999.123456789012345678';
const history = base({
  initialLots: [lot('btc-old', 'BTC', '2', '10'), lot('btc-new', 'BTC', '1', '20', '2024-12-01'),
    { ...lot('estimated', 'STIMATO', '1', '3'), acquiredOn: '', basisMethod: 'estimated_average' }],
  transactions: [
    operation('old-buy', { date: '2025-02-01', quantity: '2', unitPrice: '30' }),
    operation('old-sale', { date: '2025-02-02', type: 'vendita', quantity: '3', unitPrice: '50' }),
    operation('sale-loss', { type: 'vendita', unitPrice: '5' }),
    operation('neutral-swap', { date: '2026-01-02', type: 'permuta_neutrale', quantity: '0.5',
      receivedAsset: 'ETH', receivedQuantity: '1', lotDatePolicy: 'historical' }),
    operation('taxable-swap', { date: '2026-01-03', type: 'permuta_imponibile', quantity: '0.5', totalEur: '20',
      receivedAsset: 'NFT', receivedQuantity: '1' }),
    operation('holding-income', { date: '2026-01-04', asset: 'ETH', type: 'provento', totalEur: '40', rewardCostEur: '30' }),
    operation('income-sale', { date: '2026-01-05', asset: 'ETH', type: 'vendita', quantity: '0.5', unitPrice: '50' }),
    operation('large-values', { date: '2026-01-06', asset: longAsset, quantity: largeQuantity, unitPrice: '1' }),
    operation('unicode', { date: '2026-01-07', asset: '石油', quantity: '0.123456789012345678', unitPrice: '2' }),
  ],
  carryLosses: [{ id: 'prior-2024', year: 2024, amount: '100' }],
});
const manyRows = base({ transactions: Array.from({ length: 56 }, (_, index) => operation(`page-${index + 1}`, {
  asset: 'PAGINA', date: index === 0 ? '2025-12-31' : '2026-01-01', order: index + 1, unitPrice: '1',
})) });

export async function verifyMobileResults({ page, label, mobile, artifacts, results }) {
  const touches = [];
  async function activate(locator) {
    await locator.waitFor({ state: 'visible' });
    await locator.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await locator.evaluate(async element => {
      const deadline = performance.now() + 3000;
      let previous = '', stableSince = performance.now();
      while (performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
        const box = element.getBoundingClientRect();
        const current = JSON.stringify([box.x, box.y, box.width, box.height, visualViewport?.offsetTop, visualViewport?.scale]);
        if (current !== previous) { previous = current; stableSince = performance.now(); }
        else if (performance.now() - stableSince >= 150) return;
      }
      throw new Error('The control did not settle before activation.');
    });
    await locator.evaluate(element => {
      window.__uxEvents = [];
      const capture = event => window.__uxEvents.push({ type: event.type, pointerType: event.pointerType || '',
        trusted: event.isTrusted, matches: event.target === element || element.contains(event.target) });
      document.addEventListener('pointerup', capture, true);
      document.addEventListener('click', capture, true);
      window.__uxCleanup = () => { document.removeEventListener('pointerup', capture, true); document.removeEventListener('click', capture, true); };
    });
    try { if (mobile) await locator.tap(); else await locator.click(); }
    finally {
      const events = await page.evaluate(() => { window.__uxCleanup(); return window.__uxEvents; });
      assert.ok(events.some(event => event.type === 'click' && event.trusted && event.matches), 'A trusted click must reach the intended control.');
      if (mobile) assert.ok(events.some(event => event.type === 'pointerup' && event.pointerType === 'touch' && event.trusted && event.matches), 'An actual touch event must reach the intended control.');
      touches.push(...events);
    }
  }
  async function go(view) {
    if (mobile && await page.locator('#mobile-menu-toggle').getAttribute('aria-expanded') !== 'true') await activate(page.locator('#mobile-menu-toggle'));
    await activate(page.locator(`[data-view="${view}"]`));
    if (mobile) {
      assert.equal(await page.locator('#mobile-menu-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator(`[data-view="${view}"]`).getAttribute('aria-current'), 'page');
    }
  }
  async function importSession(input) {
    calculate(input, 2026);
    await activate(page.locator('#import-button'));
    await page.locator('#import-file').setInputFiles({ name: 'synthetic-mobile.csv', mimeType: 'text/csv', buffer: Buffer.from(exportCsv(input)) });
    await page.waitForFunction(() => !document.getElementById('confirm-import').disabled || !document.getElementById('import-error').hidden);
    assert.equal(await page.locator('#import-error').isVisible(), false, await page.locator('#import-error').textContent());
    await activate(page.locator('#confirm-import'));
    await page.locator('#import-dialog').waitFor({ state: 'hidden' });
  }
  async function sessionSnapshot(suffix) {
    const pending = page.waitForEvent('download');
    await activate(page.locator('#export-button'));
    const download = await pending;
    const path = resolve(artifacts, `${label}-${suffix}.csv`);
    await download.saveAs(path);
    return parseCsv(await readFile(path, 'utf8'));
  }
  const cards = page.locator('#ledger-content > .ledger-cards > .ledger-card');
  const tableRows = page.locator('#ledger-content > .ledger-table tbody > tr');
  const records = () => mobile ? cards : tableRows;
  const record = id => page.locator(`#ledger-content > ${mobile ? '.ledger-cards > .ledger-card' : '.ledger-table tbody > tr'}[data-record-id="${id}"]`);
  const checkSummary = async year => {
    const tax = calculate(history, year).tax;
    const values = { 'summary-gains': tax.display.capitalGains, 'summary-income': tax.display.income,
      'summary-losses': tax.display.losses, 'summary-used': tax.display.lossesUsed,
      'summary-taxable': tax.display.taxable, 'summary-tax': tax.tax, 'metric-net': tax.display.net, 'metric-tax': tax.tax };
    for (const [id, value] of Object.entries(values)) assert.ok(compact(await page.locator('#' + id).textContent()).includes(money(value)), `${id} must match the engine's annual result ${value}.`);
    return values;
  };
  const checkNoOverflow = async () => {
    const sizes = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll('#ledger-content > .ledger-cards > .ledger-card')].filter(element => element.getClientRects().length).map(element => ({
        id: element.dataset.recordId, width: element.clientWidth, scroll: element.scrollWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
      })) }));
    assert.ok(sizes.scroll <= sizes.width + 1, 'The page must not require horizontal scrolling: ' + JSON.stringify(sizes));
    for (const card of sizes.cards) assert.ok(card.scroll <= card.width + 1 && card.left >= 0 && card.right <= sizes.width + 1,
      'All values must fit inside the mobile card without clipping: ' + JSON.stringify(card));
  };

  await importSession(history);
  assert.equal(await page.locator('#tax-year').inputValue(), '2026');
  assert.equal(await page.locator('#show-all-years').isChecked(), false);
  assert.equal(await records().count(), 7, 'By default only the selected year appears.');
  const initialSummary = await checkSummary(2026);
  await activate(page.locator('.annual-breakdown > summary'));
  assert.equal(await page.locator('#summary-income').isVisible(), true, 'Holding income must be readable as a separate annual line.');
  assert.equal(await page.locator('.annual-summary').evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector('.ledger-panel')) & Node.DOCUMENT_POSITION_FOLLOWING)), true,
    'The annual explanation must be reachable before the operations list.');
  assert.equal(await cards.first().isVisible(), mobile);
  assert.equal(await tableRows.first().isVisible(), !mobile);
  if (mobile) {
    for (const id of ['sale-loss', 'neutral-swap', 'taxable-swap', 'holding-income', 'income-sale']) {
      const balances = record(id).locator('.card-balances');
      assert.equal(await balances.isVisible(), true, 'Before and after balances must remain immediately visible.');
      const text = compact(await balances.textContent());
      assert.match(text, /Prima/); assert.match(text, /Dopo/);
    }
    const swap = compact(await record('neutral-swap').locator('.card-balances').textContent());
    assert.match(swap, /BTC/); assert.match(swap, /ETH/);
    const sale = compact(await record('sale-loss').textContent());
    assert.match(sale, /5,00 €/); assert.match(sale, /10,00 €/); assert.match(sale, /[-−]5,00 €/);
    assert.match(sale, /LIFO|carico/);
    assert.match(compact(await record('holding-income').textContent()), /40,00 €/);
    assert.match(compact(await record('large-values').textContent()), /123456789012345678/);
    assert.match(compact(await record('unicode').textContent()), /石油/);
    await checkNoOverflow();
    const controlSizes = await page.locator('#ledger-content .ledger-cards button').evaluateAll(buttons => buttons.map(button => ({
      text: button.textContent.trim(), width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height,
    })));
    assert.ok(controlSizes.length > 0);
    for (const size of controlSizes) assert.ok(size.width >= 44 && size.height >= 44, 'Touch actions must be at least 44px: ' + JSON.stringify(size));
  }

  // A disposal must expose the actual lot basis, rather than a management average.
  await activate(record('income-sale').getByRole('button', { name: 'Dettaglio', exact: false }));
  await page.locator('#detail-dialog').waitFor({ state: 'visible' });
  assert.match(compact(await page.locator('#detail-content').textContent()), /15,00 €/);
  assert.match(compact(await page.locator('#detail-content').textContent()), /30/);
  assert.match(compact(await page.locator('#detail-content').textContent()), /LIFO|recente/);
  await activate(page.locator('#detail-dialog').getByRole('button', { name: 'Chiudi', exact: true }).last());
  await page.locator('#detail-dialog').waitFor({ state: 'hidden' });

  await activate(page.locator('#show-all-years'));
  assert.equal(await records().count(), 9);
  assert.deepEqual(await checkSummary(2026), initialSummary, 'Changing display filters must not change tax calculations.');
  await page.locator('#asset-filter').fill('BTC');
  assert.equal(await records().count(), 5);
  assert.deepEqual(await checkSummary(2026), initialSummary);
  assert.deepEqual(await sessionSnapshot('filtered-session'), parseCsv(exportCsv(history)), 'Saving a session must include every year and asset despite screen filters.');
  await activate(page.locator('#import-button'));
  await page.locator('#import-file').setInputFiles({ name: 'cancelled-session.csv', mimeType: 'text/csv', buffer: Buffer.from(exportCsv(manyRows)) });
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled);
  await activate(page.locator('#import-dialog').getByRole('button', { name: 'Annulla', exact: true }));
  assert.equal(await page.locator('#asset-filter').inputValue(), 'BTC', 'Cancelling an import must retain the existing display filter.');
  assert.equal(await page.locator('#show-all-years').isChecked(), true);
  assert.equal(await records().count(), 5);
  assert.deepEqual(await checkSummary(2026), initialSummary);
  await page.locator('#tax-year').selectOption('2025');
  if (await page.locator('#show-all-years').isChecked()) await activate(page.locator('#show-all-years'));
  assert.equal(await records().count(), 2);
  await checkSummary(2025);
  assert.ok(compact(await page.locator('#summary-income').textContent()).includes('0,00 €'), 'Zero holding income must remain an explicit annual figure.');
  assert.equal(await page.locator('#summary-income').isVisible(), true);
  await activate(record('old-sale').getByRole('button', { name: 'Dettaglio', exact: false }));
  assert.match(compact(await page.locator('#detail-content').textContent()), /80,00 €/);
  const lots = page.locator(`#detail-content ${mobile ? '.ledger-cards > .ledger-card' : '.ledger-table tbody > tr'}`);
  assert.equal(await lots.count(), 2, 'Selling three units consumes the recent purchase and only one unit of the newer opening lot.');
  assert.match(compact(await lots.first().textContent()), /30/);
  assert.match(compact(await lots.last().textContent()), /20/);
  await activate(page.locator('#detail-dialog').getByRole('button', { name: 'Chiudi', exact: true }).last());
  await page.locator('#asset-filter').fill('ETH');
  assert.equal(await records().count(), 0, 'The asset filter combines with the selected year.');
  assert.match(compact(await page.locator('#ledger-content').textContent()), /2025|filtro|corrisponde/);
  await page.locator('#asset-filter').fill('');
  await page.locator('#tax-year').selectOption('2026');
  await checkSummary(2026);

  await go('lots');
  assert.match(compact(await record('estimated').textContent()), /stimato/i);
  await checkNoOverflow();
  await go('holdings');
  assert.match(compact(await page.locator('#ledger-filter-info').textContent()), /tutte le operazioni|tutti gli anni/i);
  await checkNoOverflow();
  await go('losses');
  assert.equal(await record('prior-2024').count(), 1);
  await checkNoOverflow();
  await go('transactions');
  if (mobile) {
    await activate(page.locator('#mobile-menu-toggle'));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#mobile-menu-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#mobile-menu-toggle').evaluate(element => document.activeElement === element), true, 'Closing the menu must return keyboard focus to its button.');
  }
  await page.locator('#tax-year').focus();
  assert.equal(await page.locator('#tax-year').evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY', 'Keyboard navigation must reach another control.');
  await page.locator('#asset-filter').fill('BTC');
  await page.locator('#ledger-content').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(artifacts, `${label}-operations.png`), fullPage: true });

  await importSession(manyRows);
  assert.equal(await records().count(), 25);
  assert.equal(await page.locator('#ledger-prev').isDisabled(), true);
  await activate(page.locator('#ledger-next'));
  assert.equal(await records().count(), 25);
  assert.equal(await page.locator('#ledger-prev').isEnabled(), true);
  await activate(page.locator('#ledger-next'));
  assert.equal(await records().count(), 5);
  assert.equal(await page.locator('#ledger-next').isDisabled(), true);
  await page.locator('#asset-filter').fill('PAGINA');
  assert.equal(await records().count(), 25, 'Changing the search returns to the first page.');
  assert.equal(await page.locator('#ledger-prev').isDisabled(), true);
  await page.locator('#tax-year').selectOption('2025');
  assert.equal(await records().count(), 1);
  await page.locator('#tax-year').selectOption('2026');
  assert.equal(await records().count(), 25);
  assert.equal(await page.locator('#ledger-prev').isDisabled(), true);
  await checkNoOverflow();
  assert.deepEqual(await sessionSnapshot('paginated-session'), parseCsv(exportCsv(manyRows)), 'Pagination must not discard records during save.');

  const priorOnly = base({ transactions: [operation('prior-only', { date: '2025-01-02', unitPrice: '10' })] });
  await importSession(priorOnly);
  assert.equal(await records().count(), 0);
  assert.match(compact(await page.locator('#ledger-content').textContent()), /2026/);
  assert.match(compact(await page.locator('#ledger-content').textContent()), /tutti gli anni/i);
  const allYears = page.locator('#ledger-content').getByRole('button', { name: /tutti gli anni/i });
  await activate(allYears);
  assert.equal(await records().count(), 1);
  assert.equal(await page.locator('#show-all-years').isChecked(), true);
  await checkNoOverflow();
  const pdfPending = page.waitForEvent('download');
  await activate(page.locator('#pdf-button'));
  const pdf = await pdfPending;
  assert.equal(await pdf.failure(), null, 'The PDF control must start a real browser download.');
  const pdfPath = resolve(artifacts, `${label}-report.pdf`);
  await pdf.saveAs(pdfPath);
  assert.equal((await readFile(pdfPath)).subarray(0, 5).toString(), '%PDF-');
  results.push({ label, status: 'passed', trustedTouches: touches.filter(event => event.pointerType === 'touch').length,
    checks: ['annual figures', 'visible balances', 'LIFO disposal detail', 'year and asset filters', 'all-year session export',
      '25-row pagination', 'estimated opening costs', 'long names and values', 'responsive views', 'menu and keyboard', 'PDF download'] });
}
