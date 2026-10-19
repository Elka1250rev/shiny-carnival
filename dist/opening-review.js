import { readXlsxWorkbook } from './xlsx-reader.js';
import { parseOpeningSheet, sheetDecimal, openingDateForSnapshot, convertOpeningSnapshot } from './opening-import.js';

const PAGE_SIZE = 5;

export function createOpeningImport({ dialog, getDataset, validate, apply, onClose = () => {} }) {
  const doc = dialog.ownerDocument;
  const find = id => doc.getElementById(id);
  let revision = 0;
  let workbook = null;
  let source = null;
  let lots = {};
  let quantities = {};
  let page = 0;
  let ready = null;
  const node = (tag, text, className) => {
    const result = doc.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  function action(text, callback) {
    const button = node('button', text, 'button button-outline');
    button.type = 'button';
    button.addEventListener('click', callback);
    return button;
  }
  function field(parent, text, value, update, type = 'text') {
    const wrapper = node('label', undefined, 'form-field');
    wrapper.append(node('span', text));
    const input = node('input');
    input.type = type;
    input.value = value;
    input.autocomplete = 'off';
    if (type === 'text') input.inputMode = 'decimal';
    if (type === 'date') input.max = find('opening-snapshot-date').value || '2026-12-31';
    input.addEventListener('input', () => { update(input.value); check(); });
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }
  function message(text, error = true) {
    const box = find('opening-status');
    box.textContent = text;
    box.className = error ? 'form-error' : 'import-preview';
    box.hidden = !text;
  }
  function options() {
    return {
      snapshotDate: find('opening-snapshot-date').value, timing: find('opening-timing').value,
      replaceConfirmed: find('opening-replace-confirm').checked,
      costsConfirmed: find('opening-costs-confirm').checked,
      euroConfirmed: find('opening-euro-confirm').checked,
      valueMeaning: find('opening-value-meaning').value,
      lots, quantities
    };
  }
  function check() {
    ready = null;
    find('confirm-opening-import').disabled = true;
    if (!source) return;
    const config = options();
    try {
      const opening = openingDateForSnapshot(config.snapshotDate, config.timing);
      find('opening-date-preview').textContent = `Apertura del calcolo: ${opening.split('-').reverse().join('/')}. I saldi di fine giornata sono applicati dall’inizio del giorno successivo.`;
      if (!find('opening-value-meaning').value) throw new Error('Indica che cosa rappresenta la colonna CRIPTO/EURO.');
      const next = convertOpeningSnapshot(source, getDataset(), config);
      validate(next);
      ready = next;
      message(`Pronto: ${next.initialLots.length} lotti iniziali. Le operazioni e le minusvalenze della sessione sono conservate.`, false);
      find('confirm-opening-import').disabled = false;
    } catch (error) {
      if (!config.snapshotDate || !config.timing) find('opening-date-preview').textContent = 'Inserisci la data e indica inizio o fine giornata: la nota e il nome del file non impostano questi campi.';
      message(error.errors ? error.errors.slice(0, 5).map(item => item.message).join('\n') : error.message);
    }
  }
  function renderLots() {
    const container = find('opening-lots');
    container.replaceChildren();
    const estimated = find('opening-value-meaning').value === 'estimated_average';
    find('opening-costs-label').textContent = estimated
      ? 'Ho verificato le quantità e i prezzi medi storici stimati. Confermo l’uso di saldi aggregati con date originarie non disponibili: risultati e imposta sono indicativi e i costi restano modificabili.'
      : 'Ho verificato quantità, date originarie e costi fiscali documentati dei singoli lotti, esclusi commissioni e oneri accessori.';
    find('opening-estimated-note').hidden = !estimated;
    const cryptoRows = source.rows.filter(row => row.asset !== 'EUR');
    if (!cryptoRows.length) {
      container.append(node('p', 'Il foglio contiene solo liquidità EUR informativa: la conferma imposterà una situazione iniziale senza lotti crypto.', 'small-note'));
      return;
    }
    const pages = Math.max(1, Math.ceil(cryptoRows.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    container.append(node('p', `Posizioni ${page * PAGE_SIZE + 1}–${Math.min(cryptoRows.length, (page + 1) * PAGE_SIZE)} di ${cryptoRows.length} · pagina ${page + 1}/${pages}. I dati inseriti restano disponibili cambiando pagina.`, 'small-note'));
    for (const row of cryptoRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
      const section = node('section', undefined, 'opening-asset');
      section.dataset.excelRow = String(row.row);
      section.append(node('h4', `${row.asset} · riga ${row.row}`));
      section.append(node('p', `Quantità nel file: ${row.source.quantity}. CRIPTO/EURO: ${row.unitValue || '—'}. EURO: ${row.totalValue || '—'}${row.totalFormula !== null ? ' (risultato salvato di una formula, non ricalcolata)' : ''}.`, 'small-note'));
      field(section, 'Quantità totale confermata di ' + row.asset, quantities[row.row], value => { quantities[row.row] = value; });
      for (const [index, lot] of lots[row.row].entries()) {
        const block = node('div', undefined, 'opening-lot');
        block.append(node('p', estimated ? 'Saldo aggregato a prezzo medio storico stimato · data di acquisto non disponibile' : `Lotto ${index + 1}`, 'small-note'));
        const grid = node('div', undefined, 'form-grid');
        if (!estimated) field(grid, 'Data originaria di acquisto', lot.acquiredOn, value => { lot.acquiredOn = value; }, 'date');
        field(grid, 'Quantità del lotto', lot.quantity, value => { lot.quantity = value; });
        field(grid, estimated ? 'Prezzo medio storico stimato (€)' : 'Costo unitario fiscale documentato (€)', lot.unitCost, value => { lot.unitCost = value; lot.costOrigin = 'manual'; });
        block.append(grid);
        const controls = node('div', undefined, 'opening-actions');
        if (find('opening-value-meaning').value === 'unit_cost' && lots[row.row].length === 1) controls.append(action('Usa CRIPTO/EURO come costo di questo lotto', () => {
          try {
            if (row.unitFormula !== null) throw new Error('CRIPTO/EURO contiene una formula: inserisci il costo documentato manualmente.');
            lot.unitCost = sheetDecimal(row.unitValue);
            lot.costOrigin = 'sheet';
            renderLots(); check();
          } catch (error) { message(error.message); }
        }));
        controls.append(action('Rimuovi questo lotto', () => { lots[row.row].splice(index, 1); renderLots(); check(); }));
        block.append(controls);
        section.append(block);
      }
      if (!estimated || !lots[row.row].length) section.append(action((estimated ? 'Aggiungi saldo di ' : 'Aggiungi lotto di ') + row.asset, () => {
        const count = Object.values(lots).reduce((total, values) => total + values.length, 0);
        if (count >= 5000) { message('Il limite è di 5.000 lotti complessivi.'); return; }
        for (const lot of lots[row.row]) if (lot.costOrigin === 'sheet') { lot.unitCost = ''; lot.costOrigin = 'manual'; }
        let cost = '';
        if (estimated && row.unitFormula === null) { try { cost = sheetDecimal(row.unitValue); } catch { /* Editable below. */ } }
        lots[row.row].push({ acquiredOn: '', quantity: estimated ? quantities[row.row] : '', unitCost: cost, costOrigin: estimated ? 'estimate' : 'manual' });
        renderLots(); check();
      }));
      container.append(section);
    }
    if (pages > 1) {
      const navigation = node('div', undefined, 'opening-actions');
      const previous = action('Posizioni precedenti', () => { page -= 1; renderLots(); });
      const next = action('Posizioni successive', () => { page += 1; renderLots(); });
      previous.disabled = page === 0;
      next.disabled = page === pages - 1;
      navigation.append(previous, next);
      container.append(navigation);
    }
  }
  function chooseSheet() {
    source = null; ready = null;
    find('confirm-opening-import').disabled = true;
    find('opening-review').hidden = true;
    const index = find('opening-sheet').value;
    if (index === '') return;
    find('opening-snapshot-date').value = '';
    find('opening-timing').value = '';
    find('opening-value-meaning').value = 'estimated_average';
    find('opening-replace-confirm').checked = false;
    find('opening-costs-confirm').checked = false;
    try {
      source = parseOpeningSheet(workbook.sheets[Number(index)]);
      lots = {}; quantities = {}; page = 0;
      for (const row of source.rows) {
        quantities[row.row] = row.quantity;
        let estimatedCost = '';
        try { if (row.unitFormula === null) estimatedCost = sheetDecimal(row.unitValue); } catch { /* Ask for a manual correction. */ }
        if (row.asset !== 'EUR') lots[row.row] = /[1-9]/.test(row.quantity)
          ? [{ acquiredOn: '', quantity: row.quantity, unitCost: estimatedCost, costOrigin: 'estimate' }] : [];
      }
      const summary = find('opening-source-summary');
      summary.replaceChildren(node('p', `Foglio «${source.name}»: intestazioni alla riga ${source.headerRow}, ${source.rows.length} posizioni e ${source.totals.length} righe di totale informative.`));
      for (const note of source.notes) summary.append(node('p', `Nota del file (riga ${note.row}): ${note.text}`, 'small-note'));
      const euros = source.rows.filter(row => row.asset === 'EUR');
      find('opening-euro-field').hidden = !euros.length;
      find('opening-euro-confirm').checked = euros.length > 0;
      find('opening-euro-info').textContent = euros.map(row => `Riga ${row.row}: quantità EUR ${row.quantity}; CRIPTO/EURO ${row.unitValue || '—'}; EURO ${row.totalValue || '—'}.`).join(' ');
      find('opening-review').hidden = false;
      renderLots(); check();
    } catch (error) { message(error.message); }
  }
  async function readFile(file) {
    const request = ++revision;
    source = workbook = ready = null;
    find('opening-review').hidden = true;
    find('opening-sheet-field').hidden = true;
    find('confirm-opening-import').disabled = true;
    if (!file) { message(''); return; }
    message('Lettura locale del file Excel…', false);
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('Seleziona un file .xlsx; i formati .xls e .xlsm non sono supportati.');
      if (file.size > 5 * 1024 * 1024) throw new Error('Il limite del file è di 5 MiB.');
      const bytes = await file.arrayBuffer();
      if (request !== revision) return;
      const parsed = await readXlsxWorkbook(bytes);
      if (request !== revision) return;
      workbook = parsed;
      const select = find('opening-sheet');
      select.replaceChildren();
      const empty = node('option', 'Seleziona un foglio…'); empty.value = ''; select.append(empty);
      parsed.sheets.forEach((sheet, index) => {
        const option = node('option', sheet.name + (sheet.hidden ? ' (nascosto)' : ''));
        option.value = String(index); select.append(option);
      });
      find('opening-sheet-field').hidden = false;
      if (parsed.sheets.length === 1) { select.value = '0'; chooseSheet(); }
      else message('Seleziona esplicitamente il foglio contenente la situazione iniziale.', false);
    } catch (error) { if (request === revision) message(error.message); }
  }
  find('opening-file').addEventListener('change', event => readFile(event.target.files[0]));
  find('opening-sheet').addEventListener('change', chooseSheet);
  for (const id of ['opening-snapshot-date', 'opening-timing', 'opening-replace-confirm', 'opening-costs-confirm', 'opening-euro-confirm']) find(id).addEventListener('change', () => {
    if (id === 'opening-snapshot-date') for (const input of find('opening-lots').querySelectorAll('input[type="date"]')) input.max = find(id).value || '2026-12-31';
    check();
  });
  find('opening-value-meaning').addEventListener('change', () => {
    if (!source) return;
    if (find('opening-value-meaning').value !== 'unit_cost') for (const rows of Object.values(lots)) for (const lot of rows) {
      if (lot.costOrigin === 'sheet' || lot.costOrigin === 'estimate') { lot.unitCost = ''; lot.costOrigin = 'manual'; }
    }
    if (find('opening-value-meaning').value === 'unit_cost') for (const rows of Object.values(lots)) for (const lot of rows) {
      if (lot.costOrigin === 'estimate') { lot.unitCost = ''; lot.costOrigin = 'manual'; }
    }
    if (find('opening-value-meaning').value === 'estimated_average') for (const row of source.rows) {
      const first = lots[row.row]?.[0];
      if (first && lots[row.row].length === 1 && first.unitCost === '' && row.unitFormula === null) {
        try { first.unitCost = sheetDecimal(row.unitValue); first.costOrigin = 'estimate'; } catch { /* Remain editable. */ }
      }
    }
    renderLots(); check();
  });
  find('confirm-opening-import').addEventListener('click', () => {
    check();
    if (!ready) return;
    try { apply(ready); dialog.close(); }
    catch (error) { ready = null; find('confirm-opening-import').disabled = true; message(error.message); }
  });
  dialog.addEventListener('close', () => {
    revision += 1;
    source = workbook = ready = null; lots = {}; quantities = {};
    find('opening-lots').replaceChildren();
    find('opening-source-summary').replaceChildren();
    onClose();
  });
  return {
    open() {
      revision += 1;
      source = workbook = ready = null; lots = {}; quantities = {}; page = 0;
      find('opening-file').value = '';
      find('opening-snapshot-date').value = '';
      find('opening-timing').value = '';
      find('opening-value-meaning').value = '';
      for (const id of ['opening-replace-confirm', 'opening-costs-confirm', 'opening-euro-confirm']) find(id).checked = false;
      find('opening-review').hidden = find('opening-sheet-field').hidden = true;
      find('confirm-opening-import').disabled = true;
      find('opening-date-preview').textContent = '';
      const current = getDataset();
      find('opening-current').textContent = `La sessione contiene ${current.initialLots.length} lotti iniziali e ${current.transactions.length} operazioni. La conferma sostituisce i lotti e aggiorna la data iniziale; le operazioni e le minusvalenze vengono convalidate con i nuovi saldi.`;
      message('');
      dialog.showModal();
      dialog.scrollTop = 0;
    }
  };
}
