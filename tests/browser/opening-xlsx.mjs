import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { makeWorkbook, numeric as n, formula } from '../helpers/xlsx.mjs';
import { parseCsv } from '../../dist/csv.js';

const headers = ['CRIPTOVALUTA', 'TOTALE CRIPTO', 'CRIPTO/EURO', 'EURO'];
const fixture = () => makeWorkbook([{ name: 'Saldi sintetici', rows: [
  ['SALDI AL 31.12.2030 <img src=x onerror="window.__openingXss = true">'], [], headers,
  ['ALFA', n('3'), n('900'), formula('PRODUCT(B4:C4)', '2700')],
  ['BETA', n('2.000000000000000001'), n('12'), formula('PRODUCT(B5:C5)', '24.000000000000000012')],
  ['EUR', n('40'), n('1.25'), formula('PRODUCT(B6:C6)', '50')],
  ['', 'TOTALE VALORE CRIPTO IN EURO:', '', formula('SUM(D4:D6)', '2774')]
]}], { sharedStrings: true });

export async function verifyOpeningXlsx({ page, label, artifacts, activateButton, importDataset, downloadSession, openExchangeReview, exchangeSourceRow, results }) {
  const tap = locator => activateButton(page, locator, 'opening-xlsx-' + label);
  const modal = page.locator('#opening-import-dialog');
  const review = page.locator('#opening-review');
  const confirm = page.locator('#confirm-opening-import');
  const initial = { version: 1, openingDate: '2025-01-01', initialLots: [{ id: 'old-lot', asset: 'OLD', acquiredOn: '2024-01-01', order: 1, quantity: '1', unitCost: '5' }],
    transactions: [{ id: 'old-operation', asset: 'OMEGA', date: '2025-01-02', order: 1, type: 'acquisto', quantity: '1', unitPrice: '2', fees: '0' }], carryLosses: [] };
  await importDataset(page, initial, '', 1);
  const original = await downloadSession(page, 'opening-xlsx-' + label + '-before');
  await tap(page.locator('[data-view="lots"]'));

  async function upload(bytes = fixture(), name = 'synthetic-opening.xlsx') {
    await page.locator('#opening-file').setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
    await review.waitFor({ state: 'visible' });
  }
  async function openFromLots() {
    await tap(page.locator('#opening-import-button'));
    await upload();
  }
  async function configure() {
    assert.equal(await page.locator('#opening-snapshot-date').inputValue(), '', 'Every new file must explicitly ask for the date; the2030 heading must not supply it.');
    assert.equal(await page.locator('#opening-timing').inputValue(), '');
    const alfa = review.locator('[data-excel-row="4"]');
    const beta = review.locator('[data-excel-row="5"]');
    assert.equal(await page.locator('#opening-value-meaning').inputValue(), 'estimated_average');
    assert.equal(await alfa.getByLabel('Prezzo medio storico stimato (€)', { exact: true }).inputValue(), '900');
    assert.equal(await alfa.getByLabel('Data originaria di acquisto', { exact: true }).count(), 0, 'An aggregated estimate must not invent an acquisition date.');
    assert.equal(await beta.getByLabel('Quantità totale confermata di BETA', { exact: true }).inputValue(), '2.000000000000000001');
    assert.equal(await review.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.__openingXss), undefined);
    assert.equal(await confirm.isDisabled(), true);
    await page.locator('#opening-snapshot-date').fill('2024-12-31');
    await page.locator('#opening-timing').selectOption('end');
    await page.locator('#opening-value-meaning').selectOption('unit_cost');
    assert.equal(await alfa.getByLabel('Data originaria di acquisto', { exact: true }).inputValue(), '');
    assert.equal(await alfa.getByLabel('Costo unitario fiscale documentato (€)', { exact: true }).inputValue(), '');
    await tap(alfa.getByRole('button', { name: 'Usa CRIPTO/EURO come costo di questo lotto', exact: true }));
    assert.equal(await alfa.getByLabel('Costo unitario fiscale documentato (€)', { exact: true }).inputValue(), '900');
    await page.locator('#opening-value-meaning').selectOption('market');
    assert.equal(await alfa.getByLabel('Costo unitario fiscale documentato (€)', { exact: true }).inputValue(), '', 'A value confirmed as market price must not remain a copied fiscal cost.');
    assert.match(await page.locator('#opening-date-preview').textContent(), /01\/01\/2025/);
    await alfa.getByLabel('Data originaria di acquisto', { exact: true }).fill('2024-05-11');
    await alfa.getByLabel('Quantità del lotto', { exact: true }).fill('1');
    await alfa.getByLabel('Costo unitario fiscale documentato (€)', { exact: true }).fill('10');
    await tap(alfa.getByRole('button', { name: 'Aggiungi lotto di ALFA', exact: true }));
    const second = alfa.locator('.opening-lot').nth(1);
    assert.equal(await second.getByLabel('Data originaria di acquisto', { exact: true }).inputValue(), '');
    await second.getByLabel('Data originaria di acquisto', { exact: true }).fill('2024-08-19');
    await second.getByLabel('Quantità del lotto', { exact: true }).fill('1');
    await second.getByLabel('Costo unitario fiscale documentato (€)', { exact: true }).fill('20');
    await beta.getByLabel('Data originaria di acquisto', { exact: true }).fill('2024-09-12');
    await beta.getByLabel('Costo unitario fiscale documentato (€)', { exact: true }).fill('12');
    for (const id of ['opening-costs-confirm', 'opening-replace-confirm', 'opening-euro-confirm']) if (!await page.locator('#' + id).isChecked()) await tap(page.locator('#' + id));
    assert.equal(await confirm.isDisabled(), true, 'Two units in documented lots must not reconcile against a confirmed total of three.');
    assert.match(await page.locator('#opening-status').textContent(), /somma dei lotti/);
    await second.getByLabel('Quantità del lotto', { exact: true }).fill('2');
    await page.waitForFunction(() => !document.getElementById('confirm-opening-import').disabled);
  }

  await openFromLots();
  await configure();
  await tap(modal.getByRole('button', { name: 'Annulla', exact: true }));
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await downloadSession(page, 'opening-xlsx-' + label + '-cancelled'), original, 'Cancelling a fully valid opening preview must preserve the entire old session.');

  await openFromLots();
  await configure();
  await page.locator('#opening-date-preview').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(artifacts, 'opening-xlsx-' + label + '-date.png') });
  await tap(confirm);
  await modal.waitFor({ state: 'hidden' });
  const applied = parseCsv(await downloadSession(page, 'opening-xlsx-' + label + '-applied'));
  assert.equal(applied.openingDate, '2025-01-01');
  assert.equal(applied.initialLots.length, 3);
  assert.equal(applied.initialLots.some(lot => lot.asset === 'EUR' || lot.asset === 'OLD'), false);
  assert.deepEqual(applied.initialLots.filter(lot => lot.asset === 'ALFA').map(lot => [lot.acquiredOn, lot.quantity, lot.unitCost]), [['2024-05-11', '1', '10'], ['2024-08-19', '2', '20']]);
  assert.equal(applied.initialLots.find(lot => lot.asset === 'BETA').quantity, '2.000000000000000001');
  assert.deepEqual(applied.transactions, initial.transactions, 'Initial inventory must preserve existing transactions.');
  await page.screenshot({ path: resolve(artifacts, 'opening-xlsx-' + label + '-lots.png') });
  await tap(page.locator('[data-view="transactions"]'));
  await importDataset(page, applied, '', 1);
  assert.deepEqual(parseCsv(await downloadSession(page, 'opening-xlsx-' + label + '-recovered')), applied);

  // Multiple sheets require a conscious selection and new date confirmation.
  await tap(page.locator('[data-view="lots"]'));
  await tap(page.locator('#opening-import-button'));
  const multiple = makeWorkbook([{ name: 'Note', rows: [['informazioni']] }, { name: 'Posizioni', rows: [headers, ['ALFA', n('1'), n('2'), n('2')]] }]);
  await page.locator('#opening-file').setInputFiles({ name: 'multiple.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: multiple });
  await page.locator('#opening-sheet-field').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#opening-sheet').inputValue(), '');
  assert.equal(await review.isVisible(), false);
  await page.locator('#opening-sheet').selectOption('1');
  assert.equal(await page.locator('#opening-snapshot-date').inputValue(), '');
  await tap(modal.getByRole('button', { name: 'Annulla', exact: true }));

  // Opening inventory can also be imported above an existing source-CSV review.
  const csv = [exchangeSourceRow({ id: 'xlsx-followup-sale', datetime_tz_CET: '2025-07-01-12:00:00', type: 'Sell', sent_amount: '1', sent_currency: 'ALFA', sent_value_EUR: '25', received_amount: '25', received_currency: 'EUR', received_value_EUR: '25' })];
  await openExchangeReview(page, csv);
  const exchange = page.locator('#exchange-review');
  await exchange.getByLabel('Come inserire le operazioni', { exact: true }).selectOption('append');
  await page.waitForFunction(() => {
    const text = document.querySelector('#exchange-review .exchange-review-errors')?.textContent || '';
    return text.includes('(dateConfirmed)') && !text.includes('(mode)');
  });
  await tap(exchange.getByLabel(/^Confermo data e ora come riportate nel CSV/));
  await page.waitForFunction(() => {
    const text = document.querySelector('#exchange-review .exchange-review-errors')?.textContent || '';
    return text.includes('(grossValuesConfirmed)') && !text.includes('(dateConfirmed)');
  });
  await tap(exchange.getByLabel(/^Confermo le quantità nette effettive del CSV/));
  await tap(exchange.getByRole('button', { name: 'Importa situazione iniziale da Excel', exact: true }));
  await upload();
  await configure();
  await tap(confirm);
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#import-dialog').isVisible(), true);
  assert.equal(await exchange.getByLabel('Come inserire le operazioni', { exact: true }).inputValue(), 'append');
  assert.equal(await exchange.getByLabel(/^Confermo data e ora come riportate nel CSV/).isChecked(), true);
  assert.equal(await exchange.getByLabel(/^Confermo le quantità nette effettive del CSV/).isChecked(), true);
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled);
  await tap(page.locator('#confirm-import'));
  await page.locator('#import-dialog').waitFor({ state: 'hidden' });
  await page.locator('#tax-year').selectOption('2025');
  assert.match(await page.locator('#metric-net').textContent(), /5,00 €/);
  const final = parseCsv(await downloadSession(page, 'opening-xlsx-' + label + '-with-operations'));
  assert.equal(final.initialLots.length, 3); assert.equal(final.transactions.length, 2);
  assert.deepEqual(final.transactions.find(row => row.id === 'xlsx-followup-sale').source.values, csv[0]);

  // The default average-cost estimate is editable later and never invents dates.
  await tap(page.locator('[data-view="lots"]'));
  await openFromLots();
  assert.equal(await page.locator('#opening-value-meaning').inputValue(), 'estimated_average');
  await page.locator('#opening-snapshot-date').fill('2024-12-31');
  await page.locator('#opening-timing').selectOption('end');
  await review.locator('[data-excel-row="4"]').getByLabel('Prezzo medio storico stimato (€)', { exact: true }).fill('21');
  for (const id of ['opening-costs-confirm', 'opening-replace-confirm']) await tap(page.locator('#' + id));
  await page.waitForFunction(() => !document.getElementById('confirm-opening-import').disabled);
  await tap(confirm);
  await modal.waitFor({ state: 'hidden' });
  const estimated = parseCsv(await downloadSession(page, 'opening-xlsx-' + label + '-estimated'));
  assert.equal(estimated.initialLots.length, 2);
  assert.ok(estimated.initialLots.every(lot => lot.basisMethod === 'estimated_average' && lot.acquiredOn === ''));
  assert.equal(estimated.initialLots.find(lot => lot.asset === 'ALFA').unitCost, '21');
  assert.match(await page.locator('#ledger-content').textContent(), /prezzo medio storico stimato|Prezzo medio storico stimato/);
  assert.match(await page.locator('#annual-warnings').textContent(), /indicativi/);
  const alfaRow = page.locator('#ledger-content [data-record-id]:visible').filter({ hasText: 'ALFA' });
  await tap(alfaRow.getByRole('button', { name: 'Modifica', exact: true }));
  const entry = page.locator('#entry-dialog');
  assert.equal(await entry.getByLabel('Data originaria di acquisto', { exact: true }).inputValue(), '');
  await entry.getByLabel('Prezzo medio storico stimato (€)', { exact: true }).fill('19');
  await tap(entry.getByRole('button', { name: 'Salva e ricalcola', exact: true }));
  await entry.waitFor({ state: 'hidden' });
  const corrected = parseCsv(await downloadSession(page, 'opening-xlsx-' + label + '-corrected'));
  assert.equal(corrected.initialLots.find(lot => lot.asset === 'ALFA').unitCost, '19');
  assert.ok(corrected.initialLots.every(lot => lot.basisMethod === 'estimated_average' && lot.acquiredOn === ''));
  assert.match(await page.locator('#metric-net').textContent(), /6,00 €/);
  await tap(page.locator('[data-view="transactions"]'));
  await importDataset(page, corrected, '', 2);
  assert.deepEqual(parseCsv(await downloadSession(page, 'opening-xlsx-' + label + '-estimate-recovered')), corrected);
  results.push({ name: 'opening-xlsx-' + label, explicitSnapshotDate: true, explicitDayBoundary: true, originalAcquisitionDatesRequired: true,
    marketPriceNotUsedAsCost: true, splitLotsReconciled: true, precisionPreserved: true, cancellationAtomic: true, csvRoundTripVerified: true, sourceCsvReviewPreserved: true,
    estimatedAverageEditableLater: true, missingPurchaseDatesPreserved: true, estimatedStatusRecoverable: true });
  console.log(`PASS opening-xlsx-${label}: local Excel, explicit dates, split documented lots, atomic preview and CSV recovery.`);
}
