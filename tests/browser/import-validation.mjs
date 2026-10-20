import assert from 'node:assert/strict';
import { makeWorkbook, numeric as n } from '../helpers/xlsx.mjs';

const headers = ['CRIPTOVALUTA', 'TOTALE CRIPTO', 'CRIPTO/EURO', 'EURO'];
const workbook = (asset = 'ALFA', quantity = n('3'), cost = n('12'), transformXml) => makeWorkbook([
  { name: 'Prova ' + asset, rows: [['CRIPTOVALUTA'], [], headers, [asset, quantity, cost, n('36')]], transformXml }
], { sharedStrings: true });
const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function verifyImportValidation({ page, label, activateButton, importDataset, downloadSession, sourceCsv, exchangeSourceRow, results }) {
  const tap = locator => activateButton(page, locator, 'import-validation-' + label);
  const modal = page.locator('#opening-import-dialog');
  const review = page.locator('#opening-review');
  const confirm = page.locator('#confirm-opening-import');
  const status = page.locator('#opening-status');
  const initial = { version: 1, openingDate: '2025-01-01', initialLots: [
    { id: 'untouched', asset: 'ORIGINALE', acquiredOn: '2024-02-01', order: 1, quantity: '1', unitCost: '8' }
  ], transactions: [], carryLosses: [] };
  await importDataset(page, initial, '', 0);
  const original = await downloadSession(page, 'import-validation-' + label + '-before');
  await tap(page.locator('[data-view="lots"]'));
  const open = () => tap(page.locator('#opening-import-button'));
  const close = async () => {
    await tap(modal.getByRole('button', { name: 'Annulla', exact: true }));
    await modal.waitFor({ state: 'hidden' });
  };
  const select = (bytes, name = 'validation.xlsx') => page.locator('#opening-file').setInputFiles({ name, mimeType, buffer: bytes });
  const assertBlocked = async pattern => {
    await page.waitForFunction(() => document.getElementById('opening-status').classList.contains('form-error')
      && !document.getElementById('opening-status').hidden);
    assert.match(await status.textContent(), pattern);
    assert.equal(await confirm.isDisabled(), true);
  };
  const configure = async () => {
    await page.locator('#opening-snapshot-date').fill('2024-12-31');
    await page.locator('#opening-timing').selectOption('end');
    for (const id of ['opening-costs-confirm', 'opening-replace-confirm']) await tap(page.locator('#' + id));
  };

  // A logical TRUE has a cached raw value "1" but is never a financial quantity.
  await open();
  await select(workbook('ALFA', { type: 'b', value: '1' }));
  await assertBlocked(/quantità.*valori logici/);
  assert.equal(await review.isVisible(), false);
  await select(workbook('ALFA', n('3'), { type: 'b', value: '1' }));
  await review.waitFor({ state: 'visible' });
  assert.match(await page.locator('#opening-source-summary').textContent(), /intestazioni alla riga 3/);
  const asset = review.locator('[data-excel-row="4"]');
  assert.equal(await asset.getByLabel('Prezzo medio storico stimato (€)', { exact: true }).inputValue(), '');
  await page.locator('#opening-value-meaning').selectOption('unit_cost');
  await tap(asset.getByRole('button', { name: 'Usa CRIPTO/EURO come costo di questo lotto', exact: true }));
  await assertBlocked(/Inserisci manualmente il costo verificato/);
  assert.equal(await asset.getByLabel('Costo unitario fiscale documentato (€)', { exact: true }).inputValue(), '');
  await page.locator('#opening-value-meaning').selectOption('estimated_average');
  await configure();
  assert.equal(await confirm.isDisabled(), true);
  await asset.getByLabel('Prezzo medio storico stimato (€)', { exact: true }).fill('12');
  await page.waitForFunction(() => !document.getElementById('confirm-opening-import').disabled);
  await page.locator('#opening-value-meaning').selectOption('market');
  assert.equal(await page.locator('#opening-costs-confirm').isChecked(), false, 'An attestation about estimated costs cannot confirm documented costs after the criterion changes.');
  assert.equal(await asset.getByLabel('Costo unitario fiscale documentato (€)', { exact: true }).inputValue(), '12', 'The manual correction remains available for verification.');
  await asset.getByLabel('Data originaria di acquisto', { exact: true }).fill('2024-06-01');
  assert.equal(await confirm.isDisabled(), true, 'A valid date does not replace the renewed cost attestation.');
  await tap(page.locator('#opening-costs-confirm'));
  await page.waitForFunction(() => !document.getElementById('confirm-opening-import').disabled);
  await close();

  // The XML element order is irrelevant; Excel row coordinates determine the table.
  await open();
  await select(workbook('ALFA', n('3'), n('12'), xml => xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/,
    block => '<sheetData>' + [...block.matchAll(/<row\b[\s\S]*?<\/row>/g)].map(match => match[0]).reverse().join('') + '</sheetData>')));
  await review.waitFor({ state: 'visible' });
  assert.equal(await asset.getByLabel('Quantità totale confermata di ALFA', { exact: true }).inputValue(), '3');
  await close();

  // Reader boundaries are exercised with real ZIP/OOXML and the browser DOM parser.
  const read = bytes => page.evaluate(async values => {
    const { readXlsxWorkbook } = await import('./xlsx-reader.js');
    try {
      const data = await readXlsxWorkbook(new Uint8Array(values));
      return { names: data.sheets.map(sheet => sheet.name), rowNumbers: data.sheets[0].rows.map(row => row.number) };
    } catch (error) { return { error: error.message }; }
  }, Array.from(bytes));
  const invalidSheets = [
    [xml => xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, '<sheetData>' + Array.from({ length: 10001 }, (_, index) => `<row r="${index + 1}"></row>`).join('') + '</sheetData>'), /10.000 righe/],
    [xml => xml.replace('row r="1"', 'row r="1048577"'), /numerazione delle righe/],
    [xml => xml.replace('t="n"', 't="unknown"'), /tipo di cella/],
    [xml => '<!DOCTYPE worksheet [<!ENTITY injected SYSTEM "https://example.invalid/private">]>' + xml, /dichiarazioni XML esterne/],
    [xml => xml.replace('r="B4"', 'r="A4"'), /colonna fuori limite o duplicata/]
  ];
  for (const [transform, pattern] of invalidSheets) assert.match((await read(workbook('ALFA', n('3'), n('12'), transform))).error, pattern);
  const leadingZeroSharedIndices = workbook('ALFA', n('3'), n('12'), xml => xml.replace(/t="s"><v>(\d+)<\/v>/g, 't="s"><v>000$1</v>'));
  assert.deepEqual((await read(leadingZeroSharedIndices)).rowNumbers, [1, 3, 4]);

  // Keep reads pending deterministically without sleeps or changing production code.
  await page.evaluate(() => {
    const originalRead = File.prototype.arrayBuffer;
    window.__pendingOpeningReads = {};
    File.prototype.arrayBuffer = async function () {
      if (this.name.startsWith('slow-')) await new Promise(resolve => { window.__pendingOpeningReads[this.name] = resolve; });
      const result = await originalRead.call(this);
      if (this.name.startsWith('slow-')) setTimeout(() => { window.__completedOpeningRead = this.name; }, 0);
      return result;
    };
    window.__restoreOpeningReads = () => { File.prototype.arrayBuffer = originalRead; };
  });
  const startSlow = async name => {
    await select(workbook('VECCHIA'), name);
    await page.waitForFunction(key => Boolean(window.__pendingOpeningReads[key]), name);
  };
  const release = async name => {
    await page.evaluate(key => { window.__pendingOpeningReads[key](); }, name);
    await page.waitForFunction(key => window.__completedOpeningRead === key, name);
  };
  await open();
  await startSlow('slow-first.xlsx');
  await select(workbook('ULTIMA'), 'latest.xlsx');
  await review.waitFor({ state: 'visible' });
  await release('slow-first.xlsx');
  assert.match(await page.locator('#opening-source-summary').textContent(), /Prova ULTIMA/);
  assert.equal(await review.getByLabel('Quantità totale confermata di VECCHIA', { exact: true }).count(), 0);
  await startSlow('slow-closed.xlsx');
  await close();
  await open();
  await select(workbook('RIAPERTA'), 'reopened.xlsx');
  await review.waitFor({ state: 'visible' });
  await release('slow-closed.xlsx');
  assert.match(await page.locator('#opening-source-summary').textContent(), /Prova RIAPERTA/);
  await startSlow('slow-invalid.xlsx');
  await select(Buffer.from('invalid'), 'invalid.xlsx');
  await assertBlocked(/archivio .xlsx/);
  await release('slow-invalid.xlsx');
  await assertBlocked(/archivio .xlsx/);
  assert.equal(await review.isVisible(), false);
  await close();
  await page.evaluate(() => window.__restoreOpeningReads());

  // Valid headers and amounts with one malformed metadata byte must not be repaired silently.
  await tap(page.locator('#import-button'));
  const malformed = Buffer.from(sourceCsv([exchangeSourceRow({ received_address: 'invalid-byte-marker' })]));
  const invalidByte = malformed.indexOf('invalid-byte-marker');
  assert.ok(invalidByte >= 0);
  malformed[invalidByte] = 0xff;
  await page.locator('#import-file').setInputFiles({ name: 'invalid-encoding.csv', mimeType: 'text/csv', buffer: malformed });
  await page.locator('#import-error').waitFor({ state: 'visible' });
  assert.match(await page.locator('#import-error').textContent(), /CSV.*UTF-8 valido/);
  assert.equal(await page.locator('#confirm-import').isDisabled(), true);
  const validSource = exchangeSourceRow({ received_address: 'metadati caffè' });
  await page.locator('#import-file').setInputFiles({ name: 'leading-empty-lines.csv', mimeType: 'text/csv',
    buffer: Buffer.from('\uFEFF\r\n\r\n' + sourceCsv([validSource])) });
  await page.locator('#exchange-review').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#exchange-review .exchange-review-table tbody tr').count(), 1, 'A BOM and leading empty lines cannot hide the exchange header.');
  assert.equal(await page.locator('#import-error').isVisible(), false);
  await tap(page.locator('#import-dialog').getByRole('button', { name: 'Annulla', exact: true }));
  assert.equal(await downloadSession(page, 'import-validation-' + label + '-after'), original, 'Rejected and cancelled imports must preserve the entire prior session.');
  results.push({ name: 'import-validation-' + label, logicalValuesRejected: true, manualCostCorrection: true, headerAfterTitle: true,
    rowCoordinatesRespected: true, readerBoundsVerified: true, lateReadsIsolated: true, strictUtf8: true, leadingEmptyCsvLines: true, costMeaningReconfirmed: true, originalSessionPreserved: true });
  console.log(`PASS import-validation-${label}: malformed cells and files, reader bounds, stale reads and unchanged session.`);
}
