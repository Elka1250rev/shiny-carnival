import { Decimal } from './decimal.js';
import { calculate } from './engine.js';
import { exportCsv, exportReportCsv, parseImport } from './csv.js';
import { bindTransactionOrder } from './transaction-order.js';
import { createImportSession } from './import-session.js';
import { parseExchangeCsv } from './exchange-csv.js';
import { convertExchangeCsv } from './exchange-import.js';
import { createExchangeReview } from './exchange-review.js';
import { createOpeningImport } from './opening-review.js';
import { buildPdfReportData } from './pdf-report.js';
import { createPdfDownload } from './pdf-download.js';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const freshDataset = () => ({ version: 1, openingDate: '2025-01-01', initialLots: [], transactions: [], carryLosses: [] });
let dataset = freshDataset();
let selectedYear = 2026;
let view = 'transactions';
let editing = null;
const importSession = createImportSession((content, name) => {
  if (String(content).split(/\r\n|\r|\n/, 1)[0].includes('datetime_tz_CET')) return { kind: 'exchange', source: parseExchangeCsv(content) };
  const imported = parseImport(content, name);
  calculate(imported, Math.max(selectedYear, Number(imported.openingDate.slice(0, 4))));
  exportCsv(imported);
  return { kind: 'canonical', dataset: imported };
});
let reviewedDataset = null;
let reviewTimer;
let addingImportLot = false;
const exchangeReview = createExchangeReview({ container: $('exchange-review'), onChange: () => {
  reviewedDataset = null;
  $('confirm-import').disabled = true;
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(reviewExchange, 120);
}, onAddInitialLot: asset => {
  clearTimeout(reviewTimer);
  reviewedDataset = null;
  $('confirm-import').disabled = true;
  addingImportLot = true;
  openEntry('initialLots');
  $('field-asset').value = asset;
  // A quantity shortfall is not evidence of an acquisition date or tax cost.
  $('field-acquiredOn').value = '';
  $('entry-description').textContent += ' Il lotto viene salvato subito nella sessione, anche se annulli poi l’importazione. Il CSV sarà applicato solo dopo la conferma finale.';
}, onImportInitial: () => {
  clearTimeout(reviewTimer);
  reviewedDataset = null;
  $('confirm-import').disabled = true;
  openingImport.open();
} });
const openingImport = createOpeningImport({
  dialog: $('opening-import-dialog'), getDataset: () => dataset,
  validate: next => {
    calculate(next, Math.max(selectedYear, Number(next.openingDate.slice(0, 4))));
    exportCsv(next);
  },
  apply: next => {
    commit(next, 'Situazione iniziale importata. Esporta il CSV della sessione per conservarla.');
    if (!exchangeReview.active) { view = 'lots'; renderLedger(); }
  },
  onClose: () => {
    if (!exchangeReview.active || !$('import-dialog').open) return;
    exchangeReview.updateDataset(dataset);
    reviewExchange();
  }
});
let confirmationAction = null;
let toastTimer;
let result = calculate(dataset, selectedYear);
const pdfDownload = createPdfDownload({
  button: $('pdf-button'), link: $('pdf-download-link'),
  status: $('pdf-download-status'), container: $('pdf-download-notice'),
  URL, Blob,
  build: async report => {
    const { buildPdfDocument } = await import('./pdf-document.js');
    return buildPdfDocument(report, { document });
  }
});
window.addEventListener('pagehide', () => pdfDownload.reset());

const labels = {
  transactions: { title: 'Le tue operazioni', breadcrumb: 'Operazioni', eyebrow: 'IL DIARIO DEL PORTAFOGLIO', button: 'Nuova operazione', emptyTitle: 'Ogni conto parte da un movimento.', emptyText: 'Inserisci i lotti iniziali, oppure aggiungi il tuo primo acquisto. Il resto lo calcoliamo insieme.', emptyButton: 'Inserisci la situazione iniziale', footnote: 'Operazioni di tutti gli anni, ordinate per data e sequenza.' },
  holdings: { title: 'Le tue posizioni', breadcrumb: 'Posizioni', eyebrow: 'LA COMPOSIZIONE DEL PORTAFOGLIO', button: 'Nuova operazione', emptyTitle: 'Il tuo portafoglio è ancora da comporre.', emptyText: 'Aggiungi un lotto iniziale o un acquisto per vedere le quantità e i costi residui.', emptyButton: 'Aggiungi un acquisto', footnote: 'Quantità e costi dopo tutte le operazioni, anche oltre l’anno selezionato.' },
  lots: { title: 'La situazione iniziale', breadcrumb: 'Situazione iniziale', eyebrow: 'IL PUNTO DI PARTENZA', button: 'Aggiungi un lotto', emptyTitle: 'Partiamo da ciò che possiedi.', emptyText: 'Per ogni lotto residuo inserisci quantità, costo unitario e data originaria di acquisto.', emptyButton: 'Aggiungi un lotto iniziale', footnote: 'Una riga per ciascun lotto residuo alla data iniziale.' },
  losses: { title: 'Le minusvalenze pregresse', breadcrumb: 'Minusvalenze pregresse', eyebrow: 'I RESIDUI GIÀ DICHIARATI', button: 'Aggiungi un residuo', emptyTitle: 'Hai minusvalenze da riportare?', emptyText: 'Inserisci solo i residui crypto già dichiarati e disponibili all’apertura, con l’anno di origine.', emptyButton: 'Aggiungi una minusvalenza', footnote: 'Residui disponibili all’apertura; utilizzabili entro il quarto anno successivo.' }
};

function formatDecimal(value, places = 2, trim = false) {
  if (value === null || value === undefined) return '—';
  const rounded = Decimal.from(value).toFixed(places);
  let [integer, fraction] = rounded.split('.');
  const negative = integer.startsWith('-');
  if (negative) integer = integer.slice(1);
  integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (trim && fraction) fraction = fraction.replace(/0+$/, '');
  return (negative ? '−' : '') + integer + (fraction ? ',' + fraction : '');
}
const money = value => value === null || value === undefined ? '—' : formatDecimal(value) + ' €';
const quantity = value => formatDecimal(value, 18, true);
const dateLabel = value => String(value).split('-').reverse().join('/');
const signedMoney = value => value === null || value === undefined ? '—' : (Decimal.from(value).cmp('0') > 0 ? '+' : '') + money(value);
const numericClass = value => value && Decimal.from(value).cmp('0') < 0 ? 'negative' : value && Decimal.from(value).cmp('0') > 0 ? 'positive' : '';
const id = prefix => prefix + '-' + crypto.randomUUID();
const rowCount = () => dataset.initialLots.length + dataset.transactions.length + dataset.carryLosses.length;
const errorText = error => error.errors ? error.errors.map(entry => (entry.line ? 'Riga CSV ' + entry.line : friendlyLocation(entry.location || 'Dati')) + ': ' + entry.message).slice(0, 5).join('\n') : error.message;
function friendlyLocation(location) {
  return location.replace(/initialLots\[(\d+)\]/g, (_, index) => 'Lotto ' + (Number(index) + 1)).replace(/transactions\[(\d+)\]/g, (_, index) => 'Operazione ' + (Number(index) + 1)).replace(/carryLosses\[(\d+)\]/g, (_, index) => 'Minusvalenza ' + (Number(index) + 1)).replace('openingDate', 'Data iniziale');
}
function notify(message, isError = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', isError);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, isError ? 12000 : 5500);
}
function showDialog(name) { $(name).showModal(); }
function confirm(title, description, action, button = 'Conferma') {
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = description;
  $('confirm-action').textContent = button;
  confirmationAction = action;
  showDialog('confirm-dialog');
}
function commit(next, message) {
  const nextYear = Math.max(selectedYear, Number(next.openingDate.slice(0, 4)));
  const computed = calculate(next, nextYear);
  // A temporary session must remain exportable in the recoverable format.
  exportCsv(next);
  pdfDownload.reset();
  dataset = next;
  selectedYear = nextYear;
  result = computed;
  render();
  if (message) notify(message);
}
function assetCell(asset) {
  const normalized = asset.toLowerCase();
  const icon = normalized === 'btc' || normalized === 'bitcoin' ? '₿' : normalized === 'eth' || normalized === 'ethereum' ? '♦' : asset.slice(0, 1);
  const kind = icon === '₿' ? 'btc' : icon === '♦' ? 'eth' : '';
  return `<div class="asset-cell"><span class="coin-avatar ${kind}" aria-hidden="true">${escapeHtml(icon)}</span><span class="asset-name">${escapeHtml(asset)}</span></div>`;
}
const typeLabel = type => ({ acquisto: 'Acquisto', vendita: 'Vendita', permuta_neutrale: 'Permuta neutrale', permuta_imponibile: 'Permuta imponibile', provento: 'Provento da detenzione', deposito_eur: 'Deposito EUR' })[type] || type;
const documentedPrize = row => row.source?.decisions?.rewardTreatment === 'documented_acquisition' && !row.source.derived;
const operationLabel = row => documentedPrize(row) ? 'Premio · costo documentato' : typeLabel(row.type);
const fiscalLabel = row => documentedPrize(row) ? 'Altri obblighi fiscali da verificare' : row.fiscalKind === 'neutral' ? 'Costo storico trasferito' : row.fiscalKind === 'income' ? 'Imponibile alla percezione' : row.fiscalKind === 'fiat' ? 'Movimento informativo' : row.fiscalKind === 'capital_gain' ? 'Costo LIFO ' + money(row.costBasis) : 'Nessun realizzo';
function transactionRow(row) {
  const fiat = row.fiscalKind === 'fiat';
  const balance = (before) => fiat ? '—' : quantity(row[before ? 'beforeQuantity' : 'afterQuantity']) + `<span class="subvalue">PM ${Decimal.from(row[before ? 'beforeQuantity' : 'afterQuantity']).cmp('0') ? money(row[before ? 'beforeAverage' : 'afterAverage']) : '—'}</span>` + (row.receivedAsset ? `<span class="subvalue">${escapeHtml(row.receivedAsset)}: ${quantity(row[before ? 'receivedBeforeQuantity' : 'receivedAfterQuantity'])} · PM ${Decimal.from(row[before ? 'receivedBeforeQuantity' : 'receivedAfterQuantity']).cmp('0') ? money(row[before ? 'receivedBeforeAverage' : 'receivedAfterAverage']) : '—'}</span>` : '');
  const movement = `${quantity(row.quantity)} ${escapeHtml(row.asset)}` + (row.receivedAsset ? ` → ${quantity(row.receivedQuantity)} ${escapeHtml(row.receivedAsset)}` : row.totalEur !== undefined ? ` · ${money(row.totalEur)}` : ` × ${money(row.unitPrice)}`);
  return `<tr><td>${dateLabel(row.date)}<span class="subvalue">Sequenza ${row.order}</span></td><td>${assetCell(row.asset)}${row.receivedAsset ? `<span class="subvalue">→ ${escapeHtml(row.receivedAsset)}</span>` : ''}</td><td><span class="operation-tag ${row.fiscalKind === 'capital_gain' ? 'sell' : ''}">${escapeHtml(operationLabel(row))}</span><span class="subvalue">${movement}</span></td><td class="numeric">${balance(true)}</td><td class="numeric">${balance(false)}</td><td class="numeric ${numericClass(row.fiscalResult)}">${signedMoney(row.fiscalResult)}<span class="subvalue">${fiscalLabel(row)}</span></td><td>${actionButtons(row.id, 'transactions', true, Boolean(row.source || row.totalEur !== undefined || !['acquisto', 'vendita'].includes(row.type)))}</td></tr>`;
}
function actionButtons(recordId, kind, details = false, readOnly = false) {
  const safeId = escapeHtml(recordId);
  return `<div class="row-actions">${details ? `<button data-detail="${safeId}" title="Dettaglio del calcolo" aria-label="Dettaglio del calcolo">↗</button>` : ''}${readOnly ? '' : `<button data-edit="${safeId}" data-kind="${kind}" title="Modifica" aria-label="Modifica">✎</button>`}<button data-delete="${safeId}" data-kind="${kind}" title="Elimina" aria-label="Elimina">×</button></div>`;
}
function emptyState(filtered = false) {
  const copy = labels[view];
  return `<div class="empty-state"><div class="empty-illustration" aria-hidden="true">${filtered ? '⌕' : '↗'}</div><h3>${filtered ? 'Nessuna crypto corrisponde al filtro.' : copy.emptyTitle}</h3><p>${filtered ? 'Prova un nome differente oppure cancella la ricerca.' : copy.emptyText}</p>${filtered ? '<button class="button button-outline" data-reset-search>Mostra tutto</button>' : `<button class="button button-outline" data-empty-action>${copy.emptyButton} <span aria-hidden="true">+</span></button>`}</div>`;
}
function render() {
  const tax = result.tax;
  $('tax-year').value = String(selectedYear);
  $('tax-year').querySelector('option[value="2025"]').disabled = dataset.openingDate >= '2026-01-01';
  $('metric-net').textContent = money(tax.net);
  $('metric-net').className = numericClass(tax.net);
  $('metric-taxable').textContent = money(tax.taxable);
  $('metric-tax').textContent = money(tax.tax);
  $('metric-rate').textContent = tax.rate + '%';
  $('metric-tax-caption').textContent = 'Imposta sostitutiva · anno ' + selectedYear;
  $('metric-cost').textContent = money(result.holdings.reduce((total, holding) => total.add(holding.fiscalCost), Decimal.from('0')));
  $('summary-year').textContent = selectedYear;
  $('summary-gains').textContent = money(tax.gains);
  $('summary-gains-label').textContent = Decimal.from(tax.income || '0').cmp('0') ? 'Plusvalenze e proventi' : 'Plusvalenze realizzate';
  $('metric-net-caption').textContent = Decimal.from(tax.income || '0').cmp('0') ? 'Plusvalenze e proventi meno minusvalenze' : 'Plusvalenze meno minusvalenze';
  $('summary-income').textContent = Decimal.from(tax.income || '0').cmp('0') ? 'Di cui proventi da detenzione: ' + money(tax.income) : '';
  $('summary-losses').textContent = '− ' + money(tax.losses);
  $('summary-used').textContent = '− ' + money(tax.lossesUsed);
  $('summary-taxable').textContent = money(tax.taxable);
  $('summary-tax').textContent = money(tax.tax);
  $('summary-rate').textContent = 'Aliquota ordinaria del ' + tax.rate + '%';
  $('opening-date-label').textContent = dateLabel(dataset.openingDate);
  const carry = tax.remainingLosses.map(loss => `<div><strong>${money(loss.amount)}</strong> da ${loss.originYear} · scadenza ${loss.expiresYear}</div>`).join('');
  const expired = tax.expiredLosses.map(loss => `<div>Residuo ${loss.originYear} scaduto: ${money(loss.amount)}</div>`).join('');
  $('carry-summary').innerHTML = carry || expired ? `<div>Minusvalenze residue / scadute</div>${carry}${expired}` : '';
  renderLedger();
}
function renderLedger() {
  const copy = labels[view];
  $('breadcrumb-view').textContent = copy.breadcrumb;
  $('view-eyebrow').textContent = copy.eyebrow;
  $('view-title').firstChild.textContent = copy.title + ' ';
  $('add-button').innerHTML = '<span aria-hidden="true">+</span> ' + copy.button;
  $('ledger-footnote').textContent = copy.footnote;
  $('asset-filter').disabled = view === 'losses';
  $('report-button').hidden = view !== 'transactions';
  $('pdf-button').hidden = view !== 'transactions';
  $('opening-import-button').hidden = view !== 'lots';
  document.querySelectorAll('[data-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.view === view);
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const filter = $('asset-filter').value.trim().toUpperCase();
  const source = view === 'transactions' ? result.rows : view === 'holdings' ? result.holdings : view === 'lots' ? dataset.initialLots : dataset.carryLosses;
  const records = view === 'losses' ? source : source.filter(record => !filter || record.asset.includes(filter) || record.receivedAsset?.includes(filter));
  $('record-count').textContent = source.length;
  let html = '';
  if (!records.length) html = emptyState(Boolean(source.length && filter));
  else if (view === 'transactions') {
    html = `<div class="table-scroll"><table><thead><tr><th>DATA / ORDINE</th><th>CRYPTO</th><th>OPERAZIONE</th><th class="numeric">PRIMA</th><th class="numeric">DOPO</th><th class="numeric">RISULTATO FISCALE</th><th><span class="sr-only">Azioni</span></th></tr></thead><tbody>${records.map(transactionRow).join('')}</tbody></table></div>`;
  } else if (view === 'holdings') {
    html = `<div class="table-scroll"><table><thead><tr><th>CRYPTO</th><th class="numeric">QUANTITÀ RESIDUA</th><th class="numeric">PREZZO MEDIO GESTIONALE</th><th class="numeric">COSTO FISCALE RESIDUO</th></tr></thead><tbody>${records.map(holding => `<tr><td>${assetCell(holding.asset)}</td><td class="numeric">${quantity(holding.quantity)}</td><td class="numeric">${Decimal.from(holding.quantity).cmp('0') ? money(holding.average) : '—'}<span class="subvalue">Costo gestionale ${money(holding.cost)}</span></td><td class="numeric">${money(holding.fiscalCost)}<span class="subvalue">Media lotti ${Decimal.from(holding.quantity).cmp('0') ? money(holding.fiscalAverage) : '—'}</span></td></tr>`).join('')}</tbody></table></div>`;
  } else if (view === 'lots') {
    html = `<div class="table-scroll"><table><thead><tr><th>ACQUISTO ORIGINARIO</th><th>CRYPTO</th><th class="numeric">QUANTITÀ</th><th class="numeric">COSTO UNITARIO</th><th><span class="sr-only">Azioni</span></th></tr></thead><tbody>${records.map(lot => `<tr><td>${dateLabel(lot.acquiredOn)}<span class="subvalue">Sequenza ${lot.order}</span></td><td>${assetCell(lot.asset)}</td><td class="numeric">${quantity(lot.quantity)}</td><td class="numeric">${money(lot.unitCost)}<span class="subvalue">Totale ${money(Decimal.from(lot.quantity).mul(lot.unitCost))}</span></td><td>${actionButtons(lot.id, 'initialLots')}</td></tr>`).join('')}</tbody></table></div>`;
  } else {
    html = `<div class="table-scroll"><table><thead><tr><th>ANNO DI ORIGINE</th><th class="numeric">RESIDUO ALL’APERTURA</th><th>UTILIZZABILE FINO AL</th><th><span class="sr-only">Azioni</span></th></tr></thead><tbody>${records.map(loss => `<tr><td>${loss.year}</td><td class="numeric">${money(loss.amount)}</td><td>${loss.year + 4}</td><td>${actionButtons(loss.id, 'carryLosses')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (result.warnings.length) html += `<div class="warning-block">${result.warnings.map(escapeHtml).join('<br>')}</div>`;
  $('ledger-content').innerHTML = html;
}
function field(name, label, value = '', options = {}) {
  const safeValue = escapeHtml(value);
  const attributes = `${options.required === false ? '' : ' required'}${options.min !== undefined ? ` min="${options.min}"` : ''}${options.max !== undefined ? ` max="${options.max}"` : ''}${options.step !== undefined ? ` step="${options.step}"` : ''}`;
  const input = options.choices ? `<select id="field-${name}" name="${name}"${attributes}>${options.choices.map(choice => `<option value="${escapeHtml(choice.value)}" ${String(value) === String(choice.value) ? 'selected' : ''}>${escapeHtml(choice.label)}</option>`).join('')}</select>` : `<input id="field-${name}" name="${name}" type="${options.type || 'text'}" value="${safeValue}"${attributes}${options.decimal ? ' inputmode="decimal"' : ''} autocomplete="off"${options.maxLength ? ` maxlength="${options.maxLength}"` : ''}>`;
  return `<div class="form-field ${options.full ? 'full' : ''}"><label for="field-${name}">${label}</label>${input}${options.hint ? `<small>${options.hint}</small>` : ''}</div>`;
}
function nextOrder(records) { return Math.max(0, ...records.map(record => record.order || 0)) + 1; }
function openEntry(kind = 'transactions', recordId = null) {
  const record = recordId ? dataset[kind].find(item => item.id === recordId) : null;
  if (kind === 'transactions' && record && (record.source || !['acquisto', 'vendita'].includes(record.type) || record.totalEur !== undefined)) {
    showDetails(recordId);
    notify('Operazione importata: per rettificare i dati fiscali ricarica il CSV originale e usa le rettifiche nell’anteprima.');
    return;
  }
  editing = { kind, id: recordId };
  $('entry-error').hidden = true;
  const today = new Date().toISOString().slice(0, 10);
  const currentDate = today >= dataset.openingDate && today <= '2026-12-31' ? today : dataset.openingDate;
  let fields;
  if (kind === 'transactions') {
    $('entry-title').textContent = record ? 'Modifica operazione' : 'Nuova operazione';
    $('entry-description').textContent = 'Acquisti e vendite contro euro. Il prezzo è per una singola unità della crypto; le commissioni sono in euro.';
    fields = field('type', 'Operazione', record?.type || 'acquisto', { choices: [{ value: 'acquisto', label: 'Acquisto' }, { value: 'vendita', label: 'Vendita' }] })
      + field('asset', 'Crypto / identificatore', record?.asset || '', { maxLength: 50, hint: 'Es. BTC, ETH. Usa sempre lo stesso identificatore.' })
      + field('date', 'Data', record?.date || currentDate, { type: 'date', min: dataset.openingDate, max: '2026-12-31' })
      + field('order', 'Sequenza nella giornata', record?.order ?? 1, { type: 'number', min: 0, step: 1, hint: 'Determina l’ordine tra operazioni della stessa data.' })
      + field('quantity', 'Quantità', record?.quantity || '', { decimal: true, hint: 'Puoi usare la virgola o il punto decimale.' })
      + field('unitPrice', 'Prezzo unitario (€)', record?.unitPrice || '', { decimal: true })
      + field('fees', 'Commissioni gestionali (€)', record?.fees || '0', { decimal: true, full: true, hint: 'Pagate in euro: incidono sul risultato gestionale, non sono dedotte dal risultato fiscale. Prezzo e quantità devono essere lordi verificati.' });
  } else if (kind === 'initialLots') {
    $('entry-title').textContent = record ? 'Modifica lotto iniziale' : 'Nuovo lotto iniziale';
    $('entry-description').textContent = 'Inserisci un lotto ancora disponibile al ' + dateLabel(dataset.openingDate) + '. Per un LIFO corretto conserva le date e i costi originari dei lotti.';
    fields = field('asset', 'Crypto / identificatore', record?.asset || '', { maxLength: 50, full: true })
      + field('acquiredOn', 'Data originaria di acquisto', record?.acquiredOn || dataset.openingDate, { type: 'date', max: dataset.openingDate })
      + field('order', 'Sequenza di acquisto', record?.order ?? nextOrder(dataset.initialLots), { type: 'number', min: 0, step: 1, hint: 'Ordina i lotti acquistati nella stessa giornata.' })
      + field('quantity', 'Quantità residua all’apertura', record?.quantity || '', { decimal: true })
      + field('unitCost', 'Costo unitario fiscale documentato (€)', record?.unitCost || '', { decimal: true, hint: 'Escludi commissioni e oneri accessori. Verifica anche i lotti salvati con versioni precedenti del sito.' });
  } else if (kind === 'carryLosses') {
    const openingYear = Number(dataset.openingDate.slice(0, 4));
    $('entry-title').textContent = record ? 'Modifica residuo pregresso' : 'Minusvalenza pregressa';
    $('entry-description').textContent = 'Inserisci il residuo crypto già dichiarato, non ancora compensato e disponibile alla data iniziale. Per ciascun anno usa una sola riga.';
    fields = field('year', 'Anno di origine', record?.year || openingYear - 1, { type: 'number', min: 2021, max: openingYear - 1, step: 1 })
      + field('amount', 'Residuo disponibile (€)', record?.amount || '', { decimal: true, hint: 'Il residuo può essere inferiore alla perdita originaria.' });
  } else {
    $('entry-title').textContent = 'Data della situazione iniziale';
    $('entry-description').textContent = 'I lotti rappresentano le disponibilità a questa data. Per un anno completo usa il 1° gennaio e inserisci tutte le operazioni successive.';
    fields = field('openingDate', 'Data iniziale', dataset.openingDate, { type: 'date', min: '2025-01-01', max: '2026-12-31', full: true, hint: 'La modifica ricalcola e convalida tutti i dati esistenti.' });
  }
  $('entry-fields').innerHTML = fields;
  if (kind === 'transactions') {
    bindTransactionOrder($('field-date'), $('field-order'), dataset.transactions, record);
  }
  showDialog('entry-dialog');
}
function readAmount(value) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d{1,30}(?:\.\d{1,18})?$/.test(normalized)) throw new Error('Usa numeri non negativi senza separatori delle migliaia, con al massimo 18 decimali.');
  return normalized.replace(/^0+(?=\d)/, '');
}
function saveEntry(event) {
  event.preventDefault();
  const form = $('entry-form');
  if (!form.reportValidity()) return;
  const input = Object.fromEntries(new FormData(form));
  const next = structuredClone(dataset);
  try {
    const { kind, id: recordId } = editing;
    if (kind === 'config') next.openingDate = input.openingDate;
    else {
      let row;
      if (kind === 'transactions') row = { id: recordId || id('tx'), asset: input.asset.trim().toUpperCase(), date: input.date, type: input.type, order: Number(input.order), quantity: readAmount(input.quantity), unitPrice: readAmount(input.unitPrice), fees: readAmount(input.fees) };
      else if (kind === 'initialLots') row = { id: recordId || id('lotto'), asset: input.asset.trim().toUpperCase(), acquiredOn: input.acquiredOn, order: Number(input.order), quantity: readAmount(input.quantity), unitCost: readAmount(input.unitCost) };
      else row = { id: recordId || id('perdita'), year: Number(input.year), amount: readAmount(input.amount) };
      const index = recordId ? next[kind].findIndex(item => item.id === recordId) : -1;
      if (index >= 0) next[kind][index] = row;
      else next[kind].push(row);
    }
    commit(next, 'Dati aggiornati. Portafoglio e imposta ricalcolati.');
    $('entry-dialog').close();
  } catch (error) {
    $('entry-error').textContent = errorText(error);
    $('entry-error').hidden = false;
  }
}
function deleteRecord(kind, recordId) {
  confirm('Eliminare questa riga?', 'Il portafoglio sarà ricalcolato. L’eliminazione viene applicata solo se le operazioni rimanenti restano valide.', () => {
    const next = structuredClone(dataset);
    next[kind] = next[kind].filter(item => item.id !== recordId);
    try { commit(next, 'Riga eliminata e calcoli aggiornati.'); }
    catch (error) { notify(errorText(error), true); }
  }, 'Elimina e ricalcola');
}
function showDetails(recordId) {
  const row = result.rows.find(item => item.id === recordId);
  if (!row) return;
  $('detail-title').textContent = operationLabel(row) + ' ' + row.asset + (row.receivedAsset ? ' → ' + row.receivedAsset : '');
  const pair = (label, value) => `<div class="detail-pair"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`;
  const balances = (before) => pair('Quantità ' + row.asset, quantity(row[before ? 'beforeQuantity' : 'afterQuantity']))
    + pair('Prezzo medio gestionale', money(row[before ? 'beforeAverage' : 'afterAverage']))
    + pair('Costo medio dei lotti fiscali', money(row[before ? 'fiscalBeforeAverage' : 'fiscalAfterAverage']))
    + (row.receivedAsset ? pair('Quantità ' + row.receivedAsset, quantity(row[before ? 'receivedBeforeQuantity' : 'receivedAfterQuantity'])) + pair('Prezzo medio gestionale ' + row.receivedAsset, money(row[before ? 'receivedBeforeAverage' : 'receivedAfterAverage'])) : '');
  const source = row.source?.values;
  const sourceHtml = source ? `<details><summary>Dati originali del CSV e scelte confermate</summary><p class="small-note">Per rettificare, ricarica il CSV della piattaforma. Gli importi originali sono conservati separatamente dai valori fiscali applicati.</p>${Object.entries(source).map(([key, value]) => pair(escapeHtml(key), value || '—')).join('')}${Object.entries(row.source.decisions || {}).map(([key, value]) => pair(escapeHtml(key), String(value))).join('')}</details>` : '';
  const realized = row.fiscalKind === 'capital_gain';
  const fiscalCostLabel = row.fiscalKind === 'neutral' ? 'Costo storico trasferito' : row.fiscalKind === 'income' ? 'Costo documentato dei token ricevuti' : 'Costo fiscale (commissioni escluse)';
  $('detail-content').innerHTML = `<p class="modal-description">${dateLabel(row.date)} · sequenza ${row.order} · ${quantity(row.quantity)} ${escapeHtml(row.asset)}${row.receivedAsset ? ` → ${quantity(row.receivedQuantity)} ${escapeHtml(row.receivedAsset)}` : ''}</p>${row.fiscalKind === 'fiat' ? '<p>Deposito EUR informativo: non modifica le posizioni crypto né il risultato fiscale.</p>' : `<div class="detail-grid"><section class="detail-block"><h3>Prima dell’operazione</h3>${balances(true)}</section><section class="detail-block"><h3>Dopo l’operazione</h3>${balances(false)}</section></div>`}<div class="detail-result">${row.totalEur !== undefined ? pair('Controvalore fiscale totale', money(row.totalEur)) : ''}${realized ? pair('Corrispettivo fiscale lordo', money(row.proceeds)) : ''}${pair(fiscalCostLabel, money(row.fiscalKind === 'income' ? row.rewardCostEur : row.costBasis))}${pair('Commissioni aggiuntive gestionali in euro', money(row.fees))}${realized ? pair('Risultato gestionale (prezzo medio)', signedMoney(row.managementResult)) : ''}${pair('Risultato fiscale', signedMoney(row.fiscalResult) + ' · ' + fiscalLabel(row))}${row.lotDatePolicy ? pair('Data dei lotti ricevuti', row.lotDatePolicy === 'historical' ? 'Storica dei lotti ceduti' : 'Data dello scambio') : ''}</div>${row.lotDetails.length ? `<h3 class="detail-table-caption">Lotti attribuiti all’operazione, dal più recente</h3><div class="table-scroll"><table class="detail-table"><thead><tr><th>ACQUISTO</th><th class="numeric">QUANTITÀ</th><th class="numeric">COSTO UNITARIO</th><th class="numeric">COSTO ATTRIBUITO</th></tr></thead><tbody>${row.lotDetails.map(lot => `<tr><td>${dateLabel(lot.acquiredOn)}<span class="subvalue">Sequenza ${lot.order}</span></td><td class="numeric">${quantity(lot.quantity)}</td><td class="numeric">${money(lot.unitCost)}</td><td class="numeric">${money(lot.cost)}</td></tr>`).join('')}</tbody></table></div>` : ''}${sourceHtml}<p class="small-note">Le commissioni non sono dedotte fiscalmente. I valori a video sono arrotondati per la lettura; l’imposta finale è arrotondata ai centesimi.</p>`;
  showDialog('detail-dialog');
}
function download(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportSession() {
  try { download(exportCsv(dataset), 'criptoconti-sessione-' + new Date().toISOString().slice(0, 10) + '.csv'); notify('CSV ricaricabile esportato sul tuo dispositivo.'); }
  catch (error) { notify(errorText(error), true); }
}
async function exportPdf() {
  try {
    const report = buildPdfReportData(result, dataset.openingDate);
    await pdfDownload.export(report, 'criptoconti-operazioni-anno-' + selectedYear + '.pdf');
  } catch (error) { notify(errorText(error), true); }
}
function exampleDataset() {
  return { version: 1, openingDate: '2025-01-01', initialLots: [{ id: 'esempio-btc-iniziale', asset: 'BTC', acquiredOn: '2024-07-01', order: 1, quantity: '0.2', unitCost: '40000' }, { id: 'esempio-eth-iniziale', asset: 'ETH', acquiredOn: '2024-09-01', order: 2, quantity: '2', unitCost: '2400' }], transactions: [{ id: 'esempio-acquisto-btc', date: '2026-01-10', order: 1, type: 'acquisto', asset: 'BTC', quantity: '0.1', unitPrice: '50000', fees: '10' }, { id: 'esempio-vendita-eth', date: '2026-02-02', order: 2, type: 'vendita', asset: 'ETH', quantity: '0.5', unitPrice: '2100', fees: '5' }, { id: 'esempio-vendita-btc', date: '2026-02-10', order: 3, type: 'vendita', asset: 'BTC', quantity: '0.05', unitPrice: '60000', fees: '5' }, { id: 'esempio-acquisto-eth', date: '2026-03-20', order: 4, type: 'acquisto', asset: 'ETH', quantity: '0.4', unitPrice: '2200', fees: '3' }], carryLosses: [{ id: 'esempio-perdita-2024', year: 2024, amount: '100' }] };
}
function loadExample() {
  const load = () => { selectedYear = 2026; $('asset-filter').value = ''; view = 'transactions'; commit(exampleDataset(), 'Esempio caricato. Puoi modificarlo, esportarlo o svuotare la sessione.'); };
  if (rowCount()) confirm('Caricare l’esempio?', 'L’esempio sostituirà i dati della sessione. Esporta prima il CSV se vuoi conservarli.', load, 'Sostituisci con l’esempio');
  else load();
}
function openImport() {
  $('import-file').value = '';
  resetImport();
  showDialog('import-dialog');
  $('import-dialog').scrollTop = 0;
}
function resetImport() {
  clearTimeout(reviewTimer);
  reviewedDataset = null;
  exchangeReview.hide();
  importSession.reset();
  $('import-preview').hidden = true;
  $('import-error').hidden = true;
  $('confirm-import').disabled = true;
}
function reviewExchange() {
  reviewedDataset = null;
  $('confirm-import').disabled = true;
  const selection = importSession.pending;
  if (selection?.kind !== 'exchange' || !exchangeReview.active) return;
  let candidate = null;
  try {
    const converted = convertExchangeCsv(selection.source, dataset, exchangeReview.getOptions());
    candidate = converted.dataset;
    calculate(converted.dataset, Math.max(selectedYear, Number(converted.dataset.openingDate.slice(0, 4))));
    exportCsv(converted.dataset);
    reviewedDataset = converted.dataset;
    exchangeReview.setErrors([]);
    $('import-preview').textContent = `Pronto: ${converted.dataset.transactions.length} operazioni totali. I lotti iniziali e le minusvalenze della sessione saranno conservati.`;
    $('import-preview').hidden = false;
    $('confirm-import').disabled = false;
  } catch (error) {
    $('import-preview').hidden = true;
    const errors = error.errors?.map(entry => {
      const match = /^transactions\[(\d+)\]/.exec(entry.location || '');
      const source = match && candidate?.transactions[Number(match[1])]?.source;
      if (source) return { ...entry, line: source.line, message: (source.derived ? 'Commissione in terza crypto: ' : '') + entry.message };
      return { ...entry, message: (entry.location ? friendlyLocation(entry.location) + ': ' : '') + entry.message };
    }) || [error.message];
    exchangeReview.setErrors(errors);
  }
}
async function readFile(file) {
  resetImport();
  try {
    const selection = await importSession.read(file);
    if (!selection) return;
    if (selection.dataset.kind === 'exchange') {
      exchangeReview.show(selection.dataset.source, dataset);
      reviewExchange();
      return;
    }
    const imported = selection.dataset.dataset;
    $('import-preview').textContent = '';
    const heading = document.createElement('strong');
    heading.textContent = 'File valido: ' + selection.name;
    const details = document.createElement('div');
    details.textContent = `${imported.initialLots.length} lotti iniziali · ${imported.transactions.length} operazioni · ${imported.carryLosses.length} minusvalenze pregresse. Situazione iniziale: ${dateLabel(imported.openingDate)}. Verifica i costi dei vecchi file: le commissioni non sono deducibili fiscalmente.`;
    $('import-preview').append(heading, details);
    $('import-preview').hidden = false;
    $('confirm-import').disabled = false;
  } catch (error) { $('import-error').textContent = errorText(error); $('import-error').hidden = false; }
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.view; $('asset-filter').value = ''; renderLedger(); }));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
['open-rules', 'scope-rules'].forEach(name => $(name).addEventListener('click', () => showDialog('rules-dialog')));
$('tax-year').addEventListener('change', () => { pdfDownload.reset(); selectedYear = Number($('tax-year').value); result = calculate(dataset, selectedYear); render(); });
$('asset-filter').addEventListener('input', renderLedger);
$('add-button').addEventListener('click', () => openEntry(view === 'lots' ? 'initialLots' : view === 'losses' ? 'carryLosses' : 'transactions'));
$('entry-form').addEventListener('submit', saveEntry);
$('entry-dialog').addEventListener('close', () => {
  if (!addingImportLot) return;
  addingImportLot = false;
  if (!exchangeReview.active || !$('import-dialog').open) return;
  exchangeReview.updateDataset(dataset);
  reviewExchange();
});
$('config-button').addEventListener('click', () => openEntry('config'));
$('clear-button').addEventListener('click', () => confirm('Svuotare la sessione?', 'Tutti i dati inseriti verranno rimossi dalla pagina. Per conservarli, esporta il CSV prima di procedere.', () => { selectedYear = 2026; view = 'transactions'; $('asset-filter').value = ''; commit(freshDataset(), 'Sessione svuotata.'); }, 'Svuota sessione'));
$('confirm-action').addEventListener('click', () => { $('confirm-dialog').close(); const action = confirmationAction; confirmationAction = null; action?.(); });
['export-button', 'privacy-export'].forEach(name => $(name).addEventListener('click', exportSession));
$('report-button').addEventListener('click', () => { download(exportReportCsv(result.rows), 'criptoconti-prospetto-operazioni.csv'); notify('Prospetto di tutte le operazioni esportato. Per riprendere la sessione usa “Esporta dati”.'); });
$('pdf-button').addEventListener('click', exportPdf);
$('demo-button').addEventListener('click', loadExample);
$('template-button').addEventListener('click', () => download(exportCsv(exampleDataset()), 'criptoconti-esempio.csv'));
$('import-button').addEventListener('click', openImport);
$('opening-import-button').addEventListener('click', () => openingImport.open());
$('import-dialog').addEventListener('close', resetImport);
$('import-file').addEventListener('change', event => { if (event.target.files[0]) readFile(event.target.files[0]); else resetImport(); });
$('confirm-import').addEventListener('click', () => {
  const pending = importSession.pending;
  if (!pending) return;
  try {
    if (pending.kind === 'exchange') reviewExchange();
    const next = pending.kind === 'exchange' ? reviewedDataset : pending.dataset;
    if (!next) return;
    commit(next, 'Sessione importata. Tutti i risultati sono stati ricalcolati.');
    resetImport();
    $('import-dialog').close();
  } catch (error) { $('import-error').textContent = errorText(error); $('import-error').hidden = false; }
});
['dragover', 'dragenter'].forEach(eventName => $('drop-zone').addEventListener(eventName, event => { event.preventDefault(); $('drop-zone').classList.add('dragover'); }));
['dragleave', 'drop'].forEach(eventName => $('drop-zone').addEventListener(eventName, event => { event.preventDefault(); $('drop-zone').classList.remove('dragover'); if (eventName === 'drop' && event.dataTransfer.files[0]) readFile(event.dataTransfer.files[0]); }));
$('ledger-content').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.detail) showDetails(button.dataset.detail);
  else if (button.dataset.edit) openEntry(button.dataset.kind, button.dataset.edit);
  else if (button.dataset.delete) deleteRecord(button.dataset.kind, button.dataset.delete);
  else if (button.hasAttribute('data-reset-search')) { $('asset-filter').value = ''; renderLedger(); }
  else if (button.hasAttribute('data-empty-action')) openEntry(view === 'transactions' || view === 'lots' ? 'initialLots' : view === 'losses' ? 'carryLosses' : 'transactions');
});
window.addEventListener('beforeunload', event => { if (rowCount()) { event.preventDefault(); event.returnValue = ''; } });
render();
