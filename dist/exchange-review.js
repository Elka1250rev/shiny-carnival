import { analyzeExchangeCsv } from './exchange-import.js';
import { Decimal } from './decimal.js';

const PAGE_SIZE = 50;
const UNSAVED_MESSAGE = 'Salva o annulla la rettifica aperta prima di continuare.';
let reviewSequence = 0;
const blankOptions = () => ({
  mode: '', dateConfirmed: false, grossValuesConfirmed: false,
  swapTreatments: Object.create(null), lotDatePolicy: '', rewardsTreatment: '',
  rewardTreatments: Object.create(null), rewardCostPolicy: '', thirdAssetFees: '', overrides: Object.create(null)
});
const decimalInput = value => value.trim().replace(',', '.');

/** Explicit fiscal review of source data, kept only for the open import dialog. */
export function createExchangeReview({ container, onChange = () => {}, onAddInitialLot = null }) {
  const doc = container.ownerDocument;
  const prefix = `exchange-review-${++reviewSequence}`;
  let parsed = null;
  let analysis = null;
  let options = blankOptions();
  let page = 0;
  let openEditorId = null;
  let errorsBox = null;
  let preview = null;
  let lotPolicyField = null;
  let rewardCostField = null;
  let balanceBox = null;
  let balanceDataset = null;
  let initialSummary = null;
  let selectSequence = 0;
  container.hidden = true;
  container.classList.add('exchange-review');

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function paragraph(parent, text, className = 'exchange-review-note') {
    const node = element('p', className, text);
    parent.append(node);
    return node;
  }
  function button(text, action, className = 'button button-outline') {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }
  function section(title) {
    const node = element('section', 'exchange-review-section');
    node.append(element('h3', '', title));
    container.append(node);
    return node;
  }
  function updateDependencies() {
    if (lotPolicyField) lotPolicyField.hidden = !Object.values(options.swapTreatments).includes('neutral');
    if (rewardCostField) rewardCostField.hidden = !['holding_income', 'per_row'].includes(options.rewardsTreatment);
    renderBalanceCheck();
  }
  function updateInitialSummary() {
    if (!initialSummary) return;
    initialSummary.textContent = `Situazione attuale al ${balanceDataset?.openingDate || '—'}: ${balanceDataset?.initialLots?.length || 0} lotti iniziali, ${balanceDataset?.carryLosses?.length || 0} minusvalenze pregresse e ${balanceDataset?.transactions?.length || 0} operazioni. Il CSV non ricostruisce i costi o i movimenti precedenti mancanti.`;
  }
  function addInitialLot(asset) {
    if (openEditorId !== null) { setErrors([UNSAVED_MESSAGE]); return; }
    onAddInitialLot?.(asset);
  }
  function renderBalanceCheck() {
    if (!balanceBox || !parsed || !balanceDataset) return;
    balanceBox.replaceChildren();
    const zero = Decimal.from('0');
    const number = value => {
      if (typeof value !== 'string' || !/^\d{1,30}(?:\.\d{1,18})?$/.test(value)) throw new Error('Importo da verificare');
      return Decimal.from(value);
    };
    try {
      const sourceDates = new Set(parsed.rows.map(row => row.values.datetime_tz_CET.slice(0, 10)));
      const existing = options.mode === 'append' ? balanceDataset.transactions || [] : [];
      if (existing.some(transaction => sourceDates.has(transaction.date))) {
        paragraph(balanceBox, 'Le operazioni attuali e il CSV contengono date in comune: l’ordine relativo non è verificabile. Per aggiungere operazioni sono ammesse solo altre date.', 'exchange-review-warning');
        return;
      }
      const balances = new Map();
      const missing = new Map();
      const move = (asset, amount) => {
        if (!asset || asset === 'EUR') return;
        const next = (balances.get(asset) || zero).add(amount);
        balances.set(asset, next);
        if (next.cmp(zero) < 0 && (!missing.has(asset) || next.cmp(missing.get(asset)) < 0)) missing.set(asset, next);
      };
      for (const lot of balanceDataset.initialLots || []) move(lot.asset, number(lot.quantity));
      const events = parsed.rows.map(row => ({ date: row.values.datetime_tz_CET.slice(0, 10), time: row.values.datetime_tz_CET.slice(11), order: row.line, source: row }));
      events.push(...existing.map(transaction => ({ date: transaction.date, time: '', order: transaction.order, transaction })));
      events.sort((left, right) => left.date.localeCompare(right.date) || left.time.localeCompare(right.time) || left.order - right.order);
      for (const event of events) {
        if (event.transaction) {
          const transaction = event.transaction;
          if (transaction.type === 'deposito_eur') continue;
          const quantity = number(transaction.quantity);
          if (transaction.type === 'acquisto' || transaction.type === 'provento') move(transaction.asset, quantity);
          else {
            move(transaction.asset, zero.sub(quantity));
            if (['permuta_neutrale', 'permuta_imponibile'].includes(transaction.type)) move(transaction.receivedAsset, number(transaction.receivedQuantity));
          }
          continue;
        }
        const { values } = event.source;
        const override = options.overrides[values.id] || {};
        const sent = ['Sell', 'Trade'].includes(values.type);
        if (sent) move(values.sent_currency, zero.sub(number(override.quantity || values.sent_amount)));
        if (['Buy', 'Receive', 'Trade'].includes(values.type)) {
          const quantity = values.type === 'Trade' ? override.receivedQuantity || values.received_amount : override.quantity || values.received_amount;
          move(values.received_currency, number(quantity));
        }
        if (options.thirdAssetFees === 'separate_taxable_disposal' && values.fee_currency !== values.sent_currency && values.fee_currency !== values.received_currency) move(values.fee_currency, zero.sub(number(values.fee_amount)));
      }
      if (!missing.size) {
        paragraph(balanceBox, 'Controllo preliminare delle quantità: il CSV non richiede ulteriori saldi iniziali per le operazioni esaminate. La verifica completa di dati e costi avviene prima dell’importazione.');
        return;
      }
      paragraph(balanceBox, 'Il file è leggibile, ma alcune uscite superano le quantità disponibili. Verifica i lotti iniziali e la completezza dei movimenti: possono mancare acquisti o trasferimenti, oppure esserci quantità o un ordine da correggere.', 'exchange-review-warning');
      const list = element('ul', 'exchange-review-balances');
      for (const [asset, minimum] of missing) {
        const item = element('li');
        item.append(element('p', '', `${asset}: lo scarto massimo delle quantità è ${zero.sub(minimum).toString()} ${asset}. È un dato diagnostico, non la ricostruzione della quantità realmente posseduta all’apertura.`));
        if (typeof onAddInitialLot === 'function') item.append(button(`Aggiungi un lotto di ${asset}`, () => addInitialLot(asset)));
        list.append(item);
      }
      balanceBox.append(list);
      paragraph(balanceBox, 'Inserisci soltanto lotti effettivamente disponibili all’apertura, con quantità, data e costo documentati: il sito non compila questi dati usando lo scarto. Se mancano movimenti successivi, completa o correggi il file della piattaforma. Le commissioni aggiuntive in una terza crypto sono incluse solo se confermate nella scelta dedicata.');
      if (typeof onAddInitialLot === 'function') paragraph(balanceBox, 'Puoi aggiungere i lotti senza chiudere questa verifica: le scelte già effettuate restano disponibili. «Salva e ricalcola» salva subito il lotto nella sessione, anche se poi annulli l’importazione. Le operazioni del CSV vengono applicate solo con «Importa e ricalcola».');
    } catch {
      paragraph(balanceBox, 'Il controllo preliminare dei saldi non è completo: alcuni importi richiedono verifica. L’importazione resta soggetta alla validazione completa.');
    }
  }
  function changed() {
    updateDependencies();
    setErrors([]);
    onChange();
  }
  function select(parent, labelText, choices, value, change, notify = true) {
    const wrapper = element('div', 'form-field exchange-review-field');
    const id = `${prefix}-field-${++selectSequence}`;
    const label = element('label', '', labelText);
    label.htmlFor = id;
    const field = element('select');
    field.id = id;
    field.append(element('option', '', 'Scegli esplicitamente…'));
    field.firstChild.value = '';
    for (const [key, text] of choices) {
      const option = element('option', '', text);
      option.value = key;
      field.append(option);
    }
    field.value = value;
    field.addEventListener('change', () => { change(field.value); if (notify) changed(); });
    wrapper.append(label, field);
    parent.append(wrapper);
    return { wrapper, field };
  }
  function checkbox(parent, text, key) {
    const wrapper = element('label', 'exchange-review-check');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = options[key];
    input.addEventListener('change', () => { options[key] = input.checked; changed(); });
    wrapper.append(input, element('span', '', text));
    parent.append(wrapper);
  }
  function sourceLabel(amount, currency) {
    return `${amount || '0'} ${currency || '—'}`;
  }
  function fiscalFields(values) {
    const buy = values.type === 'Buy';
    const reward = values.type === 'Receive';
    const fields = [];
    if (values.type !== 'Deposit') {
      fields.push({
        key: 'quantity', label: buy || reward ? 'Quantità netta ricevuta' : 'Quantità netta ceduta',
        source: buy || reward ? values.received_amount : values.sent_amount
      });
    }
    if (values.type === 'Trade') fields.push({ key: 'receivedQuantity', label: 'Quantità netta ricevuta', source: values.received_amount });
    const neutral = values.type === 'Trade' && options.swapTreatments[`${values.sent_currency}→${values.received_currency}`] === 'neutral';
    if (!neutral) fields.push({
      key: 'totalEur', label: reward ? 'Valore lordo del premio in EUR' : 'Controvalore fiscale lordo totale in EUR',
      source: buy ? values.sent_value_EUR : values.received_value_EUR
    });
    if (reward) fields.push({ key: 'rewardCostEur', label: 'Costo fiscale totale documentato del premio in EUR', source: '' });
    return fields;
  }
  function renderEditor(row, target, editButton) {
    const values = row.values;
    const current = options.overrides[values.id] || {};
    const editor = element('div', 'exchange-review-editor');
    editor.append(element('h4', '', `Rettifica fiscale della riga ${row.line}`));
    paragraph(editor, 'Compila solo i valori da rettificare, senza separatori delle migliaia. Sono ammessi punto o virgola decimale. I dati originali del CSV restano conservati. Gli importi sono totali, non prezzi unitari.');
    let rewardTreatmentField = null;
    if (values.type === 'Receive') {
      rewardTreatmentField = select(editor, 'Trattamento documentato di questo premio', [
        ['holding_income', 'Provento da detenzione: imponibile alla percezione'],
        ['documented_acquisition', 'Premio di altra natura: acquisizione a costo documentato']
      ], options.rewardTreatments[values.id] || '', () => {}, false).field;
      paragraph(editor, 'La classificazione deve essere verificata sulla documentazione. La seconda scelta esclude il premio dai proventi da detenzione di questo calcolo e carica il costo confermato per le vendite future: non attesta che il premio sia esente da altre imposte. Con categorie miste, classifica ogni premio; con il trattamento generale da detenzione, una scelta per riga lo sostituisce.');
    }
    const grid = element('div', 'exchange-review-edit-grid');
    const inputs = [];
    for (const field of fiscalFields(values)) {
      const wrapper = element('div', 'form-field');
      const id = `${prefix}-edit-${++selectSequence}`;
      const label = element('label', '', field.label);
      label.htmlFor = id;
      const input = element('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.id = id;
      input.value = current[field.key] || '';
      input.placeholder = field.source || 'Inserisci un costo documentato';
      input.autocomplete = 'off';
      input.spellcheck = false;
      wrapper.append(label, input);
      if (field.source) wrapper.append(element('small', '', `Valore originale: ${field.source}`));
      grid.append(wrapper);
      inputs.push({ key: field.key, input, wrapper });
    }
    editor.append(grid);
    if (values.type === 'Trade' && options.swapTreatments[`${values.sent_currency}→${values.received_currency}`] === 'neutral') paragraph(editor, 'La permuta neutrale trasferisce il costo storico dei lotti ceduti. Puoi rettificare le quantità nette; il controvalore EUR originale è conservato nella fonte e non diventa un nuovo costo fiscale.');
    const treatmentNote = values.type === 'Receive'
      ? paragraph(editor, 'Per un’acquisizione documentata, il valore originale del premio resta nella fonte: inserisci il costo riconosciuto nel campo «Costo fiscale totale documentato». Non viene aggiunto ai proventi da detenzione.')
      : null;
    const effectiveRewardTreatment = () => rewardTreatmentField?.value || (options.rewardsTreatment === 'holding_income' ? 'holding_income' : '');
    function updateRewardFields() {
      const acquisition = effectiveRewardTreatment() === 'documented_acquisition';
      const totalField = inputs.find(field => field.key === 'totalEur');
      if (totalField && rewardTreatmentField) totalField.wrapper.hidden = acquisition;
      if (treatmentNote) treatmentNote.hidden = !acquisition;
    }
    rewardTreatmentField?.addEventListener('change', updateRewardFields);
    updateRewardFields();
    const actions = element('div', 'exchange-review-actions');
    function save() {
      const neutral = values.type === 'Trade' && options.swapTreatments[`${values.sent_currency}→${values.received_currency}`] === 'neutral';
      const revised = Object.fromEntries(inputs.filter(({ key }) => !(key === 'totalEur' && (effectiveRewardTreatment() === 'documented_acquisition' || neutral))).map(({ key, input }) => [key, decimalInput(input.value)]).filter(([, value]) => value !== ''));
      if (rewardTreatmentField) {
        if (rewardTreatmentField.value) options.rewardTreatments[values.id] = rewardTreatmentField.value;
        else delete options.rewardTreatments[values.id];
      }
      if (Object.keys(revised).length) options.overrides[values.id] = revised;
      else delete options.overrides[values.id];
      openEditorId = null;
      changed();
      renderPreview();
      focusRowButton(row.line);
    }
    for (const { input } of inputs) input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); save(); }
    });
    actions.append(button('Salva rettifica', save, 'button button-dark'));
    actions.append(button('Annulla rettifica', () => {
      openEditorId = null;
      renderPreview();
      changed();
      focusRowButton(row.line);
    }));
    editor.append(actions);
    target.append(editor);
    editButton.setAttribute('aria-expanded', 'true');
  }
  function focusRowButton(line) {
    const field = preview?.querySelector(`[data-source-line="${line}"]`);
    field?.focus();
  }
  function renderPreview() {
    if (!preview || !parsed) return;
    preview.replaceChildren();
    const totalPages = Math.max(1, Math.ceil(parsed.rows.length / PAGE_SIZE));
    page = Math.max(0, Math.min(page, totalPages - 1));
    const start = page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, parsed.rows.length);
    const info = element('p', 'exchange-review-page-info', `Righe ${start + 1}–${end} di ${parsed.rows.length} · pagina ${page + 1} di ${totalPages}`);
    info.setAttribute('aria-live', 'polite');
    preview.append(info);
    const scroller = element('div', 'exchange-review-table-scroll');
    scroller.tabIndex = 0;
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', 'Dati originali del CSV: scorri orizzontalmente per leggere tutte le colonne');
    const table = element('table', 'exchange-review-table');
    const caption = element('caption', 'sr-only', 'Anteprima di tutte le categorie del CSV, con entrambi i controvalori originali');
    const head = element('thead');
    const header = element('tr');
    const columns = ['Riga', 'Data e ora del CSV', 'Tipo', 'Inviato', 'Ricevuto', 'EUR inviati / ricevuti', 'Commissione', 'Rettifiche'];
    for (const name of columns) {
      const cell = element('th', '', name);
      cell.scope = 'col';
      header.append(cell);
    }
    head.append(header);
    const body = element('tbody');
    for (const row of parsed.rows.slice(start, end)) {
      const values = row.values;
      const tr = element('tr');
      for (const content of [row.line, values.datetime_tz_CET, `${values.type}${values.label ? ` · ${values.label}` : ''}`, sourceLabel(values.sent_amount, values.sent_currency), sourceLabel(values.received_amount, values.received_currency), `${values.sent_value_EUR} / ${values.received_value_EUR}`, `${sourceLabel(values.fee_amount, values.fee_currency)} (${values.fee_value_EUR} EUR)`]) tr.append(element('td', '', String(content)));
      const actions = element('td');
      const expanded = openEditorId === values.id;
      const editButton = button('Rettifica dati fiscali', () => {
        if (openEditorId !== null) { setErrors([UNSAVED_MESSAGE]); return; }
        openEditorId = values.id;
        renderPreview();
        changed();
        preview.querySelector('.exchange-review-editor select, .exchange-review-editor input')?.focus();
      }, 'button button-outline exchange-review-edit-button');
      editButton.dataset.sourceLine = String(row.line);
      editButton.setAttribute('aria-expanded', String(expanded));
      actions.append(editButton);
      if (options.overrides[values.id]) actions.append(element('small', 'exchange-review-modified', 'Rettifica salvata'));
      if (options.rewardTreatments[values.id]) actions.append(element('small', 'exchange-review-modified', options.rewardTreatments[values.id] === 'holding_income' ? 'Detenzione confermata' : 'Altra acquisizione confermata'));
      tr.append(actions);
      body.append(tr);
      if (expanded) {
        const editorRow = element('tr');
        const editorCell = element('td', 'exchange-review-editor-cell');
        editorCell.colSpan = columns.length;
        renderEditor(row, editorCell, editButton);
        editorRow.append(editorCell);
        body.append(editorRow);
      }
    }
    table.append(caption, head, body);
    scroller.append(table);
    preview.append(scroller);
    const pagination = element('div', 'exchange-review-pagination');
    function move(delta) {
      if (openEditorId !== null) { setErrors([UNSAVED_MESSAGE]); return; }
      page += delta;
      openEditorId = null;
      renderPreview();
      preview.querySelector('.exchange-review-page-info')?.scrollIntoView({ block: 'nearest' });
    }
    const previous = button('Pagina precedente', () => move(-1));
    previous.disabled = page === 0;
    const next = button('Pagina successiva', () => move(1));
    next.disabled = page >= totalPages - 1;
    pagination.append(previous, next);
    preview.append(pagination);
  }
  function setErrors(errors = []) {
    if (!errorsBox) return;
    errorsBox.replaceChildren();
    if (!errors.length) { errorsBox.hidden = true; return; }
    errorsBox.hidden = false;
    errorsBox.append(element('strong', '', 'Verifiche da completare prima di importare.'));
    const list = element('ul');
    for (const error of errors.slice(0, 10)) {
      const text = typeof error === 'string' ? error : `${error.line !== undefined && error.line !== null ? `Riga ${error.line}: ` : ''}${error.message || 'Dato da verificare.'}`;
      list.append(element('li', '', text));
    }
    errorsBox.append(list);
    paragraph(errorsBox, 'Le scelte fiscali ancora da confermare non indicano un errore nel formato del file. Completa le verifiche richieste; eventuali errori dei dati o delle quantità restano bloccanti.');
    if (errors.length > 10) paragraph(errorsBox, `Altre ${errors.length - 10} verifiche da completare: risolvi le prime e controlla di nuovo.`);
  }
  function hide() {
    container.hidden = true;
    container.replaceChildren();
    parsed = null;
    analysis = null;
    options = blankOptions();
    page = 0;
    openEditorId = null;
    errorsBox = preview = lotPolicyField = rewardCostField = balanceBox = balanceDataset = initialSummary = null;
  }
  function show(source, currentDataset) {
    hide();
    analysis = analyzeExchangeCsv(source);
    parsed = source;
    balanceDataset = currentDataset;
    container.hidden = false;
    const intro = section('Verifica il CSV della piattaforma');
    paragraph(intro, `${parsed.rows.length} righe originali. Nessuna riga viene esclusa automaticamente. Le scelte fiscali e le rettifiche rimangono nella memoria di questa sessione.`);
    paragraph(intro, parsed.summary?.types?.map(({ type, count }) => `${type}: ${count}`).join(' · ') || 'Tutte le categorie sono riportate nell’anteprima.');
    errorsBox = element('div', 'form-error exchange-review-errors');
    errorsBox.setAttribute('role', 'alert');
    errorsBox.hidden = true;
    intro.append(errorsBox);
    if (analysis.unsupportedRows?.length) paragraph(intro, `${analysis.unsupportedRows.length} righe richiedono un trattamento non supportato: l’importazione sarà bloccata senza scartarle.`, 'exchange-review-warning');
    const initial = section('1. Destinazione e ordine dei dati');
    select(initial, 'Come inserire le operazioni', [
      ['replace', 'Sostituisci operazioni, conserva lotti e minusvalenze'],
      ['append', 'Aggiungi operazioni di altre date']
    ], options.mode, value => { options.mode = value; });
    initialSummary = paragraph(initial, '');
    updateInitialSummary();
    checkbox(initial, 'Confermo data e ora come riportate nel CSV, senza conversione del fuso. A parità di secondo si mantiene l’ordine delle righe nel file.', 'dateConfirmed');
    balanceBox = element('div', 'exchange-review-balance-check');
    initial.append(balanceBox);
    const fiscal = section('2. Importi fiscali e commissioni');
    paragraph(fiscal, 'Le quantità sent_amount e received_amount sono già nette: una quantità di 1 BTC con commissione di 0,001 BTC resta 1 BTC. Non sommare o sottrarre di nuovo la commissione. I controvalori fiscali EUR devono invece essere verificati al lordo: la circolare 30/E, § 3.1, non riconosce la deduzione dei costi di acquisto e cessione e prevede proventi da detenzione senza deduzioni.');
    paragraph(fiscal, 'Se i valori includono trattenute o la commissione non è chiara, verifica la documentazione della piattaforma e usa «Rettifica dati fiscali» per le singole righe. Il sito non stima importi mancanti.');
    checkbox(fiscal, 'Confermo le quantità nette effettive del CSV e ho verificato i controvalori fiscali lordi in EUR, rettificandoli dove necessario. Le commissioni non devono essere applicate una seconda volta.', 'grossValuesConfirmed');
    if (analysis.swapPairs.length) {
      const swaps = section('3. Trattamento degli scambi crypto/crypto');
      paragraph(swaps, 'La neutralità riguarda le cripto-attività con eguali caratteristiche e funzioni (art. 67 TUIR). La crypto ricevuta conserva il costo storico ceduto. NFT, stablecoin e token richiedono una verifica della loro natura: il solo nome non determina il trattamento.');
      const selects = [];
      for (const pair of analysis.swapPairs) {
        const control = select(swaps, `${pair.sentAsset} → ${pair.receivedAsset} · ${pair.count} operazioni`, [
          ['neutral', 'Neutrale: eguali caratteristiche e funzioni, costo storico'],
          ['taxable', 'Fiscalmente rilevante: valore della crypto ricevuta']
        ], '', value => { options.swapTreatments[pair.key] = value; });
        selects.push({ field: control.field, key: pair.key });
      }
      swaps.append(button('Imposta tutte come neutrali', () => {
        for (const { field, key } of selects) { field.value = 'neutral'; options.swapTreatments[key] = 'neutral'; }
        changed();
      }));
      paragraph(swaps, 'Usa questa scelta collettiva solo dopo aver verificato il requisito di eguali caratteristiche e funzioni per ogni coppia.');
      lotPolicyField = select(swaps, 'Data dei lotti ricevuti nelle permute neutrali', [
        ['historical', 'Mantieni la data storica dei lotti ceduti'],
        ['exchange', 'Usa la data dello scambio']
      ], '', value => { options.lotDatePolicy = value; }).wrapper;
      paragraph(lotPolicyField, 'La data influisce sull’ordine LIFO delle vendite successive. È un criterio da verificare con la documentazione e il professionista; non viene presentato come una convenzione stabilita dalla legge.');
    }
    if (analysis.rewardCount) {
      const rewards = section('Premi EARN e costo delle vendite successive');
      paragraph(rewards, `${analysis.rewardCount} premi da qualificare. L’etichetta EARN non prova da sola la natura del reddito. I proventi da detenzione sono imponibili alla percezione. I premi promozionali possono avere natura diversa: classificali per riga secondo la documentazione, senza presumere costo zero o esenzione.`);
      select(rewards, 'Natura documentata dei premi', [
        ['holding_income', 'Proventi da detenzione, imponibili alla percezione'],
        ['per_row', 'Categorie miste: classifica ogni premio per riga']
      ], '', value => { options.rewardsTreatment = value; });
      rewardCostField = select(rewards, 'Costo fiscale documentato dei token ricevuti, per le vendite future', [
        ['zero_confirmed', 'Costo zero confermato'],
        ['received_value_confirmed', 'Valore già tassato confermato'],
        ['manual', 'Costi documentati per singola riga']
      ], '', value => { options.rewardCostPolicy = value; }).wrapper;
      paragraph(rewardCostField, 'Conferma un costo documentato per i token ricevuti, compresi i premi di altra natura. Il sito non assume automaticamente costo zero né valore già tassato come regola generale. Per il criterio per riga, compila il costo fiscale totale in «Rettifica dati fiscali» per ogni premio.');
    }
    if (analysis.thirdFeeCount) {
      const fees = section('Commissioni in una terza crypto');
      paragraph(fees, `${analysis.thirdFeeCount} operazioni indicano una commissione in una crypto diversa da quelle scambiate. Verifica l’effettivo movimento del saldo per evitare sia doppi addebiti sia movimenti omessi.`);
      select(fees, 'Trattamento documentato della commissione', [
        ['included_no_additional_movement', 'Già inclusa: nessun ulteriore movimento della terza crypto'],
        ['separate_taxable_disposal', 'Pagamento aggiuntivo di un servizio in crypto: cessione rilevante']
      ], '', value => { options.thirdAssetFees = value; });
    }
    const sourceSection = section('Anteprima e rettifiche per singola riga');
    paragraph(sourceSection, 'L’anteprima mostra i valori originali, inclusi entrambi i controvalori EUR. Le rettifiche si applicano al calcolo senza modificare la fonte. Sono mostrate 50 righe per pagina; salva le rettifiche prima di cambiare pagina.');
    preview = element('div', 'exchange-review-preview');
    sourceSection.append(preview);
    updateDependencies();
    renderPreview();
    return analysis;
  }
  function getOptions() {
    if (openEditorId !== null) throw new Error(UNSAVED_MESSAGE);
    const overrides = Object.fromEntries(Object.entries(options.overrides).map(([id, values]) => [id, { ...values }]));
    return {
      ...options, swapTreatments: { ...options.swapTreatments }, rewardTreatments: { ...options.rewardTreatments }, overrides,
      rewardCosts: Object.fromEntries(Object.entries(overrides).filter(([, values]) => values.rewardCostEur !== undefined).map(([id, values]) => [id, values.rewardCostEur]))
    };
  }
  function updateDataset(currentDataset) {
    if (!parsed) return;
    balanceDataset = currentDataset;
    updateInitialSummary();
    renderBalanceCheck();
  }
  return { show, hide, getOptions, setErrors, updateDataset, get active() { return parsed !== null; } };
}
