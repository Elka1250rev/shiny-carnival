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
const unitCost = (value, exactSign = Decimal.from(value).cmp('0')) => exactSign > 0 && Decimal.from(Decimal.from(value).toFixed(18)).cmp('0') === 0
  ? 'Inferiore a 0,000000000000000001 €' : quantity(value) + ' €';

function openingSection(initialLots, openingDate) {
  const available = Array.isArray(initialLots);
  const lots = available ? [...initialLots].sort((left, right) => left.asset.localeCompare(right.asset)
    || left.acquiredOn.localeCompare(right.acquiredOn) || left.order - right.order || left.id.localeCompare(right.id)) : [];
  const assets = new Map();
  for (const lot of lots) {
    const current = assets.get(lot.asset) || { quantity: Decimal.from('0'), cost: Decimal.from('0'), estimated: false };
    current.quantity = current.quantity.add(lot.quantity);
    current.cost = current.cost.add(Decimal.from(lot.quantity).mul(lot.unitCost));
    current.estimated ||= lot.basisMethod === 'estimated_average';
    assets.set(lot.asset, current);
  }
  return {
    title: 'Situazione iniziale al ' + dateLabel(openingDate),
    note: 'Saldi originali all’apertura, prima delle operazioni. Il prezzo medio di carico è la media ponderata dei lotti dello stesso asset; il costo di una vendita deriva invece dai lotti ceduti in LIFO. I saldi aggregati stimati sono segnalati e non ricostruiscono i lotti storici.',
    columns: ['Crypto', 'Quantità iniziale', 'Prezzo medio di carico (€ per unità)', 'Costo fiscale iniziale (€)'],
    rows: [...assets].map(([asset, values]) => [asset + (values.estimated ? '\nCosto medio stimato' : ''),
      quantity(values.quantity), unitCost(values.quantity.cmp('0') ? values.cost.div(values.quantity) : '0'), money(values.cost)]),
    lotTitle: 'Lotti della situazione iniziale',
    lotColumns: ['Crypto', 'Lotto / data originaria', 'Quantità iniziale', 'Costo unitario di carico (€)', 'Costo fiscale iniziale (€)'],
    lotRows: lots.map(lot => [String(lot.asset), `${lot.id}\n${lot.basisMethod === 'estimated_average'
      ? 'Saldo aggregato stimato · data originaria non disponibile'
      : `Acquisto ${dateLabel(lot.acquiredOn)} · ordine ${lot.order}`}`,
    quantity(lot.quantity), unitCost(lot.unitCost), money(Decimal.from(lot.quantity).mul(lot.unitCost))]),
    emptyNote: available ? 'Non sono stati inseriti lotti nella situazione iniziale.'
      : 'Il dettaglio della situazione iniziale non è disponibile in questo snapshot di calcolo.'
  };
}

function operationLots(row, initialLotIds) {
  if (!['vendita', 'permuta_imponibile', 'permuta_neutrale'].includes(row.type)) return null;
  const lots = row.lotDetails || [];
  const neutral = row.type === 'permuta_neutrale';
  const cost = money(row.display?.costBasis ?? row.costBasis);
  const result = row.display?.fiscalResult ?? row.fiscalResult;
  const sign = row.display?.fiscalSign ?? (result === null ? 0 : Decimal.from(result).cmp('0'));
  const signedResult = result === null ? '' : sign !== 0 && Decimal.from(Decimal.from(result).toFixed(2)).cmp('0') === 0
    ? `${sign > 0 ? 'positivo' : 'negativo'} inferiore a 0,005 €`
    : (sign > 0 ? '+' : '') + money(result);
  return {
    title: `Lotti ceduti in LIFO · ${dateLabel(row.date)} · sequenza ${row.order} · ${row.asset} · ${row.id}`,
    columns: ['Lotto / data LIFO', 'Quantità ceduta', 'Costo unitario di carico (€)', 'Costo fiscale attribuito (€)'],
    rows: lots.length ? lots.map(lot => {
      const date = lot.acquiredOn ? `Data LIFO ${dateLabel(lot.acquiredOn)} · ordine ${lot.order}` : 'Data originaria non disponibile';
      const origin = lot.provenance ? `\nDa permuta: ${lot.provenance.originAsset} · lotto ${lot.provenance.originLotId}` : '';
      return [`${initialLotIds.has(lot.lotId) ? 'Lotto iniziale ' : 'Lotto '}${lot.lotId}\n${date}${lot.basisMethod === 'estimated_average' ? '\nCosto medio stimato' : ''}${origin}`,
        quantity(lot.quantity), unitCost(lot.display?.unitCost ?? lot.unitCost, lot.display?.unitCostSign),
        money(lot.display?.cost ?? lot.cost)];
    }) : [['Dettaglio dei lotti non disponibile nello snapshot.', '—', '—', '—']],
    total: `${neutral ? 'Costo storico trasferito' : 'Costo fiscale attribuito'}: ${cost}.`,
    verification: neutral ? 'Permuta neutrale: il costo è trasferito alla crypto ricevuta senza realizzo fiscale.'
      : `Verifica del risultato fiscale: ${money(row.display?.proceeds ?? row.proceeds)} − ${cost} = ${signedResult}.`
  };
}

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
  const initialLotIds = new Set((result.initialLots || []).map(lot => lot.id));
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
    opening: openingSection(result.initialLots, openingDate),
    summaryTitle: 'Riepilogo fiscale · anno ' + tax.year,
    scope: [
      'Perimetro: persone fisiche residenti in Italia, fuori dall’attività d’impresa, in regime dichiarativo; compravendite di cripto-attività ordinarie contro euro, permute classificate esplicitamente e proventi da detenzione.',
      `Il riepilogo fiscale comprende solo l’anno ${tax.year} selezionato. Il calcolo considera le minusvalenze utilizzabili riportate dagli anni precedenti.`
    ],
    summary,
    warnings: result.warnings.map(String),
    columns: ['Data / sequenza', 'Crypto', 'Tipo', 'Quantità', 'Commissioni', 'Corrispettivo / provento lordo (€)', 'Costo fiscale / trasferito (€)', 'Risultato fiscale (€)'],
    rows: rows.map(operationValues),
    operationLots: rows.map(row => operationLots(row, initialLotIds)),
    notes: [
      'La situazione iniziale apre il PDF; se non entra in una pagina prosegue nei fogli successivi. Il riepilogo per asset e i lotti iniziali riportano i saldi originari, anche se venduti in seguito. Ogni cessione riporta i lotti consumati in ordine LIFO, con la sola quantità ceduta e il costo attribuito a quella porzione.',
      'Gli acquisti non realizzano plusvalenze o minusvalenze. Per vendite e permute imponibili il risultato fiscale è il corrispettivo lordo o il valore normale ricevuto meno il costo fiscale attribuito con il metodo LIFO. Le commissioni manuali incidono solo sui risultati gestionali, ma non aumentano il costo fiscale e non riducono il corrispettivo fiscale.',
      'Per le commissioni importate sono riportati quantità, valuta e controvalore EUR originali. “Già compresa” indica che la commissione è già inclusa negli importi confermati e non va applicata nuovamente. Una “cessione separata” compare in una propria operazione e non si somma ai costi dell’operazione principale.',
      'Sono neutrali soltanto le permute tra cripto-attività con eguali caratteristiche e funzioni, secondo la classificazione confermata: non realizzano reddito e trasferiscono il costo storico ai lotti ricevuti. I depositi EUR sono informativi e non generano reddito.',
      'I proventi da detenzione sono imponibili al lordo alla ricezione. Per i proventi, la colonna del costo fiscale indica il costo documentato da usare per una cessione successiva: non è una deduzione dal reddito ricevuto e non viene assunto automaticamente pari a zero.',
      'I premi classificati come acquisti documentati usano il costo confermato. L’assenza di realizzo nel motore non certifica l’esenzione del premio: gli altri obblighi devono essere verificati.',
      'Gli importi fiscali e i costi attribuiti sono arrotondati ai centesimi per la lettura; i costi unitari sono mostrati fino a 18 decimali e possono essere approssimati per le divisioni non finite. Le commissioni originali del file conservano tutte le cifre. I totali fiscali e i costi complessivi sono calcolati con la precisione del motore: possono differire dalla somma degli importi arrotondati delle singole operazioni o dei singoli lotti.'
    ],
    lossSections: lossSections(tax),
    recoveryNote: 'Questo PDF è un riepilogo e non può essere importato per riprendere la sessione. Usa “Salva sessione CSV” per salvare il CSV ricaricabile. Il sito non registra i dati della sessione.',
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
  const openingTable = (columns, rows) => `<table class="pdf-opening"><thead><tr class="pdf-opening-head">${columns.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${rows.map(cells => `<tr class="pdf-opening-row">${cells.map(cell => `<td>${escapeHtml(cell).replaceAll('\n', '<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const opening = `<section class="pdf-opening-section"><h2>${escapeHtml(data.opening.title)}</h2><p class="pdf-note">${escapeHtml(data.opening.note)}</p>${data.opening.rows.length
    ? openingTable(data.opening.columns, data.opening.rows) + `<h3>${escapeHtml(data.opening.lotTitle)}</h3>` + openingTable(data.opening.lotColumns, data.opening.lotRows)
    : `<p class="pdf-note">${escapeHtml(data.opening.emptyNote)}</p>`}</section>`;
  const lotDetail = detail => detail ? `<tr class="pdf-lot-details"><td colspan="8"><h3>${escapeHtml(detail.title)}</h3>${detail.rows.map(cells => `<p class="pdf-lot-line">${cells.map((cell, index) => `${escapeHtml(detail.columns[index])}: ${escapeHtml(cell).replaceAll('\n', '<br>')}`).join(' · ')}</p>`).join('')}<p><strong>${escapeHtml(detail.total)}</strong></p><p>${escapeHtml(detail.verification)}</p></td></tr>` : '';
  const operations = data.rows.length
    ? `<table class="pdf-operations"><caption>Tutte le operazioni della sessione, in ordine cronologico</caption><thead><tr>${data.columns.map((label, index) => `<th scope="col"${index >= 3 ? ' class="numeric"' : ''}>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${data.rows.map((cells, index) => `<tr>${cells.map((cell, index) => `<td${index >= 3 ? ' class="numeric"' : ''}>${index === 0 ? escapeHtml(cell).replace('\n', '<br><small>') + '</small>' : escapeHtml(cell)}</td>`).join('')}</tr>` + lotDetail(data.operationLots[index])).join('')}</tbody></table>`
    : `<p class="pdf-empty">${escapeHtml(data.emptyNote)}</p>`;
  const warnings = data.warnings.length ? `<section class="pdf-warnings"><h2>Avvertenze del calcolo</h2><ul>${data.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></section>` : '';

  return `<header class="pdf-header"><p>${escapeHtml(data.header[0])}</p><h1>${escapeHtml(data.title)}</h1>${data.header.slice(1).map(text => `<p>${escapeHtml(text)}</p>`).join('')}</header>
${opening}
<section aria-labelledby="pdf-tax-title"><h2 id="pdf-tax-title">${escapeHtml(data.summaryTitle)}</h2>${data.scope.map(text => `<p class="pdf-note">${escapeHtml(text)}</p>`).join('')}<dl class="pdf-summary">${data.summary.map(({ label, value }) => pair(label, value)).join('')}</dl></section>
${warnings}
${operations}
${data.notes.map(text => `<p class="pdf-note">${escapeHtml(text)}</p>`).join('\n')}
${data.lossSections.map(section => `<section class="pdf-note"><h3>${escapeHtml(section.title)}</h3><ul>${section.items.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ul></section>`).join('')}
<p class="pdf-note">${escapeHtml(data.recoveryNote)}</p>
<section class="pdf-disclaimer"><h2>${escapeHtml(data.disclaimer.title)}</h2><p>${escapeHtml(data.disclaimer.text)}</p></section>`;
}
