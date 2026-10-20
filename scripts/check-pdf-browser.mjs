import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, devices } from 'playwright';
import { exportCsv, parseCsv } from '../dist/csv.js';
import { EXCHANGE_CSV_COLUMNS } from '../dist/exchange-csv.js';
import { verifyOpeningXlsx } from '../tests/browser/opening-xlsx.mjs';
import { verifyImportValidation } from '../tests/browser/import-validation.mjs';

// These fixtures are synthetic. No financial data or external service is used.
const project = fileURLToPath(new URL('../', import.meta.url));
const artifacts = resolve(process.env.PDF_ARTIFACT_DIR || '/tmp/criptoconti-pdf-checks');
const address = 'http://127.0.0.1:18743';
const started = Date.now();
const errors = [];
const results = [];
const importClickAttempts = [];
const viewportCheckpoints = [];
const nativeConfirmActivations = [];
const previousViewportState = new WeakMap();
const compact = value => value.replace(/\s+/gu, ' ').trim();
const withoutSpaces = value => value.replace(/\s+/gu, '');
const occurrences = (value, needle) => value.split(needle).length - 1;
const dataset = overrides => ({ version: 1, openingDate: '2025-01-01', initialLots: [], transactions: [], carryLosses: [], ...overrides });
const lot = (asset, quantity = '1', unitCost = '100') => ({ id: 'initial-' + asset, asset, acquiredOn: '2024-01-01', order: 1, quantity, unitCost });
const transaction = (id, overrides = {}) => ({ id, asset: 'BTC', date: '2026-01-02', order: 1, type: 'vendita', quantity: '1', unitPrice: '100', fees: '0', ...overrides });
const mixed = dataset({
  initialLots: [lot('BTC', '2'), lot('ETH'), lot('ZERO')],
  transactions: [
    transaction('gain-2025', { date: '2025-02-01', unitPrice: '150' }),
    transaction('gain-2026', { unitPrice: '150', fees: '5' }),
    transaction('loss-2026', { asset: 'ETH', order: 2, unitPrice: '75' }),
    transaction('break-even', { asset: 'ZERO', order: 3 }),
    transaction('unicode-purchase', { asset: '石油', order: 4, type: 'acquisto', quantity: '0.123456789012345678', unitPrice: '2' }),
  ],
});
const longHistory = dataset({ transactions: Array.from({ length: 250 }, (_, index) => transaction('long-' + index, {
  asset: 'ASSET' + String(index).padStart(3, '0'), order: index + 1, type: 'acquisto', unitPrice: '10',
})) });
const hugeQuantity = '999999999999999999999999999999.123456789012345678';
const hugeAsset = 'N'.repeat(50);
const hugeNumbers = dataset({
  initialLots: [lot(hugeAsset, hugeQuantity, '0')],
  transactions: [transaction('huge-sale', { asset: hugeAsset, quantity: hugeQuantity, unitPrice: '1' })],
});

await mkdir(artifacts, { recursive: true });
let serverOutput = '';
let serverError;
const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: project,
  env: { ...process.env, CRIPTOCONTI_PORT: '18743' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-8000); });
server.on('error', error => { serverError = error; });
let browser;

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (serverError) throw serverError;
    assert.equal(server.exitCode, null, 'The local server exited: ' + serverOutput);
    try {
      const response = await fetch(address, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* The child may still be binding its local port. */ }
    await delay(75);
  }
  throw new Error('Local server did not become ready within 10 seconds. ' + serverOutput);
}



async function checkpointViewport(page, label) {
  if (page.isClosed()) return;
  const viewport = page.viewportSize();
  const state = await page.evaluate(() => ({
    inner: { width: innerWidth, height: innerHeight }, outer: { width: outerWidth, height: outerHeight },
    client: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    body: { clientWidth: document.body?.clientWidth, clientHeight: document.body?.clientHeight,
      scrollWidth: document.body?.scrollWidth, scrollHeight: document.body?.scrollHeight },
    scroll: { x: scrollX, y: scrollY }, devicePixelRatio,
    visual: visualViewport ? { width: visualViewport.width, height: visualViewport.height,
      offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop,
      pageLeft: visualViewport.pageLeft, pageTop: visualViewport.pageTop, scale: visualViewport.scale } : null,
    activeElement: { tag: document.activeElement?.tagName, id: document.activeElement?.id },
    openDialog: [...document.querySelectorAll('dialog[open]')].map(dialog => ({ id: dialog.id,
      scrollTop: dialog.scrollTop, scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight }))
  }));
  const drift = [];
  if (viewport && Math.abs(state.inner.width - viewport.width) > 1) drift.push('innerWidth≠emulatedWidth');
  if (Math.abs(state.inner.width - state.client.width) > 1) drift.push('innerWidth≠clientWidth');
  if (state.visual && Math.abs(state.visual.offsetTop) > 1) drift.push('visualOffsetTop');
  if (state.visual && Math.abs(state.visual.offsetLeft) > 1) drift.push('visualOffsetLeft');
  if (state.visual && Math.abs(state.visual.scale - 1) > 0.01) drift.push('visualScale');
  const signature = JSON.stringify({ drift, inner: state.inner, client: state.client, visual: state.visual ? {
    width: state.visual.width, height: state.visual.height, offsetLeft: state.visual.offsetLeft,
    offsetTop: state.visual.offsetTop, scale: state.visual.scale } : null });
  const previous = previousViewportState.get(page);
  if (signature !== previous?.signature && (drift.length || previous?.drift.length)) {
    console.log('VIEWPORT ' + JSON.stringify({ label, drift, viewport, inner: state.inner, client: state.client,
      scroll: state.scroll, visual: state.visual }));
  }
  previousViewportState.set(page, { signature, drift });
  viewportCheckpoints.push({ sequence: viewportCheckpoints.length + 1, elapsedMs: Date.now() - started, label,
    url: page.url(), viewport, drift, state });
  await writeFile(resolve(artifacts, 'viewport-checkpoints.json'), JSON.stringify(viewportCheckpoints, null, 2));
}

async function recordImportClickTarget(page, source) {
  const state = await page.evaluate(() => {
    const rect = element => element ? Object.fromEntries(['x', 'y', 'top', 'right', 'bottom', 'left', 'width', 'height']
      .map(key => [key, element.getBoundingClientRect()[key]])) : null;
    const describe = element => element ? {
      tag: element.tagName, id: element.id, className: String(element.className || ''), rect: rect(element),
      scrollTop: element.scrollTop, scrollLeft: element.scrollLeft,
      clientWidth: element.clientWidth, clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight
    } : null;
    const button = document.getElementById('confirm-import');
    const box = rect(button);
    const point = box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
    return {
      viewport: { innerWidth, innerHeight, scrollX, scrollY },
      button: describe(button), dialog: describe(document.getElementById('import-dialog')),
      footer: describe(button?.parentElement), point,
      hit: point ? describe(document.elementFromPoint(point.x, point.y)) : null
    };
  });
  importClickAttempts.push({ attempt: importClickAttempts.length + 1, source, url: page.url(), state });
  await writeFile(resolve(artifacts, 'import-click-attempts.json'), JSON.stringify(importClickAttempts, null, 2));
}


// Mobile Chrome can report different layout and visual viewport coordinates.
// Native touch uses visual coordinates; DOM hit testing uses layout coordinates. Verify both
// independently and assert the trusted touch and click reach the intended button.
async function activateButton(page, button, label = 'button') {
  const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  if (!touch) { await button.click(); return; }
  await button.scrollIntoViewIfNeeded();
  await checkpointViewport(page, label + ':before-native-touch');
  assert.equal(await button.isEnabled(), true, 'Native touch must target an enabled control.');
  const target = await button.evaluate(element => {
    const box = element.getBoundingClientRect();
    const viewport = visualViewport;
    if (!viewport) return { error: 'VisualViewport is required for mobile touch verification.' };
    const left = Math.max(box.left, viewport.offsetLeft);
    const right = Math.min(box.right, viewport.offsetLeft + viewport.width);
    const top = Math.max(box.top, viewport.offsetTop);
    const bottom = Math.min(box.bottom, viewport.offsetTop + viewport.height);
    const layout = { x: (left + right) / 2, y: (top + bottom) / 2 };
    const hit = document.elementFromPoint(layout.x, layout.y);
    return {
      scale: viewport.scale, intersection: { width: right - left, height: bottom - top }, layout,
      visual: { offsetLeft: viewport.offsetLeft, offsetTop: viewport.offsetTop, width: viewport.width, height: viewport.height },
      tap: { x: layout.x - viewport.offsetLeft, y: layout.y - viewport.offsetTop },
      layoutHitMatches: hit === element || element.contains(hit),
      layoutHit: hit ? { tag: hit.tagName, id: hit.id, className: String(hit.className || '') } : null
    };
  });
  assert.equal(target.error, undefined);
  assert.ok(Math.abs(target.scale - 1) < 0.000001, 'The mobile test requires an unzoomed visual viewport.');
  assert.ok(target.intersection.width > 0 && target.intersection.height > 0, 'The control must intersect the visual viewport.');
  assert.equal(target.layoutHitMatches, true, 'The independent layout-coordinate hit test must target the intended control.');
  assert.ok(target.tap.x >= 0 && target.tap.y >= 0 && target.tap.x < target.visual.width && target.tap.y < target.visual.height,
    'The native tap must fall inside the visual viewport.');
  await button.evaluate(button => {
    window.__nativeConfirmEvents = [];
    const handler = event => {
      const hit = event.target;
      window.__nativeConfirmEvents.push({ type: event.type, pointerType: event.pointerType || '', isTrusted: event.isTrusted,
        target: hit ? { tag: hit.tagName, id: hit.id, className: String(hit.className || '') } : null,
        matchesButton: hit === button || button.contains(hit), clientX: event.clientX, clientY: event.clientY });
    };
    document.addEventListener('pointerup', handler, true);
    document.addEventListener('click', handler, true);
    window.__cleanupNativeConfirmEvents = () => {
      document.removeEventListener('pointerup', handler, true);
      document.removeEventListener('click', handler, true);
    };
  });
  let events;
  try {
    await page.touchscreen.tap(target.tap.x, target.tap.y);
    await page.waitForFunction(() => window.__nativeConfirmEvents.some(event => event.type === 'click'), null, { timeout: 3000 });
  } finally {
    events = await page.evaluate(() => {
      window.__cleanupNativeConfirmEvents?.();
      return window.__nativeConfirmEvents;
    });
    nativeConfirmActivations.push({ sequence: nativeConfirmActivations.length + 1, url: page.url(), label, target, events });
    await writeFile(resolve(artifacts, 'native-confirm-activations.json'), JSON.stringify(nativeConfirmActivations, null, 2));
    await checkpointViewport(page, label + ':after-native-touch');
  }
  assert.ok(events.some(event => event.type === 'pointerup' && event.pointerType === 'touch' && event.isTrusted && event.matchesButton),
    'The actual trusted touch pointer event must reach the intended control.');
  assert.ok(events.some(event => event.type === 'click' && event.isTrusted && event.matchesButton),
    'The actual trusted click generated by the native tap must reach the intended control.');
}

async function activateCanonicalImport(page) {
  return activateButton(page, page.locator('#confirm-import'), 'import-confirm');
}

async function importDataset(page, input, filter, filteredCount, { lineEnding = '\r\n' } = {}) {
  await checkpointViewport(page, 'import:before-emulateMedia-screen');
  await page.emulateMedia({ media: 'screen' });
  await checkpointViewport(page, 'import:after-emulateMedia-screen');
  await checkpointViewport(page, 'import:before-open-dialog');
  await page.locator('#import-button').click();
  await checkpointViewport(page, 'import:after-open-dialog');
  await page.locator('#import-file').setInputFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from(exportCsv(input).replaceAll('\r\n', lineEnding)) });
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled || !document.getElementById('import-error').hidden);
  assert.equal(await page.locator('#import-error').isVisible(), false, await page.locator('#import-error').textContent());
  await recordImportClickTarget(page, { sourceTransactions: input.transactions.length, lineEnding: JSON.stringify(lineEnding) });
  await activateCanonicalImport(page);
  await page.locator('#import-dialog').waitFor({ state: 'hidden' });
  await page.locator('#tax-year').selectOption('2026');
  await page.locator('#asset-filter').fill(filter);
  assert.equal(await page.locator('#ledger-content tbody tr').count(), filteredCount, 'The screen filter must be active before exporting all operations.');
}

async function assertDownloadInvalidated(page, reason) {
  assert.equal(await page.locator('#pdf-download-notice').isVisible(), false, reason);
  const href = await page.locator('#pdf-download-link').getAttribute('href');
  assert.ok(!href, 'A stale PDF link must not remain usable after ' + reason);
}

async function downloadSession(page, filename) {
  const pending = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const download = await pending;
  assert.equal(await download.failure(), null, 'Session CSV export must still work.');
  const path = resolve(artifacts, filename + '.csv');
  await download.saveAs(path);
  return readFile(path, 'utf8');
}

async function verifyGuide(page) {
  await checkpointViewport(page, 'guide:before-session-before');
  const session = await downloadSession(page, 'guide-session-before');
  await checkpointViewport(page, 'guide:after-session-before');
  const originalUrl = page.url();
  await checkpointViewport(page, 'guide:main-before-open');
  const newTab = page.context().waitForEvent('page');
  await page.locator('#guide-link').click();
  const guide = await newTab;
  await guide.waitForLoadState('load');
  await checkpointViewport(page, 'guide:main-after-open');
  await checkpointViewport(guide, 'guide:new-tab-after-open');
  assert.match(guide.url(), /\/guida\.html$/);
  assert.match(await guide.locator('h1').textContent(), /Come funziona/);
  const content = await guide.locator('main').textContent();
  assert.match(content, /LIFO/);
  assert.match(content, /10\.000/);
  assert.match(content, /CSV/);
  assert.equal(await guide.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'The guide must fit a mobile viewport.');
  await checkpointViewport(page, 'guide:main-before-guide-screenshot');
  await guide.screenshot({ path: resolve(artifacts, 'guida-mobile.png'), fullPage: true });
  await checkpointViewport(page, 'guide:main-after-guide-screenshot');
  await checkpointViewport(guide, 'guide:new-tab-after-screenshot');
  assert.deepEqual(await guide.evaluate(() => window.__cspViolations), [], 'The guide must preserve the Content Security Policy.');
  await checkpointViewport(page, 'guide:main-before-guide-close');
  await guide.close();
  await checkpointViewport(page, 'guide:main-after-guide-close');
  assert.equal(page.url(), originalUrl, 'Opening the guide must keep the calculator tab open.');
  assert.equal(await downloadSession(page, 'guide-session-after'), session, 'Reading the guide must preserve the current session.');
  await checkpointViewport(page, 'guide:after-session-after');
  console.log('PASS guida: mobile page opens separately and preserves the session.');
}

function inspectPdf(path) {
  const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  const info = command('pdfinfo', [path]);
  const size = info.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m);
  assert.ok(size, 'pdfinfo must expose physical page dimensions.');
  assert.ok(Math.abs(Number(size[1]) - 841.89) < 2 && Math.abs(Number(size[2]) - 595.28) < 2, 'The actual PDF must use A4 landscape.');
  const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  assert.ok(pages >= 1, 'The PDF must contain at least one page.');
  const text = command('pdftotext', ['-layout', path, '-']);
  const raw = command('pdftotext', ['-raw', path, '-']);
  const bbox = command('pdftotext', ['-bbox', path, '-']);
  const extractedPages = [...bbox.matchAll(/<page\s+width="([\d.]+)"\s+height="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/g)];
  assert.equal(extractedPages.length, pages, 'Each PDF page must be inspected for clipped words.');
  for (const [index, match] of extractedPages.entries()) {
    const [, width, height, content] = match;
    const words = [...content.matchAll(/<word\s+xMin="([\d.-]+)"\s+yMin="([\d.-]+)"\s+xMax="([\d.-]+)"\s+yMax="([\d.-]+)"[^>]*>([\s\S]*?)<\/word>/g)];
    assert.ok(words.length > 0, `Page ${index + 1} must not be blank.`);
    for (const [, xMin, yMin, xMax, yMax, word] of words) {
      assert.ok(Number(xMin) >= -1 && Number(yMin) >= -1 && Number(xMax) <= Number(width) + 1 && Number(yMax) <= Number(height) + 1,
        `PDF text crosses page ${index + 1} bounds: ${word}`);
    }
  }
  const normalized = compact(text);
  assert.match(normalized, /Riepilogo delle operazioni/);
  assert.doesNotMatch(normalized, /Il tuo portafoglio\.|La tua sessione è temporanea\.|Cerca una crypto|Importa CSV/);
  assert.doesNotMatch(text, /\uFFFD/, 'The exported PDF must not contain replacement characters.');
  return { info, pages, text, raw, bbox, normalized };
}

async function exportPdf(page, name, expectedRows, year, verify, { retry = false } = {}) {
  const originalTitle = await page.title();
  await checkpointViewport(page, name + ':before-session-before');
  const sessionBefore = await downloadSession(page, name + '-session-before');
  await checkpointViewport(page, name + ':after-session-before');
  const ledgerBefore = await page.locator('#ledger-content').innerHTML();
  const filterBefore = await page.locator('#asset-filter').inputValue();
  const expectedFilename = `criptoconti-operazioni-anno-${year}.pdf`;
  await checkpointViewport(page, name + ':before-pdf-button');
  const pending = page.waitForEvent('download', { timeout: 20000 });
  await page.locator('#pdf-button').click();
  await checkpointViewport(page, name + ':after-pdf-button');
  const download = await pending;
  await checkpointViewport(page, name + ':after-pdf-download');
  assert.equal(await download.failure(), null, 'The generated PDF must be downloadable.');
  assert.equal(download.suggestedFilename(), expectedFilename, 'The download name must identify the selected tax year.');
  const path = resolve(artifacts, name + '.pdf');
  await download.saveAs(path);
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-', 'Export must download real PDF bytes.');
  await page.waitForFunction(() => !document.getElementById('pdf-button').disabled);
  assert.equal(await page.evaluate(() => window.__printCalls), 0, 'Export must not depend on window.print, which is unavailable on Chrome Android.');
  assert.equal(await page.title(), originalTitle, 'Export must preserve the application title.');
  assert.equal(await page.locator('#ledger-content').innerHTML(), ledgerBefore, 'Export must not alter the visible operations.');
  assert.equal(await page.locator('#asset-filter').inputValue(), filterBefore, 'Export must preserve the active screen filter.');
  assert.equal(await page.locator('#pdf-download-notice').isVisible(), true, 'The user must have a visible link to download again.');
  assert.ok((await page.locator('#pdf-download-status').textContent()).trim(), 'The ready PDF must have a visible status.');
  assert.equal(await page.locator('#pdf-download-link').getAttribute('download'), expectedFilename);
  const href = await page.locator('#pdf-download-link').getAttribute('href');
  assert.match(href, /^blob:/, 'The PDF link must refer to bytes generated locally.');
  assert.equal(await page.locator('#pdf-download-link').getAttribute('target'), '_blank');
  await checkpointViewport(page, name + ':before-notice-scrollIntoView');
  await page.locator('#pdf-download-notice').scrollIntoViewIfNeeded();
  await checkpointViewport(page, name + ':after-notice-scrollIntoView');
  await checkpointViewport(page, name + ':before-screenshot');
  await page.screenshot({ path: resolve(artifacts, name + '-ui.png') });
  await checkpointViewport(page, name + ':after-screenshot');

  if (retry) {
    await checkpointViewport(page, name + ':before-retry-click');
    const repeated = page.waitForEvent('download');
    await page.locator('#pdf-download-link').click();
    await checkpointViewport(page, name + ':after-retry-click');
    const retryDownload = await repeated;
    await checkpointViewport(page, name + ':after-retry-download');
    assert.equal(await retryDownload.failure(), null);
    assert.equal(retryDownload.suggestedFilename(), expectedFilename);
    const retryPath = resolve(artifacts, name + '-retry.pdf');
    await retryDownload.saveAs(retryPath);
    assert.deepEqual(await readFile(retryPath), bytes, 'The visible retry link must download the same PDF without regenerating it.');
    assert.equal(await page.locator('#pdf-download-link').getAttribute('href'), href);
  }

  await checkpointViewport(page, name + ':before-session-after');
  const sessionAfter = await downloadSession(page, name + '-session-after');
  await checkpointViewport(page, name + ':after-session-after');
  assert.equal(sessionAfter, sessionBefore, 'PDF export must preserve every field in the recoverable session.');
  const pdf = inspectPdf(path);
  assert.match(pdf.normalized, new RegExp(`Operazioni: ${expectedRows}\\.`), 'The PDF must include all operations despite the active screen filter.');
  await Promise.all([
    writeFile(resolve(artifacts, name + '.txt'), pdf.text),
    writeFile(resolve(artifacts, name + '.bbox.html'), pdf.bbox),
  ]);
  // Preview the actual downloaded PDF, not a browser print emulation.
  execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '1600', '-png', path, resolve(artifacts, name + '-preview')], { timeout: 20000, maxBuffer: 1024 * 1024 });
  verify(pdf);
  results.push({ name, operations: expectedRows, pages: pdf.pages, bytes: bytes.length, filename: download.suggestedFilename(), retryVerified: retry });
  console.log(`PASS ${name}: downloaded ${expectedRows} operations on ${pdf.pages} PDF page(s), session preserved.`);
}

const externalRequests = [];
const contexts = [];
async function newPage(options, label) {
  const context = await browser.newContext({ ...options, locale: 'it-IT', acceptDownloads: true });
  contexts.push(context);
  context.on('request', request => {
    const url = request.url();
    if (/^https?:/u.test(url) && new URL(url).origin !== address) externalRequests.push(label + ': ' + url);
  });
  context.on('page', page => page.on('pageerror', error => errors.push(label + ': ' + error.message)));
  await context.addInitScript(() => {
    window.__printCalls = 0;
    window.__cspViolations = [];
    window.print = () => { window.__printCalls += 1; throw new Error('PDF export must not call window.print.'); };
    document.addEventListener('securitypolicyviolation', event => {
      window.__cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(address, { waitUntil: 'networkidle', timeout: 15000 });
  await checkpointViewport(page, label + ':initial-page');
  return page;
}


const exchangeSourceRow = overrides => ({
  id: 'exchange-buy', datetime_tz_CET: '2025-08-01-12:00:00', type: 'Buy',
  label: '', market_model_type: 'SPOT', order_type: 'MARKET',
  sent_amount: '100.00', sent_currency: 'EUR', sent_value_EUR: '100.00', sent_address: '',
  received_amount: '3', received_currency: 'ALFA', received_value_EUR: '99.50', received_address: '',
  fee_amount: '0', fee_currency: '', fee_value_EUR: '0', ...overrides
});
const exchangeSource = [
  exchangeSourceRow({ id: 'exchange-deposit', datetime_tz_CET: '2025-07-31-12:00:00', type: 'Deposit',
    sent_amount: '0', sent_currency: '', sent_value_EUR: '0', received_amount: '100', received_currency: 'EUR', received_value_EUR: '100' }),
  exchangeSourceRow({ label: '<img src=x onerror="window.__exchangeXss = true">', sent_address: 'synthetic, "quoted" address' }),
  exchangeSourceRow({ id: 'exchange-swap', datetime_tz_CET: '2025-08-02-12:00:00', type: 'Trade',
    sent_amount: '1', sent_currency: 'ALFA', sent_value_EUR: '33.333333333333333333',
    received_amount: '2', received_currency: 'BETA', received_value_EUR: '42.00' }),
  exchangeSourceRow({ id: 'exchange-reward', datetime_tz_CET: '2025-08-03-12:00:00', type: 'Receive', label: 'Reward', market_model_type: 'EARN',
    sent_amount: '0', sent_currency: '', sent_value_EUR: '0', received_amount: '0.500000000000000001', received_value_EUR: '20.00' }),
  exchangeSourceRow({ id: 'exchange-cashback', datetime_tz_CET: '2025-08-03-13:00:00', type: 'Receive', label: 'Reward', market_model_type: 'EARN',
    sent_amount: '0', sent_currency: '', sent_value_EUR: '0', received_amount: '0.25', received_value_EUR: '9.00' }),
  exchangeSourceRow({ id: 'exchange-sell', datetime_tz_CET: '2025-08-04-12:00:00', type: 'Sell',
    sent_amount: '2', sent_currency: 'BETA', sent_value_EUR: '100', received_amount: '100', received_currency: 'EUR', received_value_EUR: '100' })
];
function sourceCsv(rows) {
  return [EXCHANGE_CSV_COLUMNS, ...rows.map(row => EXCHANGE_CSV_COLUMNS.map(name => row[name]))]
    .map(fields => fields.map(value => '"' + value.replaceAll('"', '""') + '"').join(',')).join('\r\n');
}
async function openExchangeReview(page, rows) {
  await page.locator('#import-button').click();
  await page.locator('#import-file').setInputFiles({ name: 'synthetic-platform.csv', mimeType: 'text/csv', buffer: Buffer.from(sourceCsv(rows)) });
  await page.locator('#exchange-review').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#exchange-review .exchange-review-table tbody tr').count(), rows.length,
    'The source preview must show every source row, including informational deposits and rewards.');
}
async function assertReviewBlocked(page, description) {
  const button = page.locator('#confirm-import');
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled
    || [...document.querySelectorAll('#exchange-review .exchange-review-errors')].some(node => !node.hidden));
  if (!await button.isDisabled()) {
    await button.click();
    assert.equal(await page.locator('#import-dialog').isVisible(), true, description);
    const visibleErrors = page.locator('#import-error:visible, #exchange-review .exchange-review-errors:visible');
    assert.ok(await visibleErrors.count() > 0, 'A blocked import must explain the missing choices or unsupported data.');
  }
  assert.equal(await page.locator('#import-dialog').isVisible(), true, description);
}
async function verifyExchangeImport(page, label) {
  const initial = dataset({ initialLots: [lot('RESIDUO', '1', '5')] });
  await importDataset(page, initial, '', 0);
  const originalSession = await downloadSession(page, 'exchange-' + label + '-original-session');
  await openExchangeReview(page, exchangeSource);
  await assertReviewBlocked(page, 'Source rows must not become transactions until required choices are explicit.');
  await page.locator('#import-dialog').getByRole('button', { name: 'Annulla', exact: true }).click();
  assert.equal(await downloadSession(page, 'exchange-' + label + '-cancelled-session'), originalSession,
    'Reviewing or cancelling an incomplete source CSV must preserve the current session.');

  await openExchangeReview(page, [exchangeSourceRow({ id: 'unsupported-type', type: 'Withdraw' })]);
  await assertReviewBlocked(page, 'An unsupported record must block import instead of being silently dropped.');
  assert.match(await page.locator('#exchange-review').textContent(), /non supportat|bloccata/);
  await page.locator('#import-dialog').getByRole('button', { name: 'Annulla', exact: true }).click();
  assert.equal(await downloadSession(page, 'exchange-' + label + '-unsupported-session'), originalSession);

  await openExchangeReview(page, exchangeSource);
  const review = page.locator('#exchange-review');
  await review.getByLabel('Come inserire le operazioni', { exact: true }).selectOption('replace');
  await review.getByLabel(/^Confermo data e ora come riportate nel CSV/).check();
  await review.getByLabel(/^Confermo le quantità nette effettive del CSV/).check();
  await review.getByLabel(/ALFA → BETA/).selectOption('neutral');
  await review.getByLabel('Data dei lotti ricevuti nelle permute neutrali', { exact: true }).selectOption('historical');
  await review.getByLabel('Natura documentata dei premi', { exact: true }).selectOption('per_row');
  await review.getByLabel('Costo fiscale documentato dei token ricevuti, per le vendite future', { exact: true }).selectOption('manual');
  await assertReviewBlocked(page, 'The manual reward-cost policy must block import until every documented cost is supplied.');
  await review.locator('[data-source-line="5"]').click();
  await review.getByLabel('Trattamento documentato di questo premio', { exact: true }).selectOption('holding_income');
  await review.getByLabel('Costo fiscale totale documentato del premio in EUR', { exact: true }).fill('7.00');
  await review.getByRole('button', { name: 'Salva rettifica', exact: true }).click();
  await assertReviewBlocked(page, 'Mixed EARN data must require the documented treatment and cost of the second reward too.');
  await review.locator('[data-source-line="6"]').click();
  await review.getByLabel('Trattamento documentato di questo premio', { exact: true }).selectOption('documented_acquisition');
  await review.getByLabel('Costo fiscale totale documentato del premio in EUR', { exact: true }).fill('3.00');
  await review.getByRole('button', { name: 'Salva rettifica', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled);
  await review.locator('[data-source-line="6"]').click();
  await review.getByLabel('Costo fiscale totale documentato del premio in EUR', { exact: true }).fill('999');
  assert.equal(await page.locator('#confirm-import').isDisabled(), true, 'An unsaved correction must block applying previously reviewed values.');
  await review.locator('[data-source-line="5"]').click();
  assert.equal(await review.getByLabel('Costo fiscale totale documentato del premio in EUR', { exact: true }).inputValue(), '999', 'Changing rows must preserve unsaved corrections until explicitly saved or cancelled.');
  await review.getByRole('button', { name: 'Annulla rettifica', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled);
  assert.equal(await review.locator('img').count(), 0, 'HTML-like source labels must remain text in the preview.');
  assert.equal(await page.evaluate(() => window.__exchangeXss === true), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'The review must not make the application wider than a mobile viewport.');
  await page.locator('#import-dialog').evaluate(dialog => { dialog.scrollTop = 0; });
  await page.screenshot({ path: resolve(artifacts, 'exchange-' + label + '-wizard.png') });
  const preview = review.locator('.exchange-review-preview');
  await preview.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(artifacts, 'exchange-' + label + '-source-preview.png') });
  await page.locator('#confirm-import').click();
  await page.locator('#import-dialog').waitFor({ state: 'hidden' });
  await page.locator('#tax-year').selectOption('2025');
  await page.locator('#asset-filter').fill('');
  assert.equal(await page.locator('#ledger-content tbody tr').count(), 6, 'All six source rows must survive conversion.');
  assert.match(await page.locator('#metric-net').textContent(), /86,67 €/);
  assert.match(await page.locator('#metric-tax').textContent(), /22,53 €/);
  assert.match(await page.locator('#metric-cost').textContent(), /81,67 €/,
    'The residual basis must retain the original lot and the separately documented reward cost.');
  await page.screenshot({ path: resolve(artifacts, 'exchange-' + label + '-result.png'), fullPage: true });
  const exported = await downloadSession(page, 'exchange-' + label + '-canonical-v2');
  const snapshot = parseCsv(exported);
  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.initialLots, initial.initialLots, 'Replacement of operations must preserve historical opening lots.');
  assert.equal(snapshot.transactions.length, 6);
  for (const source of exchangeSource) {
    const converted = snapshot.transactions.find(row => row.id === source.id);
    assert.ok(converted, 'Source id must remain recoverable: ' + source.id);
    assert.deepEqual(converted.source.values, source, 'Every one of the 17 source fields must survive canonical export.');
    assert.equal(converted.fees, '0', 'Included fees must not be applied twice.');
  }
  const swap = snapshot.transactions.find(row => row.id === 'exchange-swap');
  assert.equal(swap.type, 'permuta_neutrale');
  assert.equal(swap.lotDatePolicy, 'historical');
  assert.equal(swap.source.decisions.swapTaxTreatment, 'neutral');
  const reward = snapshot.transactions.find(row => row.id === 'exchange-reward');
  assert.equal(reward.type, 'provento');
  assert.equal(reward.totalEur, '20.00');
  assert.equal(reward.rewardCostEur, '7.00');
  assert.equal(reward.quantity, '0.500000000000000001');
  assert.equal(reward.source.decisions.rewardCostPolicy, 'manual');
  assert.equal(reward.source.decisions.amountsPolicy, 'manual');
  const cashback = snapshot.transactions.find(row => row.id === 'exchange-cashback');
  assert.equal(cashback.type, 'acquisto');
  assert.equal(cashback.totalEur, '3.00');
  assert.equal(cashback.source.values.received_value_EUR, '9.00');
  assert.equal(cashback.source.decisions.rewardTreatment, 'documented_acquisition');
  assert.equal(Object.hasOwn(cashback, 'rewardCostEur'), false);
  await importDataset(page, snapshot, '', 6, { lineEnding: '\r' });
  await page.locator('#tax-year').selectOption('2025');
  assert.equal(await downloadSession(page, 'exchange-' + label + '-canonical-reimported'), exported,
    'Canonical v2 with CR-only record endings must be recognized correctly and preserve all raw data, classifications and documented reward costs.');
  assert.match(await page.locator('#metric-tax').textContent(), /22,53 €/);
  results.push({ name: 'exchange-csv-' + label, operations: 6, format: '17 source columns → canonical v2',
    incompleteReviewBlocked: true, unsupportedTypeBlocked: true, manualRewardCostRequired: true, sourceRoundTripVerified: true });
  console.log(`PASS exchange-csv-${label}: explicit review, neutral swap, mixed EARN classifications and canonical v2 round trip.`);
}

// The CSV deliberately lists the first sale last: diagnostics must refer to its
// original source line, while balances and gains follow the operation dates.
const openingRecoverySource = [
  exchangeSourceRow({ id: 'recovery-buy', datetime_tz_CET: '2025-07-02-12:00:00',
    sent_amount: '20', sent_value_EUR: '20', received_amount: '2', received_value_EUR: '20' }),
  exchangeSourceRow({ id: 'recovery-reward', datetime_tz_CET: '2025-07-03-12:00:00', type: 'Receive',
    label: 'Reward', market_model_type: 'EARN', sent_amount: '0', sent_currency: '', sent_value_EUR: '0',
    received_amount: '0.5', received_value_EUR: '5' }),
  exchangeSourceRow({ id: 'recovery-sell', datetime_tz_CET: '2025-07-01-12:00:00', type: 'Sell',
    sent_amount: '1', sent_currency: 'ALFA', sent_value_EUR: '15',
    received_amount: '15', received_currency: 'EUR', received_value_EUR: '15' })
];
const recoveryQuantity = '0.750000000000000001';
async function configureOpeningRecovery(page) {
  await openExchangeReview(page, openingRecoverySource);
  const review = page.locator('#exchange-review');
  await review.getByLabel('Come inserire le operazioni', { exact: true }).selectOption('replace');
  await review.getByLabel(/^Confermo data e ora come riportate nel CSV/).check();
  await review.getByLabel(/^Confermo le quantità nette effettive del CSV/).check();
  await review.getByLabel('Natura documentata dei premi', { exact: true }).selectOption('per_row');
  await review.getByLabel('Costo fiscale documentato dei token ricevuti, per le vendite future', { exact: true }).selectOption('manual');
  await activateButton(page, review.locator('[data-source-line="3"]'), 'opening-recovery');
  await review.getByLabel('Trattamento documentato di questo premio', { exact: true }).selectOption('holding_income');
  await review.getByLabel('Quantità netta ricevuta', { exact: true }).fill(recoveryQuantity);
  await review.getByLabel('Costo fiscale totale documentato del premio in EUR', { exact: true }).fill('3.00');
  await activateButton(page, review.getByRole('button', { name: 'Salva rettifica', exact: true }), 'opening-recovery');
  return review;
}
async function assertOpeningReviewChoices(page, review) {
  assert.equal(await review.getByLabel('Come inserire le operazioni', { exact: true }).inputValue(), 'replace');
  assert.equal(await review.getByLabel(/^Confermo data e ora come riportate nel CSV/).isChecked(), true);
  assert.equal(await review.getByLabel(/^Confermo le quantità nette effettive del CSV/).isChecked(), true);
  assert.equal(await review.getByLabel('Natura documentata dei premi', { exact: true }).inputValue(), 'per_row');
  assert.equal(await review.getByLabel('Costo fiscale documentato dei token ricevuti, per le vendite future', { exact: true }).inputValue(), 'manual');
  await activateButton(page, review.locator('[data-source-line="3"]'), 'opening-recovery');
  assert.equal(await review.getByLabel('Trattamento documentato di questo premio', { exact: true }).inputValue(), 'holding_income');
  assert.equal(await review.getByLabel('Quantità netta ricevuta', { exact: true }).inputValue(), recoveryQuantity);
  assert.equal(await review.getByLabel('Costo fiscale totale documentato del premio in EUR', { exact: true }).inputValue(), '3.00');
  await activateButton(page, review.getByRole('button', { name: 'Annulla rettifica', exact: true }), 'opening-recovery');
}
async function verifyOpeningLotRecovery(page, label) {
  const initial = dataset({ initialLots: [lot('RESIDUO', '1', '5')], transactions: [transaction('existing-purchase', {
    date: '2025-01-02', asset: 'OMEGA', type: 'acquisto', unitPrice: '2'
  })] });
  await importDataset(page, initial, '', 1);
  const original = await downloadSession(page, 'opening-recovery-' + label + '-before');
  let review = await configureOpeningRecovery(page);
  const addLot = () => review.getByRole('button', { name: 'Aggiungi un lotto di ALFA', exact: true });
  await page.waitForFunction(() => /Riga 4:/.test(document.querySelector('#exchange-review .exchange-review-errors')?.textContent || ''));
  assert.equal(await page.locator('#confirm-import').isDisabled(), true);
  assert.match(await review.locator('.exchange-review-balance-check').textContent(), /ALFA: lo scarto massimo delle quantità è 1 ALFA/);

  // An unfinished row correction cannot be discarded by opening the lot form.
  await activateButton(page, review.locator('[data-source-line="3"]'), 'opening-recovery');
  await review.getByLabel('Costo fiscale totale documentato del premio in EUR', { exact: true }).fill('999');
  await activateButton(page, addLot(), 'opening-recovery');
  assert.equal(await page.locator('#entry-dialog').isVisible(), false);
  assert.match(await review.locator('.exchange-review-errors').textContent(), /Salva o annulla la rettifica aperta/);
  assert.equal(await review.getByLabel('Costo fiscale totale documentato del premio in EUR', { exact: true }).inputValue(), '999');
  await activateButton(page, review.getByRole('button', { name: 'Annulla rettifica', exact: true }), 'opening-recovery');
  await activateButton(page, addLot(), 'opening-recovery');
  const entry = page.locator('#entry-dialog');
  await entry.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#import-dialog').isVisible(), true, 'Adding a lot must keep the source review open underneath.');
  assert.equal(await entry.getByLabel('Crypto / identificatore', { exact: true }).inputValue(), 'ALFA');
  for (const name of ['Data originaria di acquisto', 'Quantità residua all’apertura', 'Costo unitario fiscale documentato (€)']) {
    assert.equal(await entry.getByLabel(name, { exact: true }).inputValue(), '', 'The missing quantity, date and cost must never be guessed.');
  }
  const save = entry.getByRole('button', { name: 'Salva e ricalcola', exact: true });
  await activateButton(page, save, 'opening-recovery');
  assert.equal(await entry.isVisible(), true, 'Missing documented fields must block saving the lot.');
  assert.equal(await entry.locator('form').evaluate(form => form.checkValidity()), false);
  await entry.getByLabel('Data originaria di acquisto', { exact: true }).fill('2025-01-02');
  await entry.getByLabel('Quantità residua all’apertura', { exact: true }).fill('1');
  await entry.getByLabel('Costo unitario fiscale documentato (€)', { exact: true }).fill('10');
  await activateButton(page, save, 'opening-recovery');
  assert.equal(await entry.isVisible(), true, 'A lot acquired after the opening date must not be accepted.');
  assert.equal(await entry.locator('form').evaluate(form => form.checkValidity()), false);
  await entry.getByLabel('Data originaria di acquisto', { exact: true }).fill('2024-06-12');
  await entry.getByLabel('Quantità residua all’apertura', { exact: true }).fill('0');
  await activateButton(page, save, 'opening-recovery');
  assert.equal(await entry.isVisible(), true, 'An invalid zero-quantity lot must not mutate the session.');
  assert.equal(await page.locator('#entry-error').isVisible(), true);
  await activateButton(page, entry.getByRole('button', { name: 'Annulla', exact: true }), 'opening-recovery');
  await entry.waitFor({ state: 'hidden' });
  await assertOpeningReviewChoices(page, review);
  assert.equal(await page.locator('#confirm-import').isDisabled(), true);
  await activateButton(page, page.locator('#import-dialog').getByRole('button', { name: 'Annulla', exact: true }), 'opening-recovery');
  assert.equal(await downloadSession(page, 'opening-recovery-' + label + '-invalid-cancelled'), original,
    'Blank, invalid and cancelled initial lots must leave the original recoverable session unchanged.');

  // Saving a documented lot is an immediate session edit; cancelling the CSV
  // afterwards must preserve the lot while leaving the old operations intact.
  review = await configureOpeningRecovery(page);
  await activateButton(page, addLot(), 'opening-recovery');
  await entry.waitFor({ state: 'visible' });
  await entry.getByLabel('Data originaria di acquisto', { exact: true }).fill('2024-06-12');
  await entry.getByLabel('Quantità residua all’apertura', { exact: true }).fill('1');
  await entry.getByLabel('Costo unitario fiscale documentato (€)', { exact: true }).fill('10');
  await activateButton(page, save, 'opening-recovery');
  await entry.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#import-dialog').isVisible(), true);
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled);
  assert.equal(await addLot().count(), 0, 'The shortage must be recomputed against the explicitly saved opening lot.');
  assert.match(await review.locator('.exchange-review-balance-check').textContent(), /non richiede ulteriori saldi iniziali/);
  await assertOpeningReviewChoices(page, review);
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled);
  await review.locator('.exchange-review-balance-check').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(artifacts, 'opening-recovery-' + label + '-ready.png') });
  await activateButton(page, page.locator('#import-dialog').getByRole('button', { name: 'Annulla', exact: true }), 'opening-recovery');
  const withLot = parseCsv(await downloadSession(page, 'opening-recovery-' + label + '-lot-only'));
  assert.deepEqual(withLot.transactions, initial.transactions, 'Saving a lot and cancelling the CSV must not apply any source operation.');
  assert.equal(withLot.initialLots.length, 2);
  assert.deepEqual(withLot.initialLots.find(row => row.asset === 'RESIDUO'), initial.initialLots[0]);
  const documentedLot = withLot.initialLots.find(row => row.asset === 'ALFA');
  assert.ok(documentedLot);
  assert.equal(documentedLot.acquiredOn, '2024-06-12');
  assert.equal(documentedLot.quantity, '1');
  assert.equal(documentedLot.unitCost, '10');

  review = await configureOpeningRecovery(page);
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled);
  await activateCanonicalImport(page);
  await page.locator('#import-dialog').waitFor({ state: 'hidden' });
  await page.locator('#tax-year').selectOption('2025');
  await page.locator('#asset-filter').fill('');
  assert.equal(await page.locator('#ledger-content tbody tr').count(), 3);
  assert.match(await page.locator('#metric-net').textContent(), /10,00 €/);
  assert.match(await page.locator('#metric-tax').textContent(), /2,60 €/);
  const recovered = parseCsv(await downloadSession(page, 'opening-recovery-' + label + '-imported'));
  assert.deepEqual(recovered.initialLots, withLot.initialLots);
  assert.deepEqual(recovered.transactions.map(row => row.id), ['recovery-sell', 'recovery-buy', 'recovery-reward']);
  for (const source of openingRecoverySource) {
    assert.deepEqual(recovered.transactions.find(row => row.id === source.id).source.values, source);
  }
  const reward = recovered.transactions.find(row => row.id === 'recovery-reward');
  assert.equal(reward.type, 'provento');
  assert.equal(reward.quantity, recoveryQuantity);
  assert.equal(reward.rewardCostEur, '3.00');
  assert.equal(reward.source.decisions.rewardTreatment, 'holding_income');
  assert.equal(reward.source.decisions.amountsPolicy, 'manual');
  results.push({ name: 'opening-lot-recovery-' + label, operations: 3, originalSourceLineVerified: true,
    missingFieldsNotGuessed: true, invalidAndCancelledLotsPreserveSession: true, reviewChoicesPreserved: true,
    unsavedCorrectionProtected: true, cancelledCsvRetainsDocumentedLotOnly: true, sourceAndOverridesRoundTripVerified: true });
  console.log(`PASS opening-lot-recovery-${label}: explicit historical lot, original source-line errors, preserved choices and recoverable session.`);
}


async function captureFailureDiagnostics(failure) {
  const report = {
    failure: { name: failure.name, message: failure.message, stack: failure.stack },
    browser: browser?.version(), elapsedSeconds: (Date.now() - started) / 1000,
    cases: results, importClickAttempts, viewportCheckpoints, nativeConfirmActivations, javascriptErrors: errors, externalRequests, pages: []
  };
  let sequence = 0;
  for (const context of contexts) {
    for (const openPage of context.pages()) {
      const index = ++sequence;
      const entry = { index, url: openPage.url(), screenshots: [] };
      report.pages.push(entry);
      if (openPage.isClosed()) { entry.closed = true; continue; }
      try {
        entry.dom = await openPage.evaluate(() => {
          const rectangle = rect => rect ? Object.fromEntries(['x', 'y', 'top', 'right', 'bottom', 'left', 'width', 'height'].map(key => [key, rect[key]])) : null;
          const describe = element => {
            if (!element) return null;
            const style = getComputedStyle(element);
            return {
              tag: element.tagName, id: element.id, className: String(element.className || ''),
              hidden: element.hidden, disabled: element.disabled ?? null,
              open: element instanceof HTMLDialogElement ? element.open : null,
              rect: rectangle(element.getBoundingClientRect()),
              dimensions: { clientWidth: element.clientWidth, clientHeight: element.clientHeight,
                scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
                scrollLeft: element.scrollLeft, scrollTop: element.scrollTop,
                offsetWidth: element.offsetWidth, offsetHeight: element.offsetHeight },
              style: Object.fromEntries(['display', 'position', 'overflow', 'overflowX', 'overflowY', 'width', 'height',
                'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'padding', 'margin', 'zIndex', 'pointerEvents', 'transform', 'contain']
                .map(key => [key, style[key]])),
              text: element.textContent?.trim().slice(0, 240)
            };
          };
          const button = document.getElementById('confirm-import');
          const dialog = document.getElementById('import-dialog');
          const buttonRect = button?.getBoundingClientRect();
          const dialogRect = dialog?.getBoundingClientRect();
          const center = buttonRect ? { x: buttonRect.left + buttonRect.width / 2, y: buttonRect.top + buttonRect.height / 2 } : null;
          const clippedCenter = buttonRect && dialogRect ? {
            x: (Math.max(0, dialogRect.left, buttonRect.left) + Math.min(innerWidth, dialogRect.right, buttonRect.right)) / 2,
            y: (Math.max(0, dialogRect.top, buttonRect.top) + Math.min(innerHeight, dialogRect.bottom, buttonRect.bottom)) / 2
          } : null;
          const hitTest = point => point ? {
            point, first: describe(document.elementFromPoint(point.x, point.y)),
            stack: document.elementsFromPoint(point.x, point.y).slice(0, 10).map(describe)
          } : null;
          const ancestors = [];
          for (let element = button; element && ancestors.length < 8; element = element.parentElement) ancestors.push(describe(element));
          return {
            title: document.title, readyState: document.readyState, activeElement: describe(document.activeElement),
            viewport: { innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio,
              visual: visualViewport ? { width: visualViewport.width, height: visualViewport.height,
                offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, pageLeft: visualViewport.pageLeft,
                pageTop: visualViewport.pageTop, scale: visualViewport.scale } : null },
            document: describe(document.documentElement), body: describe(document.body),
            buttonAndAncestors: ancestors, centerHit: hitTest(center), clippedCenterHit: hitTest(clippedCenter),
            dialogs: [...document.querySelectorAll('dialog')].map(describe),
            importChildren: dialog ? [...dialog.children].map(describe) : [],
            importElements: ['import-dialog', 'confirm-import', 'import-preview', 'import-error', 'exchange-review', 'template-button', 'drop-zone']
              .map(id => describe(document.getElementById(id)))
          };
        });
      } catch (diagnosticError) { entry.domError = diagnosticError.message; }
      for (const [label, fullPage] of [['viewport', false], ['full', true]]) {
        try {
          const path = resolve(artifacts, `failure-page-${index}-${label}.png`);
          await openPage.screenshot({ path, fullPage, timeout: 10000 });
          entry.screenshots.push(path);
        } catch (diagnosticError) { entry[label + 'ScreenshotError'] = diagnosticError.message; }
      }
    }
  }
  await writeFile(resolve(artifacts, 'failure-browser-state.json'), JSON.stringify(report, null, 2));
  console.error('Browser failure diagnostics saved to ' + artifacts);
}

try {
  await waitForServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 20000 });
  // This exercises mobile layout, touch input and actual downloads in Chrome.
  // It emulates an Android device; it does not claim to run the Android OS download manager.
  const page = await newPage(devices['Pixel 7'], 'mobile');
  assert.match(await page.evaluate(() => navigator.userAgent), /Android/);
  assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);

  await importDataset(page, mixed, 'BTC', 2);
  await verifyGuide(page);
  await exportPdf(page, 'mixed-2026', 5, 2026, pdf => {
    assert.match(pdf.normalized, /anno 2026/);
    assert.match(pdf.normalized, /33%/);
    assert.match(pdf.normalized, /8,25 €/);
    assert.match(pdf.normalized, /Plusvalenza\s+\+50,00 €/);
    assert.equal(occurrences(pdf.normalized, 'Plusvalenza +50,00 €'), 2, 'Cash commissions must not reduce fiscal gains.');
    assert.match(pdf.normalized, /Minusvalenza\s+[-−]25,00 €/);
    assert.match(pdf.normalized, /Pareggio\s+0,00 €/);
    assert.match(pdf.normalized, /Nessun realizzo/);
    assert.match(pdf.normalized, /石油/);
    assert.ok(withoutSpaces(pdf.raw).includes('0,123456789012345678'), 'All 18 decimal places must survive actual PDF rendering.');
  }, { retry: true });
  await page.locator('#tax-year').selectOption('2025');
  await assertDownloadInvalidated(page, 'changing the selected tax year');
  await exportPdf(page, 'mixed-2025-reexport', 5, 2025, pdf => {
    assert.match(pdf.normalized, /anno 2025/);
    assert.match(pdf.normalized, /26%/);
    assert.match(pdf.normalized, /13,00 €/);
    assert.doesNotMatch(pdf.normalized, /8,25 €/);
  });

  await importDataset(page, longHistory, 'ASSET249', 1);
  await assertDownloadInvalidated(page, 'importing a different dataset');
  const desktop = await newPage({ viewport: { width: 1280, height: 900 } }, 'desktop');
  await importDataset(desktop, longHistory, 'ASSET249', 1);
  await exportPdf(desktop, 'multipage-250', 250, 2026, pdf => {
    assert.ok(pdf.pages > 2, '250 operations must exercise multiple PDF pages.');
    for (let index = 0; index < 250; index += 1) {
      const asset = 'ASSET' + String(index).padStart(3, '0');
      assert.equal(occurrences(pdf.text, asset), 1, asset + ' must appear exactly once in the actual PDF.');
    }
    const operationPages = pdf.text.split('\f').filter(text => /ASSET\d{3}/.test(text));
    assert.ok(operationPages.length > 2);
    for (const text of operationPages) {
      // -layout preserves visual lines: other columns can occur between the two
      // lines of "Data / sequenza". Check both header fragments on each page.
      assert.match(text, /\bData\s*\//, 'The date header must repeat on every page containing operations.');
      assert.match(text, /\bsequenza\b/, 'The second header line must repeat on every page containing operations.');
      assert.match(compact(text), /Risultato fiscale/);
    }
  });

  await importDataset(desktop, hugeNumbers, '', 1);
  await assertDownloadInvalidated(desktop, 'importing a different dataset');
  await exportPdf(desktop, 'large-numbers', 1, 2026, pdf => {
    const raw = withoutSpaces(pdf.raw);
    assert.ok(raw.includes('999.999.999.999.999.999.999.999.999.999,123456789012345678'), 'The 30-digit quantity and all 18 decimal places must be readable.');
    assert.ok(raw.includes('999.999.999.999.999.999.999.999.999.999,12€'), 'The whole large amount must be readable, including its cents.');
    assert.ok(raw.includes('329.999.999.999.999.999.999.999.999.999,71€'), 'The large tax total must be readable.');
    assert.ok(raw.includes(hugeAsset), 'The maximum-length asset name must not be truncated.');
  });
  await verifyExchangeImport(page, 'mobile');
  await verifyExchangeImport(desktop, 'desktop');
  await exportPdf(desktop, 'exchange-csv-v2', 6, 2025, pdf => {
    assert.match(pdf.normalized, /22,53 €/);
    assert.match(pdf.normalized, /Permuta neutrale/);
    assert.match(pdf.normalized, /Provento da detenzione/);
    assert.match(pdf.normalized, /Nessun realizzo; costo storico trasferito/);
    assert.match(pdf.normalized, /Provento imponibile 20,00 €/);
  });
  await verifyOpeningLotRecovery(await newPage({ viewport: { width: 1280, height: 900 } }, 'opening-recovery-desktop'), 'desktop');
  await verifyOpeningLotRecovery(await newPage(devices['Pixel 7'], 'opening-recovery-mobile'), 'mobile');
  for (const [label, options] of [['desktop', { viewport: { width: 1280, height: 900 } }], ['mobile', devices['Pixel 7']]]) {
    await verifyOpeningXlsx({ page: await newPage(options, 'opening-xlsx-' + label), label, artifacts, activateButton, importDataset,
      downloadSession, openExchangeReview, exchangeSourceRow, results });
    await verifyImportValidation({ page: await newPage(options, 'import-validation-' + label), label, activateButton, importDataset,
      downloadSession, sourceCsv, exchangeSourceRow, results });
  }
  assert.deepEqual(errors, [], 'The browser must not report JavaScript errors.');
  assert.deepEqual(externalRequests, [], 'PDF export must not send requests outside the local application.');
  for (const context of contexts) {
    for (const openPage of context.pages()) {
      assert.deepEqual(await openPage.evaluate(() => window.__cspViolations), [], 'The application must preserve its Content Security Policy without violations.');
    }
  }
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify({ browser: browser.version(), mobileDevice: 'Pixel 7 emulation', elapsedSeconds: (Date.now() - started) / 1000, cases: results }, null, 2));
  console.log(`PDF browser checks completed; artifacts: ${artifacts}`);
} catch (failure) {
  try { await captureFailureDiagnostics(failure); }
  catch (diagnosticError) { console.error('Unable to save browser failure diagnostics: ' + diagnosticError.message); }
  throw failure;
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    const closed = new Promise(resolveExit => server.once('exit', resolveExit));
    server.kill('SIGTERM');
    await Promise.race([closed, delay(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}
