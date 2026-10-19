import { EXCHANGE_CSV_COLUMNS } from './exchange-csv.js';

const DECIMAL = /^\d+(?:\.\d+)?$/;
const ASSET = /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]{0,49}$/u;
const OVERRIDE_FIELDS = new Set(['quantity', 'receivedQuantity', 'totalEur', 'rewardCostEur']);
const swapKey = values => values.sent_currency + '→' + values.received_currency;
const has = (object, key) => Object.hasOwn(object, key);
const clone = value => structuredClone(value);
function exactDecimal(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new Error('È richiesta una stringa decimale non negativa.');
  return value;
}
// Source strings can be larger than the engine's accepted amounts. Inspect
// their spelling here; bounds are checked before exact arithmetic in the engine.
const positive = value => /[1-9]/.test(exactDecimal(value));
const zero = value => !positive(value);
function normalizedDecimal(value) {
  const [whole, fraction = ''] = exactDecimal(value).split('.');
  return whole.replace(/^0+(?=\d)/, '') + '.' + fraction.replace(/0+$/, '');
}
const issue = (row, message) => ({ line: row.line, type: row.values.type, message });

function fail(errors) {
  const error = new Error(errors.map(item => `Riga ${item.line} (${item.type}): ${item.message}`).join('\n'));
  error.name = 'ExchangeImportError';
  error.errors = errors;
  throw error;
}

function sourceRows(parsed) {
  if (!parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0) {
    throw new Error('È richiesto un CSV exchange analizzato e non vuoto.');
  }
  for (const row of parsed.rows) {
    if (!row || !Number.isSafeInteger(row.line) || row.line < 1 || !row.values
      || EXCHANGE_CSV_COLUMNS.some(name => typeof row.values[name] !== 'string')) {
      throw new Error('Il CSV analizzato contiene una riga incompleta.');
    }
  }
  return parsed.rows;
}

function validAsset(value) {
  return value === value.trim().toUpperCase() && ASSET.test(value);
}

/** Classify only the structure of a record, never an asset's fiscal properties. */
function classify(row) {
  const value = row.values;
  for (const name of ['sent_amount', 'sent_value_EUR', 'received_amount', 'received_value_EUR', 'fee_amount', 'fee_value_EUR']) {
    if (!DECIMAL.test(value[name])) throw new Error(`${name} deve essere una stringa decimale non negativa.`);
  }
  for (const name of ['sent_currency', 'received_currency', 'fee_currency']) {
    if (value[name] && !validAsset(value[name])) throw new Error(`${name} deve essere un asset valido e maiuscolo.`);
  }
  if (positive(value.fee_amount) && !value.fee_currency) throw new Error('fee_currency è obbligatoria quando fee_amount è positivo.');
  if (zero(value.fee_amount) && !zero(value.fee_value_EUR)) throw new Error('fee_value_EUR non può essere positivo quando fee_amount è zero.');
  const twoPositiveLegs = () => {
    if (!positive(value.sent_amount) || !positive(value.received_amount)) {
      throw new Error('Le quantità inviata e ricevuta devono essere entrambe maggiori di zero.');
    }
  };
  const receiveOnly = () => {
    if (!zero(value.sent_amount) || !zero(value.sent_value_EUR)) {
      throw new Error('Questa operazione deve avere quantità e controvalore inviati uguali a zero.');
    }
    if (!positive(value.received_amount)) throw new Error('La quantità ricevuta deve essere maggiore di zero.');
  };
  switch (value.type) {
    case 'Buy':
      if (value.sent_currency !== 'EUR' || !value.received_currency || value.received_currency === 'EUR') {
        throw new Error('Buy richiede EUR inviati e una cripto-attività ricevuta.');
      }
      twoPositiveLegs();
      return 'buy';
    case 'Sell':
      if (!value.sent_currency || value.sent_currency === 'EUR' || value.received_currency !== 'EUR') {
        throw new Error('Sell richiede una cripto-attività inviata ed EUR ricevuti.');
      }
      twoPositiveLegs();
      return 'sell';
    case 'Trade':
      if (!value.sent_currency || !value.received_currency || value.sent_currency === 'EUR'
        || value.received_currency === 'EUR' || value.sent_currency === value.received_currency) {
        throw new Error('Trade richiede due cripto-attività diverse, senza EUR.');
      }
      twoPositiveLegs();
      return 'trade';
    case 'Receive':
      if (value.label !== 'Reward' || value.market_model_type !== 'EARN') {
        throw new Error('Receive è supportato soltanto con label Reward e market_model_type EARN.');
      }
      if (!value.received_currency || value.received_currency === 'EUR') throw new Error('Il premio deve ricevere una cripto-attività.');
      receiveOnly();
      return 'reward';
    case 'Deposit':
      if (value.received_currency !== 'EUR') throw new Error('Sono supportati soltanto i depositi in EUR.');
      receiveOnly();
      return 'deposit';
    default:
      throw new Error('Tipo di operazione non supportato; nessuna riga è stata importata.');
  }
}

function thirdAssetFee(values) {
  return positive(values.fee_amount) && values.fee_currency !== 'EUR' && values.fee_currency !== values.sent_currency
    && values.fee_currency !== values.received_currency;
}

/** An inventory to present the decisions required before any conversion. */
export function analyzeExchangeCsv(parsed) {
  const rows = sourceRows(parsed);
  const pairs = new Map();
  const counts = {};
  const unsupportedRows = [];
  let rewardCount = 0;
  let thirdFeeCount = 0;
  for (const row of rows) {
    const value = row.values;
    Object.defineProperty(counts, value.type, { value: (has(counts, value.type) ? counts[value.type] : 0) + 1,
      enumerable: true, writable: true, configurable: true });
    try {
      const kind = classify(row);
      if (kind === 'trade') {
        const key = swapKey(value);
        if (!pairs.has(key)) pairs.set(key, { key, sentAsset: value.sent_currency, receivedAsset: value.received_currency, count: 0 });
        pairs.get(key).count += 1;
      }
      if (kind === 'reward') rewardCount += 1;
      if (thirdAssetFee(value)) thirdFeeCount += 1;
    } catch (error) {
      unsupportedRows.push(issue(row, error.message));
    }
  }
  return { swapPairs: [...pairs.values()], rewardCount, thirdFeeCount, counts, unsupportedRows };
}

function feeId(id) {
  let prefix = '';
  for (const character of id) {
    if (prefix.length + character.length > 60) break;
    prefix += character;
  }
  return prefix + '.fee';
}

function overrideFor(row, options) {
  const overrides = options.overrides;
  if (!overrides || !has(overrides, row.values.id)) return null;
  const override = overrides[row.values.id];
  if (!override || typeof override !== 'object' || Array.isArray(override)) throw new Error('La rettifica deve essere un oggetto di importi decimali.');
  for (const [field, value] of Object.entries(override)) {
    if (!OVERRIDE_FIELDS.has(field)) throw new Error(`Campo di rettifica non supportato: ${field}.`);
    if (typeof value !== 'string' || !DECIMAL.test(value)) throw new Error(`La rettifica ${field} deve essere una stringa decimale non negativa.`);
  }
  return override;
}

function rewardTreatmentFor(row, options) {
  return options.rewardTreatments && has(options.rewardTreatments, row.values.id)
    ? options.rewardTreatments[row.values.id] : options.rewardsTreatment === 'holding_income' ? 'holding_income' : null;
}

function requireOptions(rows, options, analysis) {
  const errors = [...analysis.unsupportedRows];
  const optionError = message => errors.push(issue(rows[0], message));
  if (options.mode !== 'replace' && options.mode !== 'append') optionError('Scegli esplicitamente se sostituire o aggiungere le operazioni (mode).');
  if (options.dateConfirmed !== true) optionError('Conferma le date e gli orari riportati, con ordine di riga per gli orari identici (dateConfirmed).');
  if (options.grossValuesConfirmed !== true) optionError('Conferma che gli importi siano già adeguati al lordo fiscale e che le commissioni siano comprese (grossValuesConfirmed), oppure rettifica gli importi.');
  for (const pair of analysis.swapPairs) {
    const treatment = options.swapTreatments && has(options.swapTreatments, pair.key) ? options.swapTreatments[pair.key] : null;
    const row = rows.find(item => swapKey(item.values) === pair.key);
    if (treatment !== 'neutral' && treatment !== 'taxable') errors.push(issue(row, `Classifica esplicitamente la permuta ${pair.key} come neutral oppure taxable.`));
    else if (treatment === 'neutral' && options.lotDatePolicy !== 'historical' && options.lotDatePolicy !== 'exchange') {
      errors.push(issue(row, 'Scegli esplicitamente historical oppure exchange per la data dei lotti delle permute neutrali (lotDatePolicy).'));
    }
  }
  if (analysis.rewardCount) {
    const row = rows.find(item => item.values.type === 'Receive' && item.values.label === 'Reward' && item.values.market_model_type === 'EARN');
    if (options.rewardsTreatment !== 'holding_income' && options.rewardsTreatment !== 'per_row') {
      errors.push(issue(row, 'Conferma la classificazione dei premi come proventi da detenzione oppure per singola riga (rewardsTreatment).'));
    }
    if (options.rewardTreatments !== undefined && (!options.rewardTreatments || typeof options.rewardTreatments !== 'object' || Array.isArray(options.rewardTreatments))) {
      errors.push(issue(row, 'rewardTreatments deve essere un oggetto indicizzato per id del premio.'));
    } else {
      const rewardRows = rows.filter(item => item.values.type === 'Receive' && item.values.label === 'Reward' && item.values.market_model_type === 'EARN');
      const rewardIds = new Set(rewardRows.map(item => item.values.id));
      for (const item of rewardRows) {
        if (!['holding_income', 'documented_acquisition'].includes(rewardTreatmentFor(item, options))) {
          errors.push(issue(item, 'Classifica esplicitamente il premio come holding_income oppure documented_acquisition (rewardTreatments).'));
        }
      }
      for (const id of Object.keys(options.rewardTreatments || {})) {
        if (!rewardIds.has(id)) errors.push(issue(row, `Classificazione riferita a un id premio assente: ${id}.`));
      }
    }
    if (!['zero_confirmed', 'received_value_confirmed', 'manual'].includes(options.rewardCostPolicy)) {
      errors.push(issue(row, 'Scegli esplicitamente il costo fiscale documentato dei premi (rewardCostPolicy).'));
    }
  }
  if (analysis.thirdFeeCount && !['included_no_additional_movement', 'separate_taxable_disposal'].includes(options.thirdAssetFees)) {
    errors.push(issue(rows.find(item => thirdAssetFee(item.values)), 'Scegli esplicitamente il trattamento delle commissioni in un terzo asset (thirdAssetFees).'));
  }
  if (options.overrides !== undefined && (!options.overrides || typeof options.overrides !== 'object' || Array.isArray(options.overrides))) optionError('overrides deve essere un oggetto indicizzato per id.');
  else if (options.overrides) {
    const ids = new Set(rows.map(row => row.values.id));
    for (const id of Object.keys(options.overrides)) if (!ids.has(id)) optionError(`Rettifica riferita a un id assente dal CSV: ${id}.`);
  }
  if (errors.length) fail(errors);
}

/**
 * Convert only after explicit accounting choices. No initial lot or balance is
 * invented, and source fees are never added again to effective source amounts.
 */
export function convertExchangeCsv(parsed, currentDataset, options = {}) {
  const rows = sourceRows(parsed);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Sono richieste opzioni esplicite di importazione.');
  const analysis = analyzeExchangeCsv(parsed);
  requireOptions(rows, options, analysis);
  if (!currentDataset || !Array.isArray(currentDataset.initialLots) || !Array.isArray(currentDataset.transactions)
    || !Array.isArray(currentDataset.carryLosses)) throw new Error('È richiesta la situazione iniziale del sito, anche con liste vuote.');
  const dataset = clone(currentDataset);
  dataset.version = 2;
  if (options.mode === 'replace') dataset.transactions = [];
  const occupiedIds = new Set([...dataset.initialLots, ...dataset.carryLosses, ...dataset.transactions].map(item => item.id));
  const existingDates = new Set(dataset.transactions.map(item => item.date));
  const entries = [];
  const errors = [];
  const sourceIds = new Set();
  for (const row of rows) {
    const value = row.values;
    try {
      if (sourceIds.has(value.id)) throw new Error('Identificativo duplicato nel CSV.');
      sourceIds.add(value.id);
      if (occupiedIds.has(value.id)) throw new Error('Identificativo già presente nella sessione: ' + value.id + '.');
      occupiedIds.add(value.id);
      const date = value.datetime_tz_CET.slice(0, 10);
      if (options.mode === 'append' && existingDates.has(date)) {
        throw new Error('La data ' + date + ' contiene già operazioni: la loro sequenza rispetto agli orari del CSV non è verificabile. Usa la sostituzione oppure riconcilia le operazioni.');
      }
      const kind = classify(row);
      const override = overrideFor(row, options);
      if (override && has(override, 'receivedQuantity') && kind !== 'trade') throw new Error('receivedQuantity è rettificabile soltanto per una permuta.');
      if (override && has(override, 'rewardCostEur') && kind !== 'reward') throw new Error('rewardCostEur è rettificabile soltanto per un premio.');
      if (kind === 'trade' && options.swapTreatments[swapKey(value)] === 'neutral' && override && has(override, 'totalEur')) {
        throw new Error('Una permuta neutrale trasferisce il costo storico e non accetta la rettifica totalEur.');
      }
      const sent = kind === 'sell' || kind === 'trade';
      const transaction = {
        id: value.id, date, order: 0, type: '',
        asset: sent ? value.sent_currency : value.received_currency,
        quantity: override && has(override, 'quantity') ? override.quantity : sent ? value.sent_amount : value.received_amount,
        unitPrice: kind === 'deposit' ? '1' : '0', fees: '0'
      };
      if (!positive(transaction.quantity)) throw new Error('La quantità finale deve essere maggiore di zero.');
      const totalEur = override && has(override, 'totalEur') ? override.totalEur : kind === 'buy' ? value.sent_value_EUR : value.received_value_EUR;
      let treatment = 'not_applicable';
      if (kind === 'trade') {
        treatment = options.swapTreatments[swapKey(value)];
        transaction.type = treatment === 'neutral' ? 'permuta_neutrale' : 'permuta_imponibile';
        transaction.receivedAsset = value.received_currency;
        transaction.receivedQuantity = override && has(override, 'receivedQuantity') ? override.receivedQuantity : value.received_amount;
        if (!positive(transaction.receivedQuantity)) throw new Error('La quantità ricevuta finale deve essere maggiore di zero.');
        if (treatment === 'neutral') transaction.lotDatePolicy = options.lotDatePolicy;
        else transaction.totalEur = totalEur;
      } else {
        transaction.type = { buy: 'acquisto', sell: 'vendita', reward: 'provento', deposit: 'deposito_eur' }[kind];
        transaction.totalEur = totalEur;
      }
      const rewardTreatment = kind === 'reward' ? rewardTreatmentFor(row, options) : 'not_applicable';
      if (kind === 'reward') {
        if (rewardTreatment === 'documented_acquisition' && override && has(override, 'totalEur')) {
          throw new Error('Per un premio classificato come acquisizione documentata, rettifica il costo con rewardCostEur, non il provento totalEur.');
        }
        if (options.rewardCostPolicy === 'zero_confirmed') {
          if (override && has(override, 'rewardCostEur') && !zero(override.rewardCostEur)) throw new Error('La rettifica del costo premio contraddice zero_confirmed. Scegli manual.');
          transaction.rewardCostEur = '0';
        } else if (options.rewardCostPolicy === 'received_value_confirmed') {
          if (override && has(override, 'rewardCostEur') && normalizedDecimal(override.rewardCostEur) !== normalizedDecimal(totalEur)) throw new Error('La rettifica del costo premio contraddice received_value_confirmed. Scegli manual.');
          transaction.rewardCostEur = totalEur;
        } else {
          const cost = override && has(override, 'rewardCostEur') ? override.rewardCostEur
            : options.rewardCosts && has(options.rewardCosts, value.id) ? options.rewardCosts[value.id] : undefined;
          if (typeof cost !== 'string' || !DECIMAL.test(cost)) throw new Error('Indica il costo fiscale documentato del premio in rewardCosts o nella rettifica rewardCostEur.');
          transaction.rewardCostEur = cost;
        }
        if (rewardTreatment === 'documented_acquisition') {
          transaction.type = 'acquisto';
          transaction.totalEur = transaction.rewardCostEur;
          delete transaction.rewardCostEur;
        }
      }
      const thirdFee = thirdAssetFee(value);
      const separateFee = thirdFee && options.thirdAssetFees === 'separate_taxable_disposal';
      const decisions = {
        swapTaxTreatment: treatment,
        rewardTreatment,
        rewardCostPolicy: kind === 'reward' ? options.rewardCostPolicy : 'not_applicable',
        amountsPolicy: override ? 'manual' : 'as_reported_confirmed',
        feePolicy: zero(value.fee_amount) ? 'not_applicable' : separateFee ? 'separate_taxable_disposal' : 'already_included',
        lotDatePolicy: treatment === 'neutral' ? options.lotDatePolicy : 'not_applicable',
        grossValuesConfirmed: true
      };
      transaction.source = { line: row.line, values: Object.fromEntries(EXCHANGE_CSV_COLUMNS.map(name => [name, value[name]])), decisions };
      const events = [transaction];
      if (separateFee) {
        const id = feeId(value.id);
        if (occupiedIds.has(id) || rows.some(item => item.values.id === id)) throw new Error('Collisione nell’identificativo della commissione separata: ' + id + '.');
        occupiedIds.add(id);
        events.push({ id, date, order: 0, type: 'vendita', asset: value.fee_currency, quantity: value.fee_amount,
          unitPrice: '0', fees: '0', totalEur: value.fee_value_EUR, source: { ...clone(transaction.source), derived: true } });
      }
      entries.push({ timestamp: value.datetime_tz_CET, line: row.line, events });
    } catch (error) {
      errors.push(issue(row, error.message));
    }
  }
  if (errors.length) fail(errors);
  entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.line - right.line);
  const dayOrders = new Map();
  const imported = [];
  for (const entry of entries) {
    for (const transaction of entry.events) {
      const order = (dayOrders.get(transaction.date) || 0) + 1;
      dayOrders.set(transaction.date, order);
      transaction.order = order;
      imported.push(transaction);
    }
  }
  dataset.transactions.push(...imported);
  return {
    dataset,
    summary: { mode: options.mode, rowCount: rows.length, transactionCount: imported.length, counts: analysis.counts,
      rewardCount: analysis.rewardCount, thirdFeeCount: analysis.thirdFeeCount, swapPairs: analysis.swapPairs },
    warnings: []
  };
}
