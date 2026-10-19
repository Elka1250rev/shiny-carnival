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

const documentedReward = row => row.type === 'acquisto' && !row.source?.derived
  && row.source?.decisions?.rewardTreatment === 'documented_acquisition';

function fiscalLabel(row) {
  if (documentedReward(row)) return 'Ingresso; altri obblighi da verificare';
  if (row.type === 'acquisto') return 'Nessun realizzo';
  if (row.type === 'permuta_neutrale') return 'Nessun realizzo; costo storico trasferito';
  if (row.type === 'deposito_eur') return 'Informativo, nessun reddito';
  const value = Decimal.from(row.display?.fiscalResult ?? row.fiscalResult);
  const sign = row.display?.fiscalSign ?? value.cmp('0');
  if (row.type === 'provento') {
    return sign > 0 && Decimal.from(value.toFixed(2)).cmp('0') === 0
      ? 'Provento imponibile inferiore a 0,005 €'
      : 'Provento imponibile ' + money(value);
  }
  if (sign !== 0 && Decimal.from(value.toFixed(2)).cmp('0') === 0) {
    return (sign > 0 ? 'Plusvalenza' : 'Minusvalenza') + ' inferiore a 0,005 €';
  }
  if (sign > 0) return 'Plusvalenza +' + money(value);
  if (sign < 0) return 'Minusvalenza −' + money(value.mul('-1'));
  return 'Pareggio 0,00 €';
}

const OPERATION_LABELS = Object.freeze({
  acquisto: 'Acquisto', vendita: 'Vendita', permuta_neutrale: 'Permuta neutrale',
  permuta_imponibile: 'Permuta imponibile', provento: 'Provento da detenzione', deposito_eur: 'Deposito EUR',
});

// Source amounts are archived text and may exceed the engine input precision.
// Keep every original digit without parsing arbitrarily long values as BigInt.
const sourceAmount = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
  ? value.replace('.', ',') : null;

function feeLabel(row) {
  if (row.source?.derived && row.source?.decisions?.feePolicy === 'separate_taxable_disposal') return '—';
  const original = row.source?.values;
  const amount = sourceAmount(original?.fee_amount);
  if (amount !== null && /[1-9]/.test(original.fee_amount)) {
    const eur = sourceAmount(original.fee_value_EUR);
    const policy = row.source?.decisions?.feePolicy;
    const treatment = policy === 'already_included' ? 'già compresa'
      : policy === 'separate_taxable_disposal' ? 'cessione separata' : 'dal file';
    return `${amount} ${String(original.fee_currency ?? '')}${eur === null ? '' : ` (${eur} €)`} · ${treatment}`;
  }
  return money(row.fees);
}

function operationLabel(row) {
  if (row.source?.derived && row.source?.decisions?.feePolicy === 'separate_taxable_disposal') return 'Cessione commissione';
  if (documentedReward(row)) return 'Premio: costo documentato';
  return OPERATION_LABELS[row.type] ?? String(row.type);
}

function operationValues(row) {
  const exchange = row.type === 'permuta_neutrale' || row.type === 'permuta_imponibile';
  return [
    `${dateLabel(row.date)}\nSequenza ${row.order}`,
    exchange ? `${row.asset} / ${row.receivedAsset}` : String(row.asset),
    operationLabel(row),
    exchange ? `Ceduta: ${quantity(row.quantity)} ${row.asset}\nRicevuta: ${quantity(row.receivedQuantity)} ${row.receivedAsset}` : quantity(row.quantity),
    feeLabel(row),
    row.proceeds === null || row.proceeds === undefined ? '—' : money(row.display?.proceeds ?? row.proceeds),
    row.type === 'deposito_eur' ? '—' : money(row.display?.costBasis ?? row.costBasis),
    fiscalLabel(row)
  ];
}

function lossSections(tax) {
  return [
    [tax.remainingLosses, 'Minusvalenze residue al termine del ' + tax.year],
    [tax.expiredLosses, 'Minusvalenze scadute, escluse dalla compensazione']
  ].filter(([items]) => items.length).map(([items, title]) => ({
    title,
    items: items.map(loss => `${money(loss.displayAmount ?? loss.amount)} · origine ${loss.originYear} · scadenza ${loss.expiresYear}`)
  }));
}

/** Build a plain-text snapshot shared by HTML printing and downloadable PDFs. */
export function buildPdfReportData(result, openingDate) {
  const { rows, tax } = result;
  const dates = rows.map(row => row.date).sort();
  const span = dates.length ? `Periodo delle operazioni: ${dateLabel(dates[0])} – ${dateLabel(dates.at(-1))}.` : 'Nessuna operazione inserita.';
  const hasHoldingIncome = rows.some(row => row.type === 'provento');
  const summary = [
    ['Plusvalenze', money(tax.display?.capitalGains ?? tax.capitalGains ?? tax.display?.gains ?? tax.gains)],
    ...(hasHoldingIncome ? [['Proventi da detenzione', money(tax.display?.income ?? tax.income ?? '0')]] : []),
    ['Minusvalenze', money(tax.display?.losses ?? tax.losses)],
    ['Risultato netto', money(tax.display?.net ?? tax.net)],
    ['Minusvalenze pregresse utilizzate', money(tax.display?.lossesUsed ?? tax.lossesUsed)],
    ['Imponibile', money(tax.display?.taxable ?? tax.taxable)],
    ['Aliquota ordinaria', tax.rate + '%'],
    ['Imposta sostitutiva stimata', money(tax.tax)]
  ].map(([label, value]) => ({ label, value }));
  return {
    title: 'Riepilogo delle operazioni',
    header: [
      'CriptoConti',
      `Situazione iniziale al ${dateLabel(openingDate)}.`,
      `${span} Operazioni: ${rows.length}.`,
      'Il prospetto comprende tutte le operazioni della sessione, di tutti gli anni e di tutte le crypto, indipendentemente dai filtri a video.'
    ],
    summaryTitle: 'Riepilogo fiscale · anno ' + tax.year,
    scope: [
      'Perimetro: persone fisiche residenti in Italia, fuori dall’attività d’impresa, in regime dichiarativo; compravendite di cripto-attività ordinarie contro euro, permute classificate esplicitamente e proventi da detenzione.',
      `Il riepilogo fiscale comprende solo l’anno ${tax.year} selezionato. Il calcolo considera le minusvalenze utilizzabili riportate dagli anni precedenti.`
    ],
    summary,
    warnings: result.warnings.map(String),
    columns: ['Data / sequenza', 'Crypto', 'Tipo', 'Quantità', 'Commissioni', 'Corrispettivo / provento lordo (€)', 'Costo fiscale / trasferito (€)', 'Risultato fiscale (€)'],
    rows: rows.map(operationValues),
    notes: [
      'Gli acquisti non realizzano plusvalenze o minusvalenze. Per vendite e permute imponibili il risultato fiscale è il corrispettivo lordo o il valore normale ricevuto meno il costo fiscale attribuito con il metodo LIFO. Le commissioni manuali incidono solo sui risultati gestionali, ma non aumentano il costo fiscale e non riducono il corrispettivo fiscale.',
      'Per le commissioni importate sono riportati quantità, valuta e controvalore EUR originali. “Già compresa” indica che la commissione è già inclusa negli importi confermati e non va applicata nuovamente. Una “cessione separata” compare in una propria operazione e non si somma ai costi dell’operazione principale.',
      'Sono neutrali soltanto le permute tra cripto-attività con eguali caratteristiche e funzioni, secondo la classificazione confermata: non realizzano reddito e trasferiscono il costo storico ai lotti ricevuti. I depositi EUR sono informativi e non generano reddito.',
      'I proventi da detenzione sono imponibili al lordo alla ricezione. Per i proventi, la colonna del costo fiscale indica il costo documentato da usare per una cessione successiva: non è una deduzione dal reddito ricevuto e non viene assunto automaticamente pari a zero.',
      'I premi classificati come acquisti documentati usano il costo confermato. L’assenza di realizzo nel motore non certifica l’esenzione del premio: gli altri obblighi devono essere verificati.',
      'Gli importi fiscali sono arrotondati ai centesimi per la lettura; le commissioni originali del file conservano tutte le cifre. I totali fiscali sono calcolati con la precisione del motore: possono differire dalla somma degli importi arrotondati delle singole operazioni.'
    ],
    lossSections: lossSections(tax),
    recoveryNote: 'Questo PDF è un riepilogo e non può essere importato per riprendere la sessione. Usa “Esporta dati” per salvare il CSV ricaricabile. Il sito non registra i dati della sessione.',
    disclaimer: {
      title: 'Avvertenza fiscale ed esclusione di responsabilità',
      text: 'CriptoConti è uno strumento informativo e di supporto al calcolo, non un servizio di consulenza fiscale. I risultati possono contenere errori: verifica i dati e i risultati, anche con l’assistenza di un professionista, prima di presentare la dichiarazione dei redditi. L’utente è responsabile dei dati inseriti e della propria dichiarazione. Nei limiti consentiti dalla legge, l’autore e il gestore del sito non rispondono di errori, omissioni, sanzioni o danni derivanti dall’utilizzo dei risultati. Restano ferme le responsabilità che non possono essere escluse per legge.'
    },
    emptyNote: 'Non ci sono operazioni da riepilogare. I lotti della situazione iniziale non sono operazioni della sessione.'
  };
}

/** Build a printable snapshot of every calculated operation and the selected tax year. */
export function buildPdfReport(result, openingDate) {
  const data = buildPdfReportData(result, openingDate);
  const operations = data.rows.length
    ? `<table class="pdf-operations"><caption>Tutte le operazioni della sessione, in ordine cronologico</caption><thead><tr>${data.columns.map((label, index) => `<th scope="col"${index >= 3 ? ' class="numeric"' : ''}>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${data.rows.map(cells => `<tr>${cells.map((cell, index) => `<td${index >= 3 ? ' class="numeric"' : ''}>${index === 0 ? escapeHtml(cell).replace('\n', '<br><small>') + '</small>' : escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : `<p class="pdf-empty">${escapeHtml(data.emptyNote)}</p>`;
  const warnings = data.warnings.length ? `<section class="pdf-warnings"><h2>Avvertenze del calcolo</h2><ul>${data.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></section>` : '';

  return `<header class="pdf-header"><p>${escapeHtml(data.header[0])}</p><h1>${escapeHtml(data.title)}</h1>${data.header.slice(1).map(text => `<p>${escapeHtml(text)}</p>`).join('')}</header>
<section aria-labelledby="pdf-tax-title"><h2 id="pdf-tax-title">${escapeHtml(data.summaryTitle)}</h2>${data.scope.map(text => `<p class="pdf-note">${escapeHtml(text)}</p>`).join('')}<dl class="pdf-summary">${data.summary.map(({ label, value }) => pair(label, value)).join('')}</dl></section>
${warnings}
${operations}
${data.notes.map(text => `<p class="pdf-note">${escapeHtml(text)}</p>`).join('\n')}
${data.lossSections.map(section => `<section class="pdf-note"><h3>${escapeHtml(section.title)}</h3><ul>${section.items.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ul></section>`).join('')}
<p class="pdf-note">${escapeHtml(data.recoveryNote)}</p>
<section class="pdf-disclaimer"><h2>${escapeHtml(data.disclaimer.title)}</h2><p>${escapeHtml(data.disclaimer.text)}</p></section>`;
}
