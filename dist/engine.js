import { Decimal } from './decimal.js';

const ZERO = Decimal.from('0');
const MAX_ROWS = 5000;
const YEARS = [2025, 2026];
const VALID_TYPES = new Set(['acquisto', 'vendita']);
const V2_TYPES = new Set([...VALID_TYPES, 'permuta_neutrale', 'permuta_imponibile', 'provento', 'deposito_eur']);
const EXCHANGE_TYPES = new Set(['permuta_neutrale', 'permuta_imponibile']);
const EXTENDED_FIELDS = ['totalEur', 'rewardCostEur', 'receivedAsset', 'receivedQuantity', 'lotDatePolicy'];
const decimalPattern = /^\d{1,30}(?:\.\d{1,18})?$/;
const unsafeText = /^[\s\uFEFF]*[=+\-@]/u;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '0001-01-01'
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const isAsset = value => typeof value === 'string' && value === value.trim().toUpperCase()
  && /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]{0,49}$/u.test(value);
const isOrder = value => Number.isSafeInteger(value) && value >= 0;
const chronological = (left, right) => left.date.localeCompare(right.date) || left.order - right.order;
const average = (cost, quantity) => quantity.cmp(ZERO) === 0 ? ZERO : cost.div(quantity);
const sum = values => values.reduce((result, value) => result.add(value), ZERO);
const formatLoss = loss => ({ originYear: loss.originYear, expiresYear: loss.originYear + 4,
  amount: loss.amount.toString(), displayAmount: loss.amount.toFixed(2) });

export class ValidationError extends Error {
  constructor(errors) {
    super('I dati contengono errori. Correggi le righe indicate prima del calcolo.');
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/** Validate the entire snapshot, including chronological available balances. */
export function validateDataset(data) {
  const errors = [];
  const report = (location, message) => errors.push({ location, message });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [{ location: 'dataset', message: 'Il dataset deve essere un oggetto.' }];
  }
  if (data.version !== 1 && data.version !== 2) report('version', 'Versione del formato non supportata: usa 1 oppure 2.');
  const openingValid = isDate(data.openingDate) && data.openingDate >= '2025-01-01' && data.openingDate <= '2026-12-31';
  if (!openingValid) report('openingDate', 'La data di apertura deve essere compresa tra 2025-01-01 e 2026-12-31.');
  const collections = ['initialLots', 'transactions', 'carryLosses'];
  for (const name of collections) {
    if (!Array.isArray(data[name])) report(name, 'È richiesta una lista, anche vuota.');
  }
  if (collections.some(name => !Array.isArray(data[name]))) return errors;
  if (collections.reduce((total, name) => total + data[name].length, 0) > MAX_ROWS) {
    report('dataset', 'Il limite è di 5.000 righe complessive.');
    return errors;
  }

  const ids = new Set();
  const acquisitionKeys = new Set();
  const transactionKeys = new Set();
  const lossYears = new Set();
  const balances = new Map();
  const goodTransactions = [];
  const openingAssets = new Map();
  const checkId = (row, location) => {
    if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > 64
      || controlCharacters.test(row.id) || unsafeText.test(row.id)) {
      report(location + '.id', 'Usa un identificativo non vuoto, fino a 64 caratteri, senza caratteri di controllo e senza prefissi =, +, - o @.');
    } else if (ids.has(row.id)) report(location + '.id', 'Identificativo duplicato: ' + row.id + '.');
    else ids.add(row.id);
  };
  const checkAmount = (value, location, positive = false) => {
    if (typeof value !== 'string' || !decimalPattern.test(value)) {
      report(location, 'Usa una stringa non negativa con punto decimale, fino a 18 decimali e 30 cifre intere.');
      return null;
    }
    const amount = Decimal.from(value);
    if (positive && amount.cmp(ZERO) <= 0) {
      report(location, 'Il valore deve essere maggiore di zero.');
      return null;
    }
    return amount;
  };
  const checkObject = (row, location) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      report(location, 'La riga deve essere un oggetto.');
      return false;
    }
    return true;
  };

  data.initialLots.forEach((lot, index) => {
    const location = 'initialLots[' + index + ']';
    if (!checkObject(lot, location)) return;
    checkId(lot, location);
    if (!isAsset(lot.asset)) report(location + '.asset', 'Usa un nome asset maiuscolo, senza spazi iniziali o finali, fino a 50 caratteri.');
    const estimated = lot.basisMethod === 'estimated_average';
    if (Object.hasOwn(lot, 'basisMethod') && (data.version !== 2 || !estimated)) report(location + '.basisMethod', 'Il costo medio stimato richiede il formato 2 e basisMethod estimated_average.');
    const sameAsset = openingAssets.get(lot.asset);
    if (sameAsset !== undefined && (estimated || data.initialLots[sameAsset].basisMethod === 'estimated_average')) report(location + '.asset', 'Il saldo iniziale aggregato stimato deve essere l’unico lotto iniziale di questa crypto; ricostruisci i lotti documentati prima di suddividerlo.');
    if (sameAsset === undefined) openingAssets.set(lot.asset, index);
    if (estimated ? lot.acquiredOn !== '' : !isDate(lot.acquiredOn) || openingValid && lot.acquiredOn > data.openingDate) {
      report(location + '.acquiredOn', estimated ? 'Il saldo aggregato stimato deve avere data originaria vuota: non attribuire una data inventata.' : 'La data di acquisto deve essere valida e non successiva all’apertura.');
    }
    if (!isOrder(lot.order)) report(location + '.order', 'L’ordine deve essere un intero non negativo.');
    const quantity = checkAmount(lot.quantity, location + '.quantity', true);
    checkAmount(lot.unitCost, location + '.unitCost');
    if (isAsset(lot.asset) && isDate(lot.acquiredOn) && isOrder(lot.order)) {
      const key = JSON.stringify([lot.asset, lot.acquiredOn, lot.order]);
      if (acquisitionKeys.has(key)) report(location + '.order', 'Ordine di acquisizione duplicato per asset e data.');
      acquisitionKeys.add(key);
    }
    if (isAsset(lot.asset) && quantity) balances.set(lot.asset, (balances.get(lot.asset) || ZERO).add(quantity));
  });

  data.transactions.forEach((transaction, index) => {
    const location = 'transactions[' + index + ']';
    if (!checkObject(transaction, location)) return;
    checkId(transaction, location);
    const dateValid = isDate(transaction.date) && transaction.date >= '2025-01-01' && transaction.date <= '2026-12-31'
      && (!openingValid || transaction.date >= data.openingDate);
    if (!dateValid) report(location + '.date', 'La data deve ricadere nel 2025 o 2026 e non precedere l’apertura.');
    const typeValid = (data.version === 2 ? V2_TYPES : VALID_TYPES).has(transaction.type);
    if (!typeValid) report(location + '.type', data.version === 2
      ? 'Usa acquisto, vendita, permuta_neutrale, permuta_imponibile, provento oppure deposito_eur.'
      : 'Il formato 1 supporta soltanto acquisto e vendita.');
    if (!isAsset(transaction.asset)) report(location + '.asset', 'Usa un nome asset maiuscolo, senza spazi iniziali o finali, fino a 50 caratteri.');
    if (!isOrder(transaction.order)) report(location + '.order', 'L’ordine deve essere un intero non negativo.');
    const quantity = checkAmount(transaction.quantity, location + '.quantity', true);
    const price = checkAmount(transaction.unitPrice, location + '.unitPrice');
    const fees = checkAmount(transaction.fees, location + '.fees');
    const exchange = EXCHANGE_TYPES.has(transaction.type);
    let receivedQuantity = null;
    for (const field of EXTENDED_FIELDS) {
      if (Object.hasOwn(transaction, field) && data.version !== 2) report(location + '.' + field, 'Questo campo richiede il formato 2.');
    }
    if (Object.hasOwn(transaction, 'totalEur')) checkAmount(transaction.totalEur, location + '.totalEur');
    if (transaction.type === 'provento' || transaction.type === 'permuta_imponibile') {
      if (!Object.hasOwn(transaction, 'totalEur')) report(location + '.totalEur', 'Indica il controvalore lordo effettivo in euro.');
    }
    if (transaction.type === 'provento') {
      checkAmount(transaction.rewardCostEur, location + '.rewardCostEur');
    } else if (Object.hasOwn(transaction, 'rewardCostEur')) report(location + '.rewardCostEur', 'Il costo fiscale documentato è previsto soltanto per i proventi.');
    if (exchange) {
      if (!isAsset(transaction.receivedAsset)) report(location + '.receivedAsset', 'Indica un asset ricevuto valido e maiuscolo.');
      else if (transaction.receivedAsset === transaction.asset) report(location + '.receivedAsset', 'L’asset ricevuto deve essere diverso dall’asset ceduto.');
      receivedQuantity = checkAmount(transaction.receivedQuantity, location + '.receivedQuantity', true);
    } else {
      for (const field of ['receivedAsset', 'receivedQuantity']) {
        if (Object.hasOwn(transaction, field)) report(location + '.' + field, 'Questo campo è previsto soltanto per le permute.');
      }
    }
    if (transaction.type === 'permuta_neutrale') {
      if (transaction.lotDatePolicy !== 'historical' && transaction.lotDatePolicy !== 'exchange') {
        report(location + '.lotDatePolicy', 'Scegli esplicitamente historical oppure exchange per la data dei lotti ricevuti.');
      }
      if (Object.hasOwn(transaction, 'totalEur')) report(location + '.totalEur', 'La permuta neutrale trasferisce il costo storico: il controvalore non è un corrispettivo fiscale.');
    } else if (Object.hasOwn(transaction, 'lotDatePolicy')) report(location + '.lotDatePolicy', 'La scelta della data dei lotti è prevista soltanto per le permute neutrali.');
    if (typeValid && !VALID_TYPES.has(transaction.type)) {
      if (fees && fees.cmp(ZERO) !== 0) report(location + '.fees', 'Per questa operazione usa commissioni 0: le quantità importate sono già effettive.');
      const expectedPrice = transaction.type === 'deposito_eur' ? '1' : '0';
      if (price && price.cmp(expectedPrice) !== 0) report(location + '.unitPrice', 'Per questa operazione il prezzo unitario deve essere ' + expectedPrice + '.');
    }
    if (transaction.type === 'deposito_eur' && transaction.asset !== 'EUR') report(location + '.asset', 'Il deposito in euro deve avere asset EUR.');
    if (isDate(transaction.date) && isOrder(transaction.order)) {
      const key = JSON.stringify([transaction.date, transaction.order]);
      if (transactionKeys.has(key)) report(location + '.order', 'Ordine duplicato nella stessa data: assegna ordini distinti.');
      transactionKeys.add(key);
    }
    if (dateValid && isOrder(transaction.order) && typeValid && isAsset(transaction.asset) && quantity
      && (!exchange || isAsset(transaction.receivedAsset) && transaction.receivedAsset !== transaction.asset && receivedQuantity)) {
      goodTransactions.push({ ...transaction, quantityDecimal: quantity, receivedQuantityDecimal: receivedQuantity, location });
    }
  });

  goodTransactions.sort(chronological).forEach(transaction => {
    const balance = balances.get(transaction.asset) || ZERO;
    if (transaction.type === 'deposito_eur') return;
    if (transaction.type === 'acquisto' || transaction.type === 'provento') balances.set(transaction.asset, balance.add(transaction.quantityDecimal));
    else if (balance.cmp(transaction.quantityDecimal) < 0) {
      report(transaction.location + '.quantity', 'Cessione superiore alla disponibilità: ' + balance.toString() + ' ' + transaction.asset + '.');
    } else {
      balances.set(transaction.asset, balance.sub(transaction.quantityDecimal));
      if (EXCHANGE_TYPES.has(transaction.type)) balances.set(transaction.receivedAsset,
        (balances.get(transaction.receivedAsset) || ZERO).add(transaction.receivedQuantityDecimal));
    }
  });

  data.carryLosses.forEach((loss, index) => {
    const location = 'carryLosses[' + index + ']';
    if (!checkObject(loss, location)) return;
    checkId(loss, location);
    if (!Number.isInteger(loss.year) || loss.year < 2021 || loss.year > 2025
      || openingValid && loss.year >= Number(data.openingDate.slice(0, 4))) {
      report(location + '.year', 'Indica un anno dal 2021 al 2025 precedente all’anno di apertura.');
    }
    if (lossYears.has(loss.year)) report(location + '.year', 'Inserisci un solo residuo complessivo per anno di origine.');
    lossYears.add(loss.year);
    checkAmount(loss.amount, location + '.amount', true);
  });
  return errors;
}

function calculateTax(data, calculatedRows, selectedYear) {
  const openingYear = Number(data.openingDate.slice(0, 4));
  let available = data.carryLosses.map(loss => ({ originYear: loss.year, amount: Decimal.from(loss.amount) }));
  const expired = [];
  let result;
  for (const year of YEARS.filter(value => value >= openingYear && value <= selectedYear)) {
    expired.push(...available.filter(loss => loss.originYear + 4 < year));
    available = available.filter(loss => loss.originYear + 4 >= year).sort((left, right) => left.originYear - right.originYear);
    const yearResults = calculatedRows.filter(row => row.date.startsWith(String(year)) && row.fiscalResult !== null)
      .map(row => row.exactFiscalResult);
    const gains = sum(yearResults.filter(value => value.cmp(ZERO) > 0));
    const income = sum(calculatedRows.filter(row => row.date.startsWith(String(year)) && row.fiscalKind === 'income')
      .map(row => row.exactFiscalResult));
    const capitalGains = gains.sub(income);
    const losses = ZERO.sub(sum(yearResults.filter(value => value.cmp(ZERO) < 0)));
    const net = gains.sub(losses);
    const currentLoss = ZERO.sub(net).max(ZERO);
    let taxable = net.max(ZERO);
    let lossesUsed = ZERO;
    for (const loss of available) {
      const used = loss.amount.min(taxable);
      loss.amount = loss.amount.sub(used);
      taxable = taxable.sub(used);
      lossesUsed = lossesUsed.add(used);
    }
    available = available.filter(loss => loss.amount.cmp(ZERO) > 0);
    if (currentLoss.cmp(ZERO) > 0) available.push({ originYear: year, amount: currentLoss });
    const rate = year === 2025 ? 26 : 33;
    result = {
      year, rate, gains: gains.toString(), capitalGains: capitalGains.toString(), income: income.toString(), losses: losses.toString(), net: net.toString(),
      currentLoss: currentLoss.toString(), lossesUsed: lossesUsed.toString(), taxable: taxable.toString(),
      tax: taxable.mul(String(rate)).div('100').toFixed(2),
      // Format from the exact values: formatting the serialized 18-place values
      // again can cross a half-cent boundary and introduce a second rounding.
      display: { gains: gains.toFixed(2), capitalGains: capitalGains.toFixed(2), income: income.toFixed(2), losses: losses.toFixed(2), net: net.toFixed(2),
        lossesUsed: lossesUsed.toFixed(2), taxable: taxable.toFixed(2) },
      remainingLosses: available.map(formatLoss), expiredLosses: expired.map(formatLoss),
    };
  }
  return result;
}

/** All portfolio rows are calculated; tax includes only the selected calendar year. */
export function calculate(data, selectedYear = typeof data?.openingDate === 'string' ? Number(data.openingDate.slice(0, 4)) : NaN) {
  const errors = validateDataset(data);
  if (!YEARS.includes(selectedYear)) errors.push({ location: 'selectedYear', message: 'Il calcolo fiscale supporta gli anni 2025 e 2026.' });
  else if (isDate(data?.openingDate) && selectedYear < Number(data.openingDate.slice(0, 4))) {
    errors.push({ location: 'selectedYear', message: 'L’anno fiscale non può precedere l’anno di apertura.' });
  }
  if (errors.length) throw new ValidationError(errors);
  const portfolios = new Map();
  let lotSequence = 0;
  const getHolding = asset => {
    if (!portfolios.has(asset)) portfolios.set(asset, { asset, quantity: ZERO, cost: ZERO, fiscalCost: ZERO, lots: [] });
    return portfolios.get(asset);
  };
  const addLot = (holding, { id, acquiredOn, order, quantity, fiscalCost, managementCost, initial = false, provenance }) => {
    holding.quantity = holding.quantity.add(quantity);
    holding.cost = holding.cost.add(managementCost);
    holding.fiscalCost = holding.fiscalCost.add(fiscalCost);
    // A separate unique sequence also distinguishes the portions of a single
    // neutral exchange without altering the public transaction order.
    holding.lots.push({ id, acquiredOn, order, quantity, unitCost: fiscalCost.div(quantity),
      initial, lotSequence: lotSequence++, provenance });
  };
  const consumeLots = (holding, quantity) => {
    const managementCost = average(holding.cost, holding.quantity).mul(quantity);
    let remaining = quantity;
    let fiscalCost = ZERO;
    const pieces = [];
    // Opening holdings precede purchases on the opening date. Historical neutral
    // transfers retain the acquisition date and the source lot's relative order.
    holding.lots.sort((left, right) => right.acquiredOn.localeCompare(left.acquiredOn)
      || Number(left.initial) - Number(right.initial) || right.order - left.order || right.lotSequence - left.lotSequence);
    for (const lot of holding.lots) {
      if (remaining.cmp(ZERO) === 0) break;
      const used = lot.quantity.min(remaining);
      if (used.cmp(ZERO) === 0) continue;
      const cost = used.mul(lot.unitCost);
      fiscalCost = fiscalCost.add(cost);
      pieces.push({ ...lot, quantity: used, cost });
      lot.quantity = lot.quantity.sub(used);
      remaining = remaining.sub(used);
    }
    holding.lots = holding.lots.filter(lot => lot.quantity.cmp(ZERO) > 0);
    holding.quantity = holding.quantity.sub(quantity);
    holding.cost = holding.quantity.cmp(ZERO) === 0 ? ZERO : holding.cost.sub(managementCost);
    holding.fiscalCost = holding.quantity.cmp(ZERO) === 0 ? ZERO : holding.fiscalCost.sub(fiscalCost);
    return { fiscalCost, managementCost, pieces };
  };
  for (const initial of data.initialLots) {
    const quantity = Decimal.from(initial.quantity);
    const cost = quantity.mul(initial.unitCost);
    addLot(getHolding(initial.asset), { id: initial.id, acquiredOn: initial.acquiredOn, order: initial.order,
      quantity, fiscalCost: cost, managementCost: cost, initial: true });
  }
  const calculatedRows = [];
  for (const transaction of [...data.transactions].sort(chronological)) {
    const fiat = transaction.type === 'deposito_eur';
    const holding = fiat ? { quantity: ZERO, cost: ZERO, fiscalCost: ZERO } : getHolding(transaction.asset);
    const quantity = Decimal.from(transaction.quantity);
    const price = Decimal.from(transaction.unitPrice);
    const fees = Decimal.from(transaction.fees);
    const total = Object.hasOwn(transaction, 'totalEur') ? Decimal.from(transaction.totalEur) : quantity.mul(price);
    const beforeQuantity = holding.quantity;
    const beforeAverage = average(holding.cost, holding.quantity);
    const fiscalBeforeAverage = average(holding.fiscalCost, holding.quantity);
    let lotDetails = [];
    let proceeds = null;
    let managementProceeds = null;
    let costBasis = ZERO;
    let managementCostBasis = ZERO;
    let fiscalResult = null;
    let managementResult = null;
    let fiscalKind = 'none';
    let received = null;
    if (transaction.type === 'acquisto') {
      // Article 68(9-bis), as interpreted in Circular 30/E: fees affect the
      // management balance but do not increase the deductible fiscal basis.
      costBasis = total;
      managementCostBasis = total.add(fees);
      addLot(holding, { id: transaction.id, acquiredOn: transaction.date, order: transaction.order,
        quantity, fiscalCost: costBasis, managementCost: managementCostBasis });
    } else if (transaction.type === 'provento') {
      proceeds = total;
      fiscalResult = total;
      fiscalKind = 'income';
      costBasis = Decimal.from(transaction.rewardCostEur);
      managementCostBasis = total;
      addLot(holding, { id: transaction.id, acquiredOn: transaction.date, order: transaction.order,
        quantity, fiscalCost: costBasis, managementCost: managementCostBasis });
    } else if (fiat) {
      fiscalKind = 'fiat';
    } else {
      const consumed = consumeLots(holding, quantity);
      costBasis = consumed.fiscalCost;
      managementCostBasis = consumed.managementCost;
      lotDetails = consumed.pieces.map(piece => ({ lotId: piece.id, acquiredOn: piece.acquiredOn, order: piece.order,
        lotSequence: piece.lotSequence, quantity: piece.quantity.toString(), unitCost: piece.unitCost.toString(), cost: piece.cost.toString(),
        ...(piece.provenance ? { provenance: structuredClone(piece.provenance) } : {}) }));
      if (transaction.type === 'permuta_neutrale') {
        fiscalKind = 'neutral';
        const target = getHolding(transaction.receivedAsset);
        const receivedQuantity = Decimal.from(transaction.receivedQuantity);
        const receivedBeforeQuantity = target.quantity;
        for (const piece of consumed.pieces) {
          const portion = piece.quantity.div(quantity);
          const historical = transaction.lotDatePolicy === 'historical';
          addLot(target, { id: transaction.id, acquiredOn: historical ? piece.acquiredOn : transaction.date,
            order: historical ? piece.order : transaction.order, initial: historical && piece.initial,
            quantity: receivedQuantity.mul(portion), fiscalCost: piece.cost, managementCost: managementCostBasis.mul(portion),
            provenance: { lotId: piece.id, acquiredOn: piece.acquiredOn, order: piece.order,
              asset: transaction.asset, originLotId: piece.provenance?.originLotId ?? piece.id,
              originAcquiredOn: piece.provenance?.originAcquiredOn ?? piece.acquiredOn,
              originOrder: piece.provenance?.originOrder ?? piece.order,
              originAsset: piece.provenance?.originAsset ?? transaction.asset } });
        }
        received = { receivedAsset: transaction.receivedAsset, receivedQuantity: receivedQuantity.toString(),
          receivedBeforeQuantity: receivedBeforeQuantity.toString(), receivedAfterQuantity: target.quantity.toString(),
          receivedBeforeAverage: average(target.cost.sub(managementCostBasis), receivedBeforeQuantity).toString(),
          receivedAfterAverage: average(target.cost, target.quantity).toString(), lotDatePolicy: transaction.lotDatePolicy };
      } else {
        proceeds = total;
        managementProceeds = total.sub(fees);
        fiscalResult = proceeds.sub(costBasis);
        managementResult = managementProceeds.sub(managementCostBasis);
        fiscalKind = 'capital_gain';
        if (transaction.type === 'permuta_imponibile') {
          const target = getHolding(transaction.receivedAsset);
          const receivedQuantity = Decimal.from(transaction.receivedQuantity);
          const receivedBeforeQuantity = target.quantity;
          const receivedBeforeAverage = average(target.cost, target.quantity);
          addLot(target, { id: transaction.id, acquiredOn: transaction.date, order: transaction.order,
            quantity: receivedQuantity, fiscalCost: total, managementCost: total });
          received = { receivedAsset: transaction.receivedAsset, receivedQuantity: receivedQuantity.toString(),
            receivedBeforeQuantity: receivedBeforeQuantity.toString(), receivedAfterQuantity: target.quantity.toString(),
            receivedBeforeAverage: receivedBeforeAverage.toString(), receivedAfterAverage: average(target.cost, target.quantity).toString() };
        }
      }
    }
    calculatedRows.push({
      id: transaction.id, date: transaction.date, asset: transaction.asset, type: transaction.type, order: transaction.order,
      quantity: quantity.toString(), unitPrice: price.toString(), fees: fees.toString(),
      ...(Object.hasOwn(transaction, 'totalEur') ? { totalEur: transaction.totalEur } : {}),
      ...(Object.hasOwn(transaction, 'rewardCostEur') ? { rewardCostEur: transaction.rewardCostEur } : {}),
      ...(Object.hasOwn(transaction, 'source') ? { source: structuredClone(transaction.source) } : {}),
      ...(received || {}), fiscalKind,
      beforeQuantity: beforeQuantity.toString(), beforeAverage: beforeAverage.toString(),
      afterQuantity: holding.quantity.toString(), afterAverage: average(holding.cost, holding.quantity).toString(),
      fiscalBeforeAverage: fiscalBeforeAverage.toString(), fiscalAfterAverage: average(holding.fiscalCost, holding.quantity).toString(),
      proceeds: proceeds?.toString() ?? null, costBasis: costBasis.toString(),
      managementProceeds: managementProceeds?.toString() ?? null, managementCostBasis: managementCostBasis.toString(),
      fiscalResult: fiscalResult?.toString() ?? null, managementResult: managementResult?.toString() ?? null,
      display: { proceeds: proceeds?.toFixed(2) ?? null, costBasis: costBasis.toFixed(2),
        fiscalResult: fiscalResult?.toFixed(2) ?? null, fiscalSign: fiscalResult?.cmp(ZERO) ?? null },
      lotDetails, exactFiscalResult: fiscalResult,
    });
  }
  const tax = calculateTax(data, calculatedRows, selectedYear);
  const rows = calculatedRows.map(({ exactFiscalResult, ...row }) => row);
  const holdings = [...portfolios.values()].sort((left, right) => left.asset.localeCompare(right.asset)).map(holding => {
    const fiscal = holding.fiscalCost;
    return { asset: holding.asset, quantity: holding.quantity.toString(), average: average(holding.cost, holding.quantity).toString(),
      cost: holding.cost.toString(), fiscalCost: fiscal.toString(), fiscalAverage: average(fiscal, holding.quantity).toString() };
  });
  const warnings = [];
  if (data.initialLots.some(lot => lot.basisMethod === 'estimated_average')) warnings.push('Sono presenti saldi iniziali a prezzo medio storico stimato, con date di acquisto non disponibili. I risultati e l’imposta sono indicativi: i singoli lotti LIFO iniziali non sono ricostruiti. Puoi correggere i costi nella Situazione iniziale.');
  if (!data.openingDate.endsWith('-01-01')) warnings.push('Il riepilogo annuale comprende solo le operazioni dalla data di apertura: per l’imposta annuale occorre includere tutte le operazioni dell’anno.');
  if (tax.expiredLosses.length) warnings.push('Le minusvalenze pregresse scadute sono escluse dalla compensazione.');
  return { rows, holdings, tax, warnings };
}
