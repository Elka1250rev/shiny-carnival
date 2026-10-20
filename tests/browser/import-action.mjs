import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseCsv } from '../../dist/csv.js';
import { calculate } from '../../dist/engine.js';

// A long source preview must explain a disabled action where the user reaches it.
export async function verifyImportAction({ page, label, activateButton, openExchangeReview, exchangeSourceRow, downloadSession, results, artifacts }) {
  const tap = locator => activateButton(page, locator, 'import-action-' + label);
  const modal = page.locator('#import-dialog');
  const review = page.locator('#exchange-review');
  const status = page.locator('#import-action-status');
  const showIssues = page.locator('#import-show-issues');
  const confirm = page.locator('#confirm-import');
  const errors = review.locator('.exchange-review-errors');
  const source = Array.from({ length: 450 }, (_, index) => exchangeSourceRow({
    id: 'synthetic-long-import-' + index, datetime_tz_CET: '2025-03-02-14:19:08', type: 'Buy',
    label: '', market_model_type: 'SPOT', order_type: 'MARKET',
    sent_amount: '10', sent_currency: 'EUR', sent_value_EUR: '10', sent_address: '',
    received_amount: '1', received_currency: 'ALFA', received_value_EUR: '10', received_address: '',
    fee_amount: '0', fee_currency: '', fee_value_EUR: '0'
  }));
  const inViewport = locator => locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    const viewport = visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || innerWidth);
    const bottom = top + (viewport?.height || innerHeight);
    return box.width > 0 && box.height > 0 && box.left >= left - 1 && box.right <= right + 1
      && box.top >= top - 1 && box.bottom <= bottom + 1;
  });
  const lastPage = async () => {
    const next = review.getByRole('button', { name: 'Pagina successiva', exact: true });
    for (let number = 2; number <= 9; number += 1) {
      await tap(next);
      await page.waitForFunction(expected => document.querySelector('.exchange-review-page-info')?.textContent.includes(`pagina ${expected} di 9`), number);
    }
    assert.equal(await next.isDisabled(), true);
    assert.equal(await review.locator('.exchange-review-table tbody tr').count(), 50);
    assert.match(await review.locator('.exchange-review-table tbody tr').last().textContent(), /^451/);
  };
  const bottom = () => modal.evaluate(dialog => { dialog.scrollTop = dialog.scrollHeight; });
  const focusIs = selector => page.waitForFunction(value => document.activeElement === document.querySelector(value), selector);

  await openExchangeReview(page, source);
  await page.waitForFunction(() => document.querySelectorAll('#exchange-review .exchange-review-errors li').length === 3
    && !document.getElementById('import-show-issues').hidden);
  assert.equal(await confirm.isDisabled(), true, 'Viewing all source pages cannot replace the three required confirmations.');
  await lastPage();
  await bottom();
  assert.match(await status.textContent(), /Importazione bloccata: 3 verifiche da completare/);
  assert.equal(await showIssues.textContent(), 'Mostra verifiche');
  assert.equal(await inViewport(status), true, 'The reason for the disabled action must remain visible at the bottom of a long preview.');
  assert.equal(await inViewport(showIssues), true, 'A real navigation control must be reachable beside the disabled action.');
  await page.screenshot({ path: resolve(artifacts, 'import-action-' + label + '-blocked.png') });
  await tap(showIssues);
  await focusIs('#exchange-review .exchange-review-errors');
  assert.equal(await inViewport(errors), true, 'Showing the issues must reveal and focus their actual content.');

  await review.getByLabel('Come inserire le operazioni', { exact: true }).selectOption('replace');
  await page.waitForFunction(() => {
    const text = document.querySelector('#exchange-review .exchange-review-errors')?.textContent || '';
    return text.includes('(dateConfirmed)') && !text.includes('(mode)');
  });
  await tap(review.getByLabel(/^Confermo data e ora come riportate nel CSV/));
  await page.waitForFunction(() => {
    const text = document.querySelector('#exchange-review .exchange-review-errors')?.textContent || '';
    return text.includes('(grossValuesConfirmed)') && !text.includes('(dateConfirmed)');
  });
  await tap(review.getByLabel(/^Confermo le quantità nette effettive del CSV/));
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled
    && document.getElementById('import-show-issues').hidden);
  assert.match(await status.textContent(), /Pronto: 450 operazioni totali\. Puoi importare e ricalcolare/);
  assert.equal(await showIssues.isVisible(), false);
  // The preview remains on page nine while the choices above it are completed.
  assert.match(await review.locator('.exchange-review-page-info').textContent(), /pagina 9 di 9/);
  await bottom();
  assert.equal(await inViewport(status), true);
  assert.equal(await inViewport(confirm), true, 'The enabled action must be reachable from the final source page.');
  await page.screenshot({ path: resolve(artifacts, 'import-action-' + label + '-ready.png') });
  await confirm.evaluate(button => {
    window.__importActionClick = null;
    button.addEventListener('click', event => {
      window.__importActionClick = { trusted: event.isTrusted, target: event.currentTarget.id };
    }, { once: true });
  });
  await tap(confirm);
  await modal.waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.__importActionClick), { trusted: true, target: 'confirm-import' });
  const original = await downloadSession(page, 'import-action-' + label + '-applied');
  const snapshot = parseCsv(original);
  assert.equal(snapshot.transactions.length, 450, 'The action must apply every row, including those outside the visible source page.');
  for (const [index, transaction] of snapshot.transactions.entries()) {
    assert.deepEqual(transaction.source.values, source[index], 'All original source fields must survive the import.');
    assert.equal(transaction.order, index + 1, 'Equal timestamps must retain source row ordering.');
  }
  const computed = calculate(snapshot, 2025);
  assert.equal(computed.holdings.find(holding => holding.asset === 'ALFA').quantity, '450');
  assert.equal(computed.holdings.find(holding => holding.asset === 'ALFA').cost, '4500');

  await tap(page.locator('#import-button'));
  assert.equal(await status.textContent(), 'Scegli un file CSV per iniziare.');
  assert.equal(await showIssues.isVisible(), false);
  await page.locator('#import-file').setInputFiles({ name: 'invalid-synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from('invalid,synthetic,headers\nnot,a,session') });
  await page.locator('#import-error').waitFor({ state: 'visible' });
  assert.equal(await confirm.isDisabled(), true);
  assert.match(await status.textContent(), /Importazione bloccata: il file contiene errori da correggere/);
  assert.equal(await showIssues.isVisible(), true);
  await bottom();
  await tap(showIssues);
  await focusIs('#import-error');
  assert.equal(await inViewport(page.locator('#import-error')), true);
  await tap(modal.getByRole('button', { name: 'Annulla', exact: true }));
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await downloadSession(page, 'import-action-' + label + '-after-invalid'), original,
    'A rejected file and cancellation must preserve all 450 imported transactions.');
  await tap(page.locator('#import-button'));
  assert.equal(await status.textContent(), 'Scegli un file CSV per iniziare.');
  assert.equal(await confirm.isDisabled(), true);
  assert.equal(await showIssues.isVisible(), false, 'Reopening cannot retain a navigation target or issue from the previous file.');
  assert.equal(await page.locator('#import-error').isVisible(), false);
  await tap(modal.getByRole('button', { name: 'Annulla', exact: true }));
  await modal.waitFor({ state: 'hidden' });
  results.push({ name: 'import-action-' + label, sourceRows: 450, sourcePages: 9,
    blockedReasonVisibleAtFooter: true, issuesNavigationAndFocus: true, trustedImportClick: true,
    everySourceRowImported: true, invalidFileExplained: true, cancelledImportPreservesSession: true, reopenedStateReset: true });
  console.log(`PASS import-action-${label}: 450-row preview, visible blocked status, issue navigation, trusted import and preserved session.`);
}
