import { Decimal } from './decimal.js';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
export function formatDecimal(value, places = 2, trim = false) {
  if (value === null || value === undefined) return '—';
  let [integer, fraction] = Decimal.from(value).toFixed(places).split('.');
  const negative = integer.startsWith('-');
  if (negative) integer = integer.slice(1);
  integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (trim && fraction) fraction = fraction.replace(/0+$/, '');
  return (negative ? '−' : '') + integer + (fraction ? ',' + fraction : '');
}
export const money = value => value === null || value === undefined ? '—' : formatDecimal(value) + ' €';
export const quantity = value => formatDecimal(value, 18, true);
export const unitMoney = value => value === null || value === undefined ? '—' : formatDecimal(value, 18, true) + ' €';
export const dateLabel = value => value ? String(value).split('-').reverse().join('/') : 'Data non disponibile';
export const signedMoney = value => value === null || value === undefined ? '—' : (Decimal.from(value).cmp('0') > 0 ? '+' : '') + money(value);
export const numericClass = value => value && Decimal.from(value).cmp('0') < 0 ? 'negative' : value && Decimal.from(value).cmp('0') > 0 ? 'positive' : '';
export const rowAmount = (row, key) => row.display?.[key] ?? row[key];
export const lotUnitMoney = lot => lot.display?.unitCostSign > 0 && Decimal.from(lot.display.unitCost).cmp('0') === 0
  ? 'Inferiore a 0,000000000000000001 €' : unitMoney(lot.display?.unitCost ?? lot.unitCost);
export function fiscalResultText(row) {
  if (row.fiscalResult === null || row.fiscalResult === undefined) return 'Nessun realizzo fiscale';
  const displayed = rowAmount(row, 'fiscalResult');
  const sign = row.display?.fiscalSign ?? Decimal.from(row.fiscalResult).cmp('0');
  if (sign && Decimal.from(displayed).cmp('0') === 0) return (sign > 0 ? '+ ' : '− ') + '< 0,005 €';
  return (sign > 0 ? '+' : '') + money(displayed);
}

export function assetCell(asset) {
  const normalized = asset.toLowerCase();
  const icon = normalized === 'btc' || normalized === 'bitcoin' ? '₿' : normalized === 'eth' || normalized === 'ethereum' ? '♦' : asset.slice(0, 1);
  const kind = icon === '₿' ? 'btc' : icon === '♦' ? 'eth' : '';
  return `<div class="asset-cell"><span class="coin-avatar ${kind}" aria-hidden="true">${escapeHtml(icon)}</span><span class="asset-name">${escapeHtml(asset)}</span></div>`;
}
const typeLabel = type => ({ acquisto: 'Acquisto', vendita: 'Vendita', permuta_neutrale: 'Permuta neutrale', permuta_imponibile: 'Permuta imponibile', provento: 'Provento da detenzione', deposito_eur: 'Deposito EUR' })[type] || type;
const documentedPrize = row => row.source?.decisions?.rewardTreatment === 'documented_acquisition' && !row.source.derived;
export const operationLabel = row => documentedPrize(row) ? 'Premio · costo documentato' : typeLabel(row.type);
export const fiscalLabel = row => documentedPrize(row) ? 'Altri obblighi fiscali da verificare' : row.fiscalKind === 'neutral' ? 'Costo storico trasferito: nessun realizzo' : row.fiscalKind === 'income' ? 'Provento imponibile alla percezione' : row.fiscalKind === 'fiat' ? 'Movimento informativo' : row.fiscalKind === 'capital_gain' ? 'Costo fiscale LIFO ' + money(rowAmount(row, 'costBasis')) : 'Nessun realizzo fiscale';
export function actionButtons(recordId, kind, details = false, readOnly = false) {
  const safeId = escapeHtml(recordId);
  return `<div class="row-actions card-actions">${details ? `<button type="button" data-detail="${safeId}" title="Dettaglio del calcolo">Dettaglio</button>` : ''}${readOnly ? '' : `<button type="button" data-edit="${safeId}" data-kind="${kind}">Modifica</button>`}<button type="button" data-delete="${safeId}" data-kind="${kind}">Elimina</button></div>`;
}

/** Select only the visible rows; the engine has already calculated the complete history. */
export function selectLedgerRecords(view, result, dataset, { year, showAllYears = false, assetFilter = '', page = 1, pageSize = 25 } = {}) {
  const source = view === 'transactions' ? result.rows : view === 'holdings' ? result.holdings : view === 'lots' ? dataset.initialLots : dataset.carryLosses;
  const filter = assetFilter.trim().toUpperCase();
  const yearRecords = view === 'transactions' && !showAllYears ? source.filter(row => row.date.startsWith(String(year) + '-')) : source;
  const records = view === 'losses' ? yearRecords : yearRecords.filter(row => !filter || row.asset.toUpperCase().includes(filter) || row.receivedAsset?.toUpperCase().includes(filter));
  const totalPages = view === 'transactions' ? Math.max(1, Math.ceil(records.length / pageSize)) : 1;
  const currentPage = Math.max(1, Math.min(Math.trunc(page) || 1, totalPages));
  const from = view === 'transactions' ? (currentPage - 1) * pageSize : 0;
  return { records, pageRows: view === 'transactions' ? records.slice(from, from + pageSize) : records,
    page: currentPage, totalPages, from: records.length ? from + 1 : 0,
    to: view === 'transactions' ? Math.min(from + pageSize, records.length) : records.length,
    sourceCount: source.length, yearCount: yearRecords.length };
}

const pair = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
const values = content => `<dl class="card-values">${content}</dl>`;
function balanceBlock(row, before) {
  const suffix = before ? 'Before' : 'After';
  const mainQuantity = row[before ? 'beforeQuantity' : 'afterQuantity'];
  const mainAverage = row[before ? 'beforeAverage' : 'afterAverage'];
  const main = pair('Quantità ' + row.asset, quantity(mainQuantity))
    + pair('Prezzo medio gestionale ' + row.asset, Decimal.from(mainQuantity).cmp('0') ? unitMoney(mainAverage) : '—');
  const received = row.receivedAsset ? pair('Quantità ' + row.receivedAsset, quantity(row['received' + suffix + 'Quantity']))
    + pair('Prezzo medio gestionale ' + row.receivedAsset, Decimal.from(row['received' + suffix + 'Quantity']).cmp('0') ? unitMoney(row['received' + suffix + 'Average']) : '—') : '';
  return `<section class="card-balance"><h4>${before ? 'Prima' : 'Dopo'} l’operazione</h4>${values(main + received)}</section>`;
}
function transactionCard(row) {
  const realized = row.fiscalKind === 'capital_gain';
  const sign = realized ? (row.display?.fiscalSign ?? Decimal.from(row.fiscalResult).cmp('0')) : 0;
  const resultLabel = row.fiscalKind === 'income' ? 'Provento da detenzione' : realized ? (sign < 0 ? 'Minusvalenza' : sign > 0 ? 'Plusvalenza' : 'Pareggio fiscale') : 'Trattamento fiscale';
  let movement = pair(row.receivedAsset ? 'Quantità ceduta' : 'Quantità', quantity(row.quantity) + ' ' + row.asset);
  movement += row.receivedAsset ? pair('Quantità ricevuta', quantity(row.receivedQuantity) + ' ' + row.receivedAsset)
    : row.totalEur !== undefined ? pair('Controvalore dell’operazione', money(row.totalEur)) : pair('Prezzo unitario', unitMoney(row.unitPrice));
  const formula = realized ? values(pair('Corrispettivo fiscale lordo', money(rowAmount(row, 'proceeds')))
    + pair('− Costo fiscale di carico LIFO', money(rowAmount(row, 'costBasis')))
    + pair('= ' + resultLabel, fiscalResultText(row))) : '';
  const result = realized ? formula : values(pair(resultLabel, row.fiscalKind === 'income' ? fiscalResultText(row) : fiscalLabel(row)));
  const roundingNote = realized && Decimal.from(rowAmount(row, 'proceeds')).sub(rowAmount(row, 'costBasis')).cmp(rowAmount(row, 'fiscalResult')) !== 0
    ? '<p class="card-note">Gli importi mostrati sono arrotondati ai centesimi; il risultato usa i valori esatti.</p>' : '';
  return `<article class="ledger-card" data-record-id="${escapeHtml(row.id)}"><div class="card-header"><h3>${escapeHtml(operationLabel(row))} · ${escapeHtml(row.asset)}${row.receivedAsset ? ' → ' + escapeHtml(row.receivedAsset) : ''}</h3><p class="card-meta">${dateLabel(row.date)} · sequenza ${row.order}</p></div><div class="card-movement">${values(movement)}</div><div class="card-result ${numericClass(row.fiscalResult)}">${result}${roundingNote}${row.fiscalKind === 'income' ? '<p class="card-note">Imponibile alla percezione. Il costo documentato dei token ricevuti è distinto dal provento.</p>' : ''}${documentedPrize(row) ? '<p class="card-note">Premio classificato come acquisizione: gli altri obblighi fiscali restano da verificare.</p>' : ''}</div>${row.fiscalKind === 'fiat' ? '<p class="card-note">Non modifica i saldi crypto.</p>' : `<div class="card-balances">${balanceBlock(row, true)}${balanceBlock(row, false)}</div>`}${actionButtons(row.id, 'transactions', true, Boolean(row.source || row.totalEur !== undefined || !['acquisto', 'vendita'].includes(row.type)))}</article>`;
}
function holdingCard(holding) {
  return `<article class="ledger-card" data-record-id="${escapeHtml(holding.asset)}"><div class="card-header"><h3>${escapeHtml(holding.asset)}</h3></div>${values(pair('Quantità residua', quantity(holding.quantity))
    + pair('Prezzo medio gestionale', Decimal.from(holding.quantity).cmp('0') ? unitMoney(holding.average) : '—')
    + pair('Costo gestionale residuo', money(holding.cost)) + pair('Costo fiscale residuo', money(holding.fiscalCost))
    + pair('Costo medio dei lotti fiscali', Decimal.from(holding.quantity).cmp('0') ? unitMoney(holding.fiscalAverage) : '—'))}</article>`;
}
function openingCard(lot) {
  return `<article class="ledger-card" data-record-id="${escapeHtml(lot.id)}"><div class="card-header"><h3>${escapeHtml(lot.asset)}</h3><p class="card-meta">Acquisto originario: ${dateLabel(lot.acquiredOn)} · sequenza ${lot.order}</p></div>${lot.basisMethod ? '<p class="card-note">Prezzo medio storico stimato · data originaria non disponibile</p>' : ''}${values(pair('Quantità iniziale', quantity(lot.quantity))
    + pair(lot.basisMethod ? 'Prezzo medio storico stimato' : 'Costo unitario fiscale', unitMoney(lot.unitCost))
    + pair('Costo fiscale iniziale', money(Decimal.from(lot.quantity).mul(lot.unitCost))))}${actionButtons(lot.id, 'initialLots')}</article>`;
}
function lossCard(loss) {
  return `<article class="ledger-card" data-record-id="${escapeHtml(loss.id)}"><div class="card-header"><h3>Minusvalenza ${loss.year}</h3></div>${values(pair('Residuo all’apertura', money(loss.amount)) + pair('Utilizzabile fino al', String(loss.year + 4)))}${actionButtons(loss.id, 'carryLosses')}</article>`;
}
export function renderLedgerCards(view, rows) {
  const renderer = view === 'transactions' ? transactionCard : view === 'holdings' ? holdingCard : view === 'lots' ? openingCard : lossCard;
  return `<div class="ledger-cards">${rows.map(renderer).join('')}</div>`;
}
export function renderConsumedLots(lots) {
  return `<div class="ledger-cards">${lots.map(lot => `<article class="ledger-card"><div class="card-header"><h3>${lot.acquiredOn ? 'Lotto del ' + dateLabel(lot.acquiredOn) : 'Lotto · data originaria non disponibile'}</h3><p class="card-meta">Sequenza ${lot.order} · ${escapeHtml(lot.lotId)}</p></div>${lot.basisMethod ? '<p class="card-note">Prezzo medio storico stimato</p>' : ''}${values(pair('Quantità ceduta', quantity(lot.quantity))
    + pair('Costo unitario fiscale', lotUnitMoney(lot))
    + pair('Costo fiscale attribuito', money(lot.display?.cost ?? lot.cost)))}</article>`).join('')}</div>`;
}
