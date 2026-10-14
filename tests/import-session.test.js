import test from 'node:test';
import assert from 'node:assert/strict';
import { createImportSession } from '../dist/import-session.js';
import { parseImport, exportCsv } from '../dist/csv.js';
import { calculate } from '../dist/engine.js';

function deferredFile(name = 'sessione.csv') {
  let resolve, reject;
  const content = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { name, size: 100, text: () => content, resolve, reject };
}
function snapshot(asset) {
  return { version: 1, openingDate: '2025-01-01', transactions: [], carryLosses: [],
    initialLots: [{ id: 'lotto-' + asset, asset, acquiredOn: '2024-01-01', order: 1, quantity: '1', unitCost: '100' }] };
}
function session() {
  return createImportSession((content, name) => {
    const data = parseImport(content, name);
    calculate(data, 2026);
    return data;
  });
}

test('a slow earlier CSV cannot replace the last selected file', async () => {
  const importer = session();
  const first = deferredFile('primo.csv'), last = deferredFile('ultimo.csv');
  const firstRead = importer.read(first), lastRead = importer.read(last);
  last.resolve(exportCsv(snapshot('ETH')));
  assert.equal((await lastRead).name, 'ultimo.csv');
  first.resolve(exportCsv(snapshot('BTC')));
  assert.equal(await firstRead, null);
  assert.deepEqual(importer.pending, snapshot('ETH'));
});

test('an earlier file finishing first stays unavailable while the latest file loads', async () => {
  const importer = session();
  const first = deferredFile(), last = deferredFile();
  const firstRead = importer.read(first), lastRead = importer.read(last);
  first.resolve(exportCsv(snapshot('BTC')));
  assert.equal(await firstRead, null);
  assert.equal(importer.pending, null);
  last.resolve(exportCsv(snapshot('ETH')));
  assert.deepEqual((await lastRead).dataset, snapshot('ETH'));
});

test('a stale read failure cannot replace a successful latest preview with an error', async () => {
  const importer = session();
  const first = deferredFile(), last = deferredFile();
  const firstRead = importer.read(first), lastRead = importer.read(last);
  last.resolve(exportCsv(snapshot('ETH')));
  await lastRead;
  first.reject(new Error('Lettura fallita'));
  assert.equal(await firstRead, null);
  assert.deepEqual(importer.pending, snapshot('ETH'));
});

test('selecting an invalid file clears the previous importable snapshot', async () => {
  const importer = session();
  const first = deferredFile(), invalid = deferredFile();
  first.resolve(exportCsv(snapshot('BTC')));
  await importer.read(first);
  const invalidRead = importer.read(invalid);
  assert.equal(importer.pending, null);
  invalid.resolve('CSV non valido');
  await assert.rejects(invalidRead);
  assert.equal(importer.pending, null);
});

test('closing or clearing the import dialog cancels both late success and late failure', async () => {
  for (const fail of [false, true]) {
    const importer = session();
    const file = deferredFile();
    const reading = importer.read(file);
    importer.reset();
    if (fail) file.reject(new Error('Lettura interrotta'));
    else file.resolve(exportCsv(snapshot('BTC')));
    assert.equal(await reading, null);
    assert.equal(importer.pending, null);
  }
});

test('reopening the dialog isolates the new selection from a previous pending read', async () => {
  const importer = session();
  const previous = deferredFile(), current = deferredFile();
  const previousRead = importer.read(previous);
  importer.reset();
  const currentRead = importer.read(current);
  previous.resolve(exportCsv(snapshot('BTC')));
  assert.equal(await previousRead, null);
  assert.equal(importer.pending, null);
  current.resolve(exportCsv(snapshot('ETH')));
  await currentRead;
  assert.deepEqual(importer.pending, snapshot('ETH'));
});

test('an oversized file is refused before reading and clears the previous snapshot', async () => {
  const importer = session();
  const first = deferredFile();
  first.resolve(exportCsv(snapshot('BTC')));
  await importer.read(first);
  await assert.rejects(importer.read({ size: 5 * 1024 * 1024 + 1, text: () => assert.fail('File troppo grande letto') }), /5 MB/);
  assert.equal(importer.pending, null);
});

test('chronologically invalid data cannot become an importable snapshot', async () => {
  const importer = session();
  const file = deferredFile();
  const data = snapshot('BTC');
  data.transactions.push({ id: 'vendita', date: '2026-01-01', order: 1, type: 'vendita', asset: 'BTC', quantity: '2', unitPrice: '200', fees: '0' });
  file.resolve(exportCsv(data));
  await assert.rejects(importer.read(file), error => error.name === 'ValidationError');
  assert.equal(importer.pending, null);
});
