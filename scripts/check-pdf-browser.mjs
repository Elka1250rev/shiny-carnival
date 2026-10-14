import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, devices } from 'playwright';
import { exportCsv } from '../dist/csv.js';

// These fixtures are synthetic. No financial data or external service is used.
const project = fileURLToPath(new URL('../', import.meta.url));
const artifacts = resolve(process.env.PDF_ARTIFACT_DIR || '/tmp/criptoconti-pdf-checks');
const address = 'http://127.0.0.1:18743';
const started = Date.now();
const errors = [];
const results = [];
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

async function importDataset(page, input, filter, filteredCount) {
  await page.emulateMedia({ media: 'screen' });
  await page.locator('#import-button').click();
  await page.locator('#import-file').setInputFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from(exportCsv(input)) });
  await page.waitForFunction(() => !document.getElementById('confirm-import').disabled || !document.getElementById('import-error').hidden);
  assert.equal(await page.locator('#import-error').isVisible(), false, await page.locator('#import-error').textContent());
  await page.locator('#confirm-import').click();
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
  const sessionBefore = await downloadSession(page, name + '-session-before');
  const ledgerBefore = await page.locator('#ledger-content').innerHTML();
  const filterBefore = await page.locator('#asset-filter').inputValue();
  const expectedFilename = `criptoconti-operazioni-anno-${year}.pdf`;
  const pending = page.waitForEvent('download', { timeout: 20000 });
  await page.locator('#pdf-button').click();
  const download = await pending;
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
  await page.locator('#pdf-download-notice').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(artifacts, name + '-ui.png') });

  if (retry) {
    const repeated = page.waitForEvent('download');
    await page.locator('#pdf-download-link').click();
    const retryDownload = await repeated;
    assert.equal(await retryDownload.failure(), null);
    assert.equal(retryDownload.suggestedFilename(), expectedFilename);
    const retryPath = resolve(artifacts, name + '-retry.pdf');
    await retryDownload.saveAs(retryPath);
    assert.deepEqual(await readFile(retryPath), bytes, 'The visible retry link must download the same PDF without regenerating it.');
    assert.equal(await page.locator('#pdf-download-link').getAttribute('href'), href);
  }

  assert.equal(await downloadSession(page, name + '-session-after'), sessionBefore, 'PDF export must preserve every field in the recoverable session.');
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
  return page;
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
  await exportPdf(page, 'mixed-2026', 5, 2026, pdf => {
    assert.match(pdf.normalized, /anno 2026/);
    assert.match(pdf.normalized, /33%/);
    assert.match(pdf.normalized, /6,60 €/);
    assert.match(pdf.normalized, /Plusvalenza\s+\+50,00 €/);
    assert.match(pdf.normalized, /Plusvalenza\s+\+45,00 €/);
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
    assert.doesNotMatch(pdf.normalized, /6,60 €/);
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
  assert.deepEqual(errors, [], 'The browser must not report JavaScript errors.');
  assert.deepEqual(externalRequests, [], 'PDF export must not send requests outside the local application.');
  for (const context of contexts) {
    for (const openPage of context.pages()) {
      assert.deepEqual(await openPage.evaluate(() => window.__cspViolations), [], 'The application must preserve its Content Security Policy without violations.');
    }
  }
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify({ browser: browser.version(), mobileDevice: 'Pixel 7 emulation', elapsedSeconds: (Date.now() - started) / 1000, cases: results }, null, 2));
  console.log(`PDF browser checks completed; artifacts: ${artifacts}`);
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    const closed = new Promise(resolveExit => server.once('exit', resolveExit));
    server.kill('SIGTERM');
    await Promise.race([closed, delay(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}
