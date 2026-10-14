import { Decimal } from './decimal.js';

const ZERO = Decimal.from('0');
const MAX_ROWS = 5000;
const YEARS = [2025, 2026];
const VALID_TYPES = new Set(['acquisto', 'vendita']);
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
const formatLoss = loss => ({ originYear: loss.originYear, expiresYear: loss.originYear + 4, amount: loss.amount.toString() });

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
  if (data.version !== 1) report('version', 'Versione del formato non supportata: usa 1.');
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
    if (!isDate(lot.acquiredOn) || openingValid && lot.acquiredOn > data.openingDate) {
      report(location + '.acquiredOn', 'La data di acquisto deve essere valida e non successiva all’apertura.');
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
    if (!VALID_TYPES.has(transaction.type)) report(location + '.type', 'Usa acquisto oppure vendita.');
    if (!isAsset(transaction.asset)) report(location + '.asset', 'Usa un nome asset maiuscolo, senza spazi iniziali o finali, fino a 50 caratteri.');
    if (!isOrder(transaction.order)) report(location + '.order', 'L’ordine deve essere un intero non negativo.');
    const quantity = checkAmount(transaction.quantity, location + '.quantity', true);
    checkAmount(transaction.unitPrice, location + '.unitPrice');
    checkAmount(transaction.fees, location + '.fees');
    if (isDate(transaction.date) && isOrder(transaction.order)) {
      const key = JSON.stringify([transaction.date, transaction.order]);
      if (transactionKeys.has(key)) report(location + '.order', 'Ordine duplicato nella stessa data: assegna ordini distinti.');
      transactionKeys.add(key);
    }
    if (dateValid && isOrder(transaction.order) && VALID_TYPES.has(transaction.type) && isAsset(transaction.asset) && quantity) {
      goodTransactions.push({ ...transaction, quantityDecimal: quantity, location });
    }
  });

  goodTransactions.sort(chronological).forEach(transaction => {
    const balance = balances.get(transaction.asset) || ZERO;
    if (transaction.type === 'acquisto') balances.set(transaction.asset, balance.add(transaction.quantityDecimal));
    else if (balance.cmp(transaction.quantityDecimal) < 0) {
      report(transaction.location + '.quantity', 'Vendita superiore alla disponibilità: ' + balance.toString() + ' ' + transaction.asset + '.');
    } else balances.set(transaction.asset, balance.sub(transaction.quantityDecimal));
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
      year, rate, gains: gains.toString(), losses: losses.toString(), net: net.toString(),
      currentLoss: currentLoss.toString(), lossesUsed: lossesUsed.toString(), taxable: taxable.toString(),
      tax: taxable.mul(String(rate)).div('100').toFixed(2),
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
  const getHolding = asset => {
    if (!portfolios.has(asset)) portfolios.set(asset, { asset, quantity: ZERO, cost: ZERO, fiscalCost: ZERO, lots: [] });
    return portfolios.get(asset);
  };
  for (const initial of data.initialLots) {
    const holding = getHolding(initial.asset);
    const quantity = Decimal.from(initial.quantity);
    const unitCost = Decimal.from(initial.unitCost);
    const cost = quantity.mul(unitCost);
    holding.quantity = holding.quantity.add(quantity);
    holding.cost = holding.cost.add(cost);
    holding.fiscalCost = holding.fiscalCost.add(cost);
    holding.lots.push({ id: initial.id, acquiredOn: initial.acquiredOn, order: initial.order, quantity, unitCost, initial: true });
  }
  const calculatedRows = [];
  for (const transaction of [...data.transactions].sort(chronological)) {
    const holding = getHolding(transaction.asset);
    const quantity = Decimal.from(transaction.quantity);
    const price = Decimal.from(transaction.unitPrice);
    const fees = Decimal.from(transaction.fees);
    const beforeQuantity = holding.quantity;
    const beforeAverage = average(holding.cost, holding.quantity);
    const fiscalBeforeAverage = average(holding.fiscalCost, holding.quantity);
    const lotDetails = [];
    let proceeds = null;
    let costBasis;
    let fiscalResult = null;
    let managementResult = null;
    if (transaction.type === 'acquisto') {
      costBasis = quantity.mul(price).add(fees);
      holding.quantity = holding.quantity.add(quantity);
      holding.cost = holding.cost.add(costBasis);
      holding.fiscalCost = holding.fiscalCost.add(costBasis);
      holding.lots.push({ id: transaction.id, acquiredOn: transaction.date, order: transaction.order, quantity, unitCost: costBasis.div(quantity), initial: false });
    } else {
      proceeds = quantity.mul(price).sub(fees);
      let remaining = quantity;
      costBasis = ZERO;
      // Opening holdings precede all transactions, including purchases on the opening day.
      holding.lots.sort((left, right) => right.acquiredOn.localeCompare(left.acquiredOn)
        || Number(left.initial) - Number(right.initial) || right.order - left.order);
      for (const lot of holding.lots) {
        if (remaining.cmp(ZERO) === 0) break;
        const used = lot.quantity.min(remaining);
        if (used.cmp(ZERO) === 0) continue;
        const cost = used.mul(lot.unitCost);
        costBasis = costBasis.add(cost);
        lotDetails.push({ lotId: lot.id, acquiredOn: lot.acquiredOn, order: lot.order, quantity: used.toString(), unitCost: lot.unitCost.toString(), cost: cost.toString() });
        lot.quantity = lot.quantity.sub(used);
        remaining = remaining.sub(used);
      }
      holding.lots = holding.lots.filter(lot => lot.quantity.cmp(ZERO) > 0);
      holding.fiscalCost = holding.fiscalCost.sub(costBasis);
      const managementCost = beforeAverage.mul(quantity);
      fiscalResult = proceeds.sub(costBasis);
      managementResult = proceeds.sub(managementCost);
      holding.quantity = holding.quantity.sub(quantity);
      holding.cost = holding.quantity.cmp(ZERO) === 0 ? ZERO : holding.cost.sub(managementCost);
    }
    calculatedRows.push({
      id: transaction.id, date: transaction.date, asset: transaction.asset, type: transaction.type, order: transaction.order,
      quantity: quantity.toString(), unitPrice: price.toString(), fees: fees.toString(),
      beforeQuantity: beforeQuantity.toString(), beforeAverage: beforeAverage.toString(),
      afterQuantity: holding.quantity.toString(), afterAverage: average(holding.cost, holding.quantity).toString(),
      fiscalBeforeAverage: fiscalBeforeAverage.toString(), fiscalAfterAverage: average(holding.fiscalCost, holding.quantity).toString(),
      proceeds: proceeds?.toString() ?? null, costBasis: costBasis.toString(),
      fiscalResult: fiscalResult?.toString() ?? null, managementResult: managementResult?.toString() ?? null,
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
  if (!data.openingDate.endsWith('-01-01')) warnings.push('Il riepilogo annuale comprende solo le operazioni dalla data di apertura: per l’imposta annuale occorre includere tutte le operazioni dell’anno.');
  if (tax.expiredLosses.length) warnings.push('Le minusvalenze pregresse scadute sono escluse dalla compensazione.');
  return { rows, holdings, tax, warnings };
}
