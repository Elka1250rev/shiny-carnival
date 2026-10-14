import test from 'node:test';
import assert from 'node:assert/strict';
import { createPdfDownload } from '../dist/pdf-download.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function element(initial = {}) {
  const attributes = new Map();
  return {
    hidden: false,
    textContent: '',
    ...initial,
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); delete this[name]; }
  };
}

function setup(build = async () => new Uint8Array([37, 80, 68, 70])) {
  const button = element({ disabled: false });
  const link = element({ hidden: true, target: '_blank', rel: 'noopener' });
  const status = element();
  const container = element({ hidden: true });
  const urls = new Map();
  const revoked = [];
  const clicks = [];
  let nextUrl = 0;
  link.click = () => {
    assert.ok(urls.has(link.href), 'the download URL must still be valid');
    clicks.push({ href: link.href, download: link.download });
  };
  const URL = {
    createObjectURL(blob) {
      const url = `blob:pdf-${++nextUrl}`;
      urls.set(url, blob);
      return url;
    },
    revokeObjectURL(url) { revoked.push(url); urls.delete(url); }
  };
  const controller = createPdfDownload({ button, link, status, container, build, URL, Blob });
  return { controller, button, link, status, container, urls, revoked, clicks };
}

test('the PDF download preserves bytes, MIME type and filename and keeps a usable retry link', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
  const report = { title: 'Riepilogo di prova' };
  const fixture = setup(async value => { assert.equal(value, report); return bytes; });
  const { controller, button, link, status, container, urls, clicks, revoked } = fixture;
  assert.equal(await controller.export(report, 'criptoconti-2026.pdf'), true);
  const blob = urls.get(link.href);
  assert.equal(blob.type, 'application/pdf');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.deepEqual(clicks, [{ href: link.href, download: 'criptoconti-2026.pdf' }]);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener');
  assert.equal(link.hidden, false);
  assert.equal(container.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.match(status.textContent, /PDF pronto.*Scarica il PDF/);
  assert.deepEqual(revoked, []);
  link.click();
  assert.equal(clicks.length, 2);
  assert.ok(urls.has(link.href));
  const firstUrl = link.href;
  await controller.export(report, 'nuovo.pdf');
  assert.deepEqual(revoked, [firstUrl]);
  assert.equal(urls.size, 1);
});

test('a refused automatic click still leaves a local PDF ready for an explicit tap', async () => {
  const { controller, button, link, status, urls } = setup();
  link.click = () => { throw new Error('Automatic download blocked'); };
  assert.equal(await controller.export({}, 'report.pdf'), true);
  assert.equal(button.disabled, false);
  assert.equal(link.hidden, false);
  assert.ok(urls.has(link.href));
  assert.match(status.textContent, /PDF pronto/);
});

test('a failed export clears the previous report, restores the button and permits a retry', async () => {
  let fail = false;
  const error = new Error('Generazione fallita');
  const { controller, button, link, status, container, urls, revoked } = setup(async () => {
    if (fail) throw error;
    return new Uint8Array([37, 80, 68, 70]);
  });
  await controller.export({}, 'prima.pdf');
  const oldUrl = link.href;
  fail = true;
  await assert.rejects(controller.export({}, 'errore.pdf'), value => value === error);
  assert.deepEqual(revoked, [oldUrl]);
  assert.equal(urls.size, 0);
  assert.equal(link.hidden, true);
  assert.equal(link.href, undefined);
  assert.equal(link.download, undefined);
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(container.hidden, false);
  assert.match(status.textContent, /Impossibile preparare/);
  fail = false;
  assert.equal(await controller.export({}, 'riprovato.pdf'), true);
  assert.equal(link.download, 'riprovato.pdf');
});

test('duplicate export requests do not start a second build or change the pending filename', async () => {
  const pending = deferred();
  let builds = 0;
  const { controller, button, link, status, container, clicks } = setup(() => {
    builds += 1;
    return pending.promise;
  });
  const first = controller.export({}, 'primo.pdf');
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(container.hidden, false);
  assert.equal(link.hidden, true);
  assert.match(status.textContent, /Preparazione/);
  assert.equal(await controller.export({}, 'duplicato.pdf'), false);
  assert.equal(builds, 1);
  pending.resolve(new Uint8Array([37, 80, 68, 70]));
  assert.equal(await first, true);
  assert.equal(clicks.length, 1);
  assert.equal(link.download, 'primo.pdf');
});

test('reset revokes an available URL and a late build cannot replace a newer export', async () => {
  const oldBuild = deferred();
  const newBuild = deferred();
  let builds = 0;
  const { controller, button, link, status, container, urls, revoked, clicks } = setup(() => {
    builds += 1;
    return builds === 1 ? Promise.resolve(new Uint8Array([1])) : builds === 2 ? oldBuild.promise : newBuild.promise;
  });
  await controller.export({}, 'disponibile.pdf');
  const firstUrl = link.href;
  controller.reset();
  assert.deepEqual(revoked, [firstUrl]);
  assert.equal(urls.size, 0);
  assert.equal(container.hidden, true);
  assert.equal(link.hidden, true);
  assert.equal(status.textContent, '');
  const oldExport = controller.export({}, 'vecchio.pdf');
  controller.reset();
  const newExport = controller.export({}, 'nuovo.pdf');
  oldBuild.resolve(new Uint8Array([2]));
  assert.equal(await oldExport, false);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(link.hidden, true);
  assert.equal(urls.size, 0);
  assert.match(status.textContent, /Preparazione/);
  newBuild.resolve(new Uint8Array([3]));
  assert.equal(await newExport, true);
  assert.equal(link.download, 'nuovo.pdf');
  assert.equal(clicks.length, 2);
  assert.equal(urls.size, 1);
});

test('a rejected build after reset leaves the cleared session unchanged', async () => {
  const pending = deferred();
  const { controller, button, link, status, container, urls } = setup(() => pending.promise);
  const exported = controller.export({}, 'abbandonato.pdf');
  controller.reset();
  pending.reject(new Error('Late failure'));
  assert.equal(await exported, false);
  assert.equal(container.hidden, true);
  assert.equal(link.hidden, true);
  assert.equal(status.textContent, '');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(urls.size, 0);
});
