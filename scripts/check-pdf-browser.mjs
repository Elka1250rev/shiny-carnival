import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
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

async function assertPrintGeometry(page) {
  const problems = await page.evaluate(() => {
    const report = document.getElementById('pdf-report');
    const bounds = report.getBoundingClientRect();
    const issues = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('The print document overflows horizontally.');
    for (const element of report.querySelectorAll('table, th, td, dd, .pdf-summary > div')) {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const label = element.tagName + ': ' + element.textContent.slice(0, 80);
      if (box.left < bounds.left - 1 || box.right > bounds.right + 1) issues.push('Outside report: ' + label);
      if (element.scrollWidth > element.clientWidth + 1) issues.push('Content overflows: ' + label);
      if (['hidden', 'clip'].includes(style.overflowX) || style.textOverflow === 'ellipsis') issues.push('Potentially clipped: ' + label);
      if (element.matches('td.numeric, dd')) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const fragment of range.getClientRects()) {
            if (fragment.left < box.left - 1 || fragment.right > box.right + 1) issues.push('Numeric text outside its cell: ' + label);
          }
        }
      }
    }
    for (const element of document.body.children) {
      if (element !== report && element.getBoundingClientRect().height > 0) issues.push('Application UI remains in print layout: ' + element.tagName);
    }
    return issues;
  });
  assert.deepEqual(problems, [], 'Print content must fit without clipping numbers.');
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

async function exportPdf(page, name, expectedRows, verify) {
  const originalTitle = await page.title();
  const previousCalls = await page.evaluate(() => window.__printCalls);
  await page.locator('#pdf-button').click();
  await page.waitForFunction(() => document.body.classList.contains('pdf-export'));
  assert.equal(await page.evaluate(() => window.__printCalls), previousCalls + 1, 'The UI must invoke the browser print command once.');
  assert.equal(await page.locator('#pdf-report .pdf-operations tbody tr').count(), expectedRows, 'The PDF must contain every operation despite the screen filter.');
  assert.notEqual(await page.title(), originalTitle, 'The PDF should use its own document title.');
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => document.fonts.ready);
  await assertPrintGeometry(page);
  await page.screenshot({ path: resolve(artifacts, name + '.png') });
  const path = resolve(artifacts, name + '.pdf');
  await page.pdf({ path, preferCSSPageSize: true, printBackground: true, timeout: 20000 });
  // This must be Chrome's real print lifecycle, never a simulated afterprint event.
  await page.waitForFunction(() => !document.body.classList.contains('pdf-export'), null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.getElementById('pdf-report').hidden), true, 'afterprint must hide the temporary report.');
  assert.equal(await page.locator('#pdf-report').innerHTML(), '', 'afterprint must remove the temporary financial snapshot.');
  assert.equal(await page.title(), originalTitle, 'afterprint must restore the application title.');
  await page.emulateMedia({ media: 'screen' });
  assert.equal(await page.locator('#pdf-button').isVisible(), true, 'The session must remain usable after PDF generation.');
  const pdf = inspectPdf(path);
  await Promise.all([
    writeFile(resolve(artifacts, name + '.txt'), pdf.text),
    writeFile(resolve(artifacts, name + '.bbox.html'), pdf.bbox),
  ]);
  verify(pdf);
  results.push({ name, operations: expectedRows, pages: pdf.pages });
  console.log(`PASS ${name}: ${expectedRows} operations, ${pdf.pages} PDF page(s), real afterprint cleanup.`);
}

try {
  await waitForServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 20000 });
  // A4 landscape content width: (297 - 2 * 12) mm at 96 CSS pixels/inch.
  const page = await browser.newPage({ viewport: { width: 1032, height: 703 }, locale: 'it-IT' });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => { window.__printCalls += 1; };
  });
  await page.goto(address, { waitUntil: 'networkidle', timeout: 15000 });

  await importDataset(page, mixed, 'BTC', 2);
  await exportPdf(page, 'mixed-2026', 5, pdf => {
    assert.match(pdf.normalized, /anno 2026/);
    assert.match(pdf.normalized, /33%/);
    assert.match(pdf.normalized, /6,60 €/);
    assert.match(pdf.normalized, /Plusvalenza\s+\+50,00 €/);
    assert.match(pdf.normalized, /Plusvalenza\s+\+45,00 €/);
    assert.match(pdf.normalized, /Minusvalenza\s+−25,00 €/);
    assert.match(pdf.normalized, /Pareggio\s+0,00 €/);
    assert.match(pdf.normalized, /Nessun realizzo/);
    assert.match(pdf.normalized, /石油/);
    assert.ok(withoutSpaces(pdf.raw).includes('0,123456789012345678'), 'All 18 decimal places must survive actual PDF rendering.');
  });
  await page.locator('#tax-year').selectOption('2025');
  await exportPdf(page, 'mixed-2025-reexport', 5, pdf => {
    assert.match(pdf.normalized, /anno 2025/);
    assert.match(pdf.normalized, /26%/);
    assert.match(pdf.normalized, /13,00 €/);
    assert.doesNotMatch(pdf.normalized, /6,60 €/);
  });

  await importDataset(page, longHistory, 'ASSET249', 1);
  await exportPdf(page, 'multipage-250', 250, pdf => {
    assert.ok(pdf.pages > 2, '250 operations must exercise multiple printed pages.');
    for (let index = 0; index < 250; index += 1) {
      const asset = 'ASSET' + String(index).padStart(3, '0');
      assert.equal(occurrences(pdf.text, asset), 1, asset + ' must appear exactly once in the actual PDF.');
    }
    const operationPages = pdf.text.split('\f').filter(text => /ASSET\d{3}/.test(text));
    assert.ok(operationPages.length > 2);
    for (const text of operationPages) {
      assert.match(compact(text), /Data\s*\/\s*sequenza/, 'The table header must repeat on every page containing operations.');
      assert.match(compact(text), /Risultato fiscale/);
    }
  });

  await importDataset(page, hugeNumbers, '', 1);
  await exportPdf(page, 'large-numbers', 1, pdf => {
    const raw = withoutSpaces(pdf.raw);
    assert.ok(raw.includes('999.999.999.999.999.999.999.999.999.999,123456789012345678'), 'The 30-digit quantity and all 18 decimal places must be readable.');
    assert.ok(raw.includes('999.999.999.999.999.999.999.999.999.999,12€'), 'The whole large amount must be readable, including its cents.');
    assert.ok(raw.includes('329.999.999.999.999.999.999.999.999.999,71€'), 'The large tax total must be readable.');
    assert.ok(raw.includes(hugeAsset), 'The maximum-length asset name must not be truncated.');
  });
  assert.deepEqual(errors, [], 'The browser must not report JavaScript errors.');
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify({ browser: browser.version(), elapsedSeconds: (Date.now() - started) / 1000, cases: results }, null, 2));
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
