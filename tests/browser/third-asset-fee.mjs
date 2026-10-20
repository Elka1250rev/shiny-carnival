import assert from 'node:assert/strict';
import { parseCsv } from '../../dist/csv.js';
import { calculate } from '../../dist/engine.js';

// A named but zero-quantity sent leg must not conceal an actual fee debit.
export async function verifyThirdAssetFee({ page, label, activateButton, importDataset, downloadSession, openExchangeReview, exchangeSourceRow, results }) {
  const tap = locator => activateButton(page, locator, 'third-asset-fee-' + label);
  const initial = { version: 1, openingDate: '2025-01-01', initialLots: [
    { id: 'unchanged-lot', asset: 'RESIDUO', acquiredOn: '2024-01-01', order: 1, quantity: '1', unitCost: '8' }
  ], transactions: [], carryLosses: [] };
  await importDataset(page, initial, '', 0);
  const source = exchangeSourceRow({ id: 'reward-with-separate-fee', type: 'Receive', label: 'Reward', market_model_type: 'EARN',
    sent_amount: '0', sent_currency: 'GAMMA', sent_value_EUR: '0', received_amount: '1', received_currency: 'ALFA',
    received_value_EUR: '10', fee_amount: '0.1', fee_currency: 'GAMMA', fee_value_EUR: '3' });
  await openExchangeReview(page, [source]);
  const review = page.locator('#exchange-review');
  const confirm = page.locator('#confirm-import');
  const feeChoice = review.getByLabel('Trattamento documentato della commissione', { exact: true });
  await review.getByLabel('Come inserire le operazioni', { exact: true }).selectOption('replace');
  // Wait for each validation result before scrolling to the next checkbox:
  // removing an error above it can move the target outside the mobile viewport.
  await page.waitForFunction(() => {
    const errors = document.querySelector('#exchange-review .exchange-review-errors')?.textContent || '';
    return errors.includes('(dateConfirmed)') && !errors.includes('(mode)');
  });
  await tap(review.getByLabel(/^Confermo data e ora come riportate nel CSV/));
  await page.waitForFunction(() => {
    const errors = document.querySelector('#exchange-review .exchange-review-errors')?.textContent || '';
    return errors.includes('(grossValuesConfirmed)') && !errors.includes('(dateConfirmed)');
  });
  await tap(review.getByLabel(/^Confermo le quantità nette effettive del CSV/));
  await review.getByLabel('Natura documentata dei premi', { exact: true }).selectOption('holding_income');
  await review.getByLabel('Costo fiscale documentato dei token ricevuti, per le vendite future', { exact: true }).selectOption('received_value_confirmed');
  assert.equal(await feeChoice.inputValue(), '', 'The zero sent amount must still require an explicit decision about the GAMMA fee.');
  await page.waitForFunction(() => /thirdAssetFees/.test(document.querySelector('#exchange-review .exchange-review-errors')?.textContent || ''));
  assert.equal(await confirm.isDisabled(), true);

  // Both choices remain explicit. Only the separate debit needs GAMMA inventory.
  await feeChoice.selectOption('included_no_additional_movement');
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled);
  await feeChoice.selectOption('separate_taxable_disposal');
  await page.waitForFunction(() => /GAMMA: lo scarto massimo/.test(document.querySelector('.exchange-review-balance-check')?.textContent || ''));
  assert.match(await review.locator('.exchange-review-balance-check').textContent(), /GAMMA: lo scarto massimo delle quantità è 0\.1 GAMMA/);
  assert.equal(await confirm.isDisabled(), true, 'An unfunded separate fee must block the import.');
  await tap(review.getByRole('button', { name: 'Aggiungi un lotto di GAMMA', exact: true }));
  const entry = page.locator('#entry-dialog');
  await entry.waitFor({ state: 'visible' });
  assert.equal(await entry.getByLabel('Crypto / identificatore', { exact: true }).inputValue(), 'GAMMA');
  for (const name of ['Data originaria di acquisto', 'Quantità residua all’apertura', 'Costo unitario fiscale documentato (€)']) {
    assert.equal(await entry.getByLabel(name, { exact: true }).inputValue(), '', 'A diagnostic fee shortfall must not fabricate opening data.');
  }
  await entry.getByLabel('Data originaria di acquisto', { exact: true }).fill('2024-06-01');
  await entry.getByLabel('Quantità residua all’apertura', { exact: true }).fill('1');
  await entry.getByLabel('Costo unitario fiscale documentato (€)', { exact: true }).fill('2');
  await tap(entry.getByRole('button', { name: 'Salva e ricalcola', exact: true }));
  await entry.waitFor({ state: 'hidden' });
  assert.equal(await feeChoice.inputValue(), 'separate_taxable_disposal', 'Adding the documented lot must preserve the fee decision.');
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled);
  await tap(confirm);
  await page.locator('#import-dialog').waitFor({ state: 'hidden' });

  const imported = parseCsv(await downloadSession(page, 'third-asset-fee-' + label + '-applied'));
  assert.deepEqual(imported.initialLots.find(lot => lot.id === 'unchanged-lot'), initial.initialLots[0]);
  assert.equal(imported.transactions.length, 2);
  const reward = imported.transactions.find(row => row.id === source.id);
  const fee = imported.transactions.find(row => row.source?.derived === true);
  assert.equal(reward.type, 'provento');
  assert.equal(reward.quantity, '1', 'The net ALFA reward must not be reduced by a different asset fee.');
  assert.equal(fee.type, 'vendita');
  assert.equal(fee.asset, 'GAMMA');
  assert.equal(fee.quantity, '0.1');
  assert.equal(fee.totalEur, '3');
  assert.ok(fee.order > reward.order);
  for (const transaction of imported.transactions) {
    assert.deepEqual(transaction.source.values, source);
    assert.equal(transaction.source.decisions.feePolicy, 'separate_taxable_disposal');
  }
  const result = calculate(imported, 2025);
  assert.equal(result.holdings.find(holding => holding.asset === 'GAMMA').quantity, '0.9');
  assert.equal(result.holdings.find(holding => holding.asset === 'ALFA').quantity, '1');
  assert.equal(result.rows.find(row => row.id === fee.id).costBasis, '0.2');
  assert.equal(result.rows.find(row => row.id === fee.id).fiscalResult, '2.8');
  await importDataset(page, imported, '', 2);
  assert.deepEqual(parseCsv(await downloadSession(page, 'third-asset-fee-' + label + '-recovered')), imported);
  results.push({ name: 'third-asset-fee-' + label, zeroSentLegDoesNotHideFee: true, explicitFeeDecision: true,
    missingFeeInventoryShown: true, originalSourcePreserved: true, exactFeeDebit: true, csvRecovery: true });
  console.log(`PASS third-asset-fee-${label}: explicit fee choice, inventory diagnostic, separate debit and CSV recovery.`);
}
