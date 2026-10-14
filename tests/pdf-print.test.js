import test from 'node:test';
import assert from 'node:assert/strict';
import { printPdfReport } from '../dist/pdf-print.js';

function browser(print) {
  const classes = new Set();
  const report = { hidden: true, innerHTML: '', replaceChildren() { this.innerHTML = ''; } };
  const document = {
    title: 'CriptoConti',
    body: { classList: {
      contains: value => classes.has(value),
      add: value => classes.add(value),
      remove: value => classes.delete(value),
    } },
    getElementById: id => id === 'pdf-report' ? report : null,
  };
  const window = new EventTarget();
  window.print = () => print({ document, window, report, classes });
  return { document, window, report, classes };
}

test('the print command receives only the prepared report and restores the session after printing', () => {
  let calls = 0;
  const context = browser(({ document, window, report, classes }) => {
    calls += 1;
    assert.equal(report.innerHTML, '<h1>Risultati</h1>');
    assert.equal(report.hidden, false);
    assert.ok(classes.has('pdf-export'));
    assert.equal(document.title, 'CriptoConti-riepilogo-operazioni');
    window.dispatchEvent(new Event('afterprint'));
  });
  assert.equal(printPdfReport('<h1>Risultati</h1>', 'CriptoConti-riepilogo-operazioni', context), true);
  assert.equal(calls, 1);
  assert.equal(context.document.title, 'CriptoConti');
  assert.equal(context.report.hidden, true);
  assert.equal(context.report.innerHTML, '');
  assert.equal(context.classes.size, 0);
});

test('closing a delayed print dialog removes its report, including after cancellation', () => {
  const context = browser(() => {});
  printPdfReport('<p>Risultati A</p>', 'Prospetto A', context);
  assert.equal(context.report.innerHTML, '<p>Risultati A</p>');
  context.window.dispatchEvent(new Event('afterprint'));
  assert.equal(context.report.innerHTML, '');
  assert.equal(context.report.hidden, true);
  assert.equal(context.document.title, 'CriptoConti');
  printPdfReport('<p>Risultati B</p>', 'Prospetto B', context);
  assert.equal(context.report.innerHTML, '<p>Risultati B</p>');
  assert.equal(context.document.title, 'Prospetto B');
  context.window.dispatchEvent(new Event('afterprint'));
  assert.equal(context.document.title, 'CriptoConti');
});

test('a second export cannot replace the report while its print dialog is open', () => {
  let calls = 0;
  const context = browser(() => { calls += 1; });
  printPdfReport('<p>Primo</p>', 'Primo PDF', context);
  assert.equal(printPdfReport('<p>Secondo</p>', 'Secondo PDF', context), false);
  assert.equal(calls, 1);
  assert.equal(context.report.innerHTML, '<p>Primo</p>');
  context.window.dispatchEvent(new Event('afterprint'));
});

test('a failed print command cleans up the temporary report and permits a retry', () => {
  const context = browser(() => { throw new Error('Stampa non disponibile'); });
  assert.throws(() => printPdfReport('<p>Dati</p>', 'Report', context), /Stampa non disponibile/);
  assert.equal(context.report.innerHTML, '');
  assert.equal(context.report.hidden, true);
  assert.equal(context.classes.size, 0);
  assert.equal(context.document.title, 'CriptoConti');
  context.window.print = () => context.window.dispatchEvent(new Event('afterprint'));
  assert.equal(printPdfReport('<p>Nuovi dati</p>', 'Report', context), true);
  assert.equal(context.report.innerHTML, '');
});

test('a browser without print support leaves the session unchanged', () => {
  const context = browser(() => {});
  context.window.print = undefined;
  assert.throws(() => printPdfReport('Report', 'PDF', context), /non è disponibile/);
  assert.equal(context.classes.size, 0);
  assert.equal(context.document.title, 'CriptoConti');
  assert.equal(context.report.hidden, true);
});
