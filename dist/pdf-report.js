import { Decimal } from './decimal.js';

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const dateLabel = value => String(value).split('-').reverse().join('/');

function formatDecimal(value, places = 2, trim = false) {
  const rounded = Decimal.from(value).toFixed(places);
  let [integer, fraction] = rounded.split('.');
  const negative = integer.startsWith('-');
  if (negative) integer = integer.slice(1);
  integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (trim && fraction) fraction = fraction.replace(/0+$/, '');
  return (negative ? '−' : '') + integer + (fraction ? ',' + fraction : '');
}

const money = value => formatDecimal(value) + ' €';
const quantity = value => formatDecimal(value, 18, true);
const pair = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;

function fiscalLabel(row) {
  if (row.type === 'acquisto') return 'Nessun realizzo';
  const value = Decimal.from(row.fiscalResult);
  const sign = value.cmp('0');
  if (sign > 0) return 'Plusvalenza +' + money(value);
  if (sign < 0) return 'Minusvalenza −' + money(value.mul('-1'));
  return 'Pareggio 0,00 €';
}

function operationRow(row) {
  const cells = [
    `${escapeHtml(dateLabel(row.date))}<br><small>Sequenza ${escapeHtml(row.order)}</small>`,
    escapeHtml(row.asset),
    row.type === 'acquisto' ? 'Acquisto' : 'Vendita',
    escapeHtml(quantity(row.quantity)),
    escapeHtml(money(row.fees)),
    row.type === 'acquisto' ? '—' : escapeHtml(money(row.proceeds)),
    escapeHtml(money(row.costBasis)),
    escapeHtml(fiscalLabel(row))
  ];
  return `<tr>${cells.map((cell, index) => `<td${index >= 3 ? ' class="numeric"' : ''}>${cell}</td>`).join('')}</tr>`;
}

function lossNotes(tax) {
  const losses = (items, title) => items.length ? `<section class="pdf-note"><h3>${escapeHtml(title)}</h3><ul>${items.map(loss => `<li>${escapeHtml(money(loss.amount))} · origine ${escapeHtml(loss.originYear)} · scadenza ${escapeHtml(loss.expiresYear)}</li>`).join('')}</ul></section>` : '';
  return losses(tax.remainingLosses, 'Minusvalenze residue al termine del ' + tax.year)
    + losses(tax.expiredLosses, 'Minusvalenze scadute, escluse dalla compensazione');
}

/** Build a printable snapshot of every calculated operation and the selected tax year. */
export function buildPdfReport(result, openingDate) {
  const { rows, tax } = result;
  const dates = rows.map(row => row.date).sort();
  const span = dates.length ? `Periodo delle operazioni: ${dateLabel(dates[0])} – ${dateLabel(dates.at(-1))}.` : 'Nessuna operazione inserita.';
  const summary = [
    ['Plusvalenze', money(tax.gains)],
    ['Minusvalenze', money(tax.losses)],
    ['Risultato netto', money(tax.net)],
    ['Minusvalenze pregresse utilizzate', money(tax.lossesUsed)],
    ['Imponibile', money(tax.taxable)],
    ['Aliquota ordinaria', tax.rate + '%'],
    ['Imposta sostitutiva stimata', money(tax.tax)]
  ];
  const operations = rows.length
    ? `<table class="pdf-operations"><caption>Tutte le operazioni della sessione, in ordine cronologico</caption><thead><tr><th scope="col">Data / sequenza</th><th scope="col">Crypto</th><th scope="col">Tipo</th><th scope="col" class="numeric">Quantità</th><th scope="col" class="numeric">Commissioni (€)</th><th scope="col" class="numeric">Ricavo netto (€)</th><th scope="col" class="numeric">Costo acquisto / LIFO (€)</th><th scope="col" class="numeric">Risultato fiscale (€)</th></tr></thead><tbody>${rows.map(operationRow).join('')}</tbody></table>`
    : '<p class="pdf-empty">Non ci sono operazioni da riepilogare. I lotti della situazione iniziale non sono operazioni della sessione.</p>';
  const warnings = result.warnings.length ? `<section class="pdf-warnings"><h2>Avvertenze del calcolo</h2><ul>${result.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></section>` : '';

  return `<header class="pdf-header"><p>CriptoConti</p><h1>Riepilogo delle operazioni</h1><p>Situazione iniziale al ${escapeHtml(dateLabel(openingDate))}.</p><p>${escapeHtml(span)} Operazioni: ${escapeHtml(rows.length)}.</p><p>Il prospetto comprende tutte le operazioni della sessione, di tutti gli anni e di tutte le crypto, indipendentemente dai filtri a video.</p></header>
<section aria-labelledby="pdf-tax-title"><h2 id="pdf-tax-title">Riepilogo fiscale · anno ${escapeHtml(tax.year)}</h2><p class="pdf-note">Il riepilogo fiscale comprende solo l’anno ${escapeHtml(tax.year)} selezionato. Il calcolo considera le minusvalenze utilizzabili riportate dagli anni precedenti.</p><dl class="pdf-summary">${summary.map(([label, value]) => pair(label, value)).join('')}</dl></section>
${operations}
<p class="pdf-note">Gli acquisti non realizzano plusvalenze o minusvalenze. Per le vendite il risultato fiscale è il ricavo netto, al netto delle commissioni, meno il costo attribuito con il metodo LIFO. Il costo di acquisto include le commissioni.</p>
<p class="pdf-note">Gli importi sono arrotondati ai centesimi per la lettura. I totali fiscali sono calcolati con la precisione del motore: possono differire dalla somma degli importi arrotondati delle singole operazioni.</p>
${lossNotes(tax)}${warnings}
<p class="pdf-note">Questo PDF è un riepilogo e non può essere importato per riprendere la sessione. Usa “Esporta dati” per salvare il CSV ricaricabile. Il sito non registra i dati della sessione.</p>
<section class="pdf-disclaimer"><h2>Avvertenza fiscale ed esclusione di responsabilità</h2><p>CriptoConti è uno strumento informativo e di supporto al calcolo, non un servizio di consulenza fiscale. I risultati possono contenere errori: verifica i dati e i risultati, anche con l’assistenza di un professionista, prima di presentare la dichiarazione dei redditi. L’utente è responsabile dei dati inseriti e della propria dichiarazione. Nei limiti consentiti dalla legge, l’autore e il gestore del sito non rispondono di errori, omissioni, sanzioni o danni derivanti dall’utilizzo dei risultati. Restano ferme le responsabilità che non possono essere escluse per legge.</p></section>`;
}
