import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { verifyMobileResults } from '../tests/browser/mobile-results.mjs';

// Synthetic sessions only: no private financial file or external service is used.
const project = fileURLToPath(new URL('../', import.meta.url));
const artifacts = resolve(process.env.MOBILE_ARTIFACT_DIR || '/tmp/criptoconti-mobile-checks');
const address = 'http://127.0.0.1:18744';
const results = [];
const errors = [];
await mkdir(artifacts, { recursive: true });
let serverOutput = '';
let serverError;
const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: project, env: { ...process.env, CRIPTOCONTI_PORT: '18744' }, stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-8000); });
server.on('error', error => { serverError = error; });
let browser;
try {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (serverError) throw serverError;
    assert.equal(server.exitCode, null, 'The local server exited: ' + serverOutput);
    try { if ((await fetch(address, { signal: AbortSignal.timeout(500) })).ok) break; }
    catch { /* The server may still be binding its loopback port. */ }
    await delay(75);
  }
  assert.ok((await fetch(address)).ok, 'The local server must be ready.');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: true, timeout: 20000,
  });
  for (const viewport of [
    { width: 360, height: 800 }, { width: 390, height: 844 }, { width: 412, height: 915 },
    { width: 740, height: 360 }, { width: 1280, height: 900 },
  ]) {
    const mobile = viewport.width <= 760;
    const label = `${mobile ? 'mobile' : 'desktop'}-${viewport.width}x${viewport.height}`;
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile,
      deviceScaleFactor: 1, acceptDownloads: true,
      ...(mobile ? { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' } : {}) });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push({ label, message: error.message }));
    page.on('console', message => { if (message.type() === 'error') errors.push({ label, message: message.text() }); });
    try {
      await page.goto(address);
      await page.locator('#metric-tax').waitFor();
      await verifyMobileResults({ page, label, mobile, artifacts, results });
    } catch (error) {
      await page.screenshot({ path: resolve(artifacts, `${label}-failure.png`), fullPage: true }).catch(() => {});
      await writeFile(resolve(artifacts, `${label}-failure.html`), await page.content()).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, [], 'The tested interfaces must not produce browser errors.');
  console.log(JSON.stringify({ status: 'passed', viewports: 5, results, errors, artifacts }, null, 2));
} finally {
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  server.kill('SIGTERM');
}
