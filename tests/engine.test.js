import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../dist/decimal.js';
import { calculate, validateDataset, ValidationError } from '../dist/engine.js';

const dataset = overrides => ({ version: 1, openingDate: '2025-01-01', initialLots: [], transactions: [], carryLosses: [], ...overrides });
const buy = (id, overrides) => ({ id, date: '2025-02-01', order: 1, type: 'acquisto', asset: 'BTC', quantity: '1', unitPrice: '100', fees: '0', ...overrides });
const sell = (id, overrides) => buy(id, { type: 'vendita', ...overrides });
const lot = (id, overrides) => ({ id, asset: 'BTC', acquiredOn: '2024-01-01', order: 1, quantity: '1', unitCost: '10', ...overrides });

test('decimal arithmetic preserves fractions and rounds only formatting', () => {
  assert.equal(Decimal.from('0.1').add('0.2').toString(), '0.3');
  assert.equal(Decimal.from('1').div('3').mul('3').toString(), '1');
  assert.equal(Decimal.from('1').div('3').toString(), '0.333333333333333333');
  assert.equal(Decimal.from('1.005').toFixed(2), '1.01');
  assert.equal(Decimal.from('-1.005').toFixed(2), '-1.01');
  assert.equal(Decimal.from('-0.004').toFixed(2), '0.00');
  assert.equal(Decimal.from('0.000000000000000001').toString(), '0.000000000000000001');
  assert.equal(Decimal.from('12345678901234567890.12').add('0.01').toString(), '12345678901234567890.13');
  assert.equal(Decimal.min('3', '2').toString(), '2');
  assert.equal(Decimal.from('-3').max('-2').toString(), '-2');
  assert.throws(() => Decimal.from(0.1), TypeError);
  assert.throws(() => Decimal.from('1e3'), TypeError);
  assert.throws(() => Decimal.from('1').div('0'), RangeError);
});

test('a partial LIFO sale consumes recent lots and leaves the management average unchanged', () => {
  const input = dataset({
    initialLots: [lot('opening', { quantity: '2' })],
    transactions: [buy('buy', { quantity: '2', unitPrice: '30', fees: '2' }), sell('sell', { date: '2025-02-02', quantity: '3', unitPrice: '50', fees: '3' })],
  });
  const result = calculate(input, 2025);
  const row = result.rows[1];
  assert.deepEqual({ quantity: row.beforeQuantity, average: row.beforeAverage }, { quantity: '4', average: '20.5' });
  assert.deepEqual({ quantity: row.afterQuantity, average: row.afterAverage }, { quantity: '1', average: '20.5' });
  assert.equal(row.proceeds, '150');
  assert.equal(row.managementProceeds, '147');
  assert.equal(row.costBasis, '70');
  assert.equal(row.fiscalResult, '80');
  assert.equal(row.managementResult, '85.5');
  assert.deepEqual(row.lotDetails.map(value => [value.lotId, value.quantity, value.cost]), [['buy', '2', '60'], ['opening', '1', '10']]);
  assert.equal(row.fiscalAfterAverage, '10');
  assert.deepEqual(result.holdings[0], { asset: 'BTC', quantity: '1', average: '20.5', cost: '20.5', fiscalCost: '10', fiscalAverage: '10' });
  assert.equal(result.tax.tax, '20.80');
  assert.equal(result.rows[0].fiscalResult, null);
  assert.equal(result.rows[0].costBasis, '60');
  assert.equal(result.rows[0].managementCostBasis, '62');
});

test('LIFO uses historical acquisition dates and same-day acquisition order', () => {
  const input = dataset({
    initialLots: [lot('newer', { acquiredOn: '2024-02-01', order: 2, unitCost: '20' }), lot('older', { acquiredOn: '2024-02-01', order: 1 })],
    transactions: [sell('sale', { quantity: '1.5', unitPrice: '30' })],
  });
  const row = calculate(input, 2025).rows[0];
  assert.equal(row.costBasis, '25');
  assert.equal(row.fiscalResult, '20');
  assert.deepEqual(row.lotDetails.map(value => value.lotId), ['newer', 'older']);
  assert.equal(row.afterAverage, '15');
  assert.equal(row.fiscalAfterAverage, '10');
});

test('input rows sort by date and explicit same-day order across assets', () => {
  const input = dataset({ transactions: [
    sell('sell-btc', { date: '2025-03-01', order: 3, quantity: '0.1', unitPrice: '30' }),
    buy('buy-eth', { date: '2025-03-01', order: 2, asset: 'ETH', quantity: '2', unitPrice: '8' }),
    buy('buy-btc', { date: '2025-03-01', order: 1, quantity: '0.2', unitPrice: '10' }),
  ] });
  const result = calculate(input, 2025);
  assert.deepEqual(result.rows.map(row => row.id), ['buy-btc', 'buy-eth', 'sell-btc']);
  assert.equal(result.holdings.find(value => value.asset === 'BTC').quantity, '0.1');
  assert.equal(result.holdings.find(value => value.asset === 'ETH').quantity, '2');
  assert.equal(result.rows[2].fiscalResult, '2');
  assert.equal(result.rows[2].beforeQuantity, '0.2');
});

test('complete liquidation resets costs exactly and tax sums exact repeating fractions', () => {
  const input = dataset({ version: 2, transactions: [
    buy('buy', { quantity: '3', unitPrice: '0', totalEur: '1', fees: '1' }),
    sell('sell-1', { order: 2, unitPrice: '1' }),
    sell('sell-2', { order: 3, unitPrice: '1' }),
    sell('sell-3', { order: 4, unitPrice: '1' }),
  ] });
  const result = calculate(input, 2025);
  assert.equal(result.rows[1].costBasis, '0.333333333333333333');
  assert.equal(result.rows[1].fiscalResult, '0.666666666666666667');
  assert.equal(result.tax.gains, '2');
  assert.equal(result.tax.tax, '0.52');
  assert.deepEqual(result.holdings[0], { asset: 'BTC', quantity: '0', average: '0', cost: '0', fiscalCost: '0', fiscalAverage: '0' });
});

test('cash fees affect management results but are not deductible fiscal costs', () => {
  const result = calculate(dataset({ initialLots: [lot('opening', { unitCost: '0' })], transactions: [sell('sale', { unitPrice: '1', fees: '2' })] }), 2025);
  assert.equal(result.rows[0].proceeds, '1');
  assert.equal(result.rows[0].managementProceeds, '-1');
  assert.equal(result.rows[0].managementResult, '-1');
  assert.equal(result.tax.gains, '1');
  assert.equal(result.tax.losses, '0');
  assert.equal(result.tax.currentLoss, '0');
  assert.equal(result.tax.tax, '0.26');
  assert.deepEqual(result.tax.remainingLosses, []);
});

test('annual tax consumes oldest eligible losses and carries the residual across years', () => {
  const input = dataset({
    carryLosses: [{ id: 'loss-2021', year: 2021, amount: '10' }, { id: 'loss-2024', year: 2024, amount: '200' }],
    initialLots: [lot('opening', { quantity: '2', unitCost: '0' })],
    transactions: [sell('sale-2025', { unitPrice: '100' }), sell('sale-2026', { date: '2026-02-01', unitPrice: '150' })],
  });
  const year2025 = calculate(input, 2025);
  assert.equal(year2025.tax.rate, 26);
  assert.equal(year2025.tax.gains, '100');
  assert.equal(year2025.tax.lossesUsed, '100');
  assert.equal(year2025.tax.tax, '0.00');
  assert.deepEqual(year2025.tax.remainingLosses, [{ originYear: 2024, expiresYear: 2028, amount: '110', displayAmount: '110.00' }]);
  const year2026 = calculate(input, 2026);
  assert.equal(year2026.tax.rate, 33);
  assert.equal(year2026.tax.gains, '150');
  assert.equal(year2026.tax.lossesUsed, '110');
  assert.equal(year2026.tax.taxable, '40');
  assert.equal(year2026.tax.tax, '13.20');
  assert.deepEqual(year2026.tax.remainingLosses, []);
  assert.equal(year2025.holdings[0].quantity, '0');
});

test('a loss incurred in 2025 offsets a gain in 2026', () => {
  const input = dataset({ transactions: [
    buy('purchase-2025', { unitPrice: '100' }), sell('sale-2025', { order: 2, unitPrice: '0' }),
    buy('purchase-2026', { date: '2026-02-01', unitPrice: '0' }), sell('sale-2026', { date: '2026-02-01', order: 2, unitPrice: '150' }),
  ] });
  assert.deepEqual(calculate(input, 2025).tax.remainingLosses, [{ originYear: 2025, expiresYear: 2029, amount: '100', displayAmount: '100.00' }]);
  const tax = calculate(input, 2026).tax;
  assert.equal(tax.lossesUsed, '100');
  assert.equal(tax.taxable, '50');
  assert.equal(tax.tax, '16.50');
});

test('expired carry losses are reported and four-year eligibility includes the expiry year', () => {
  const input = dataset({
    openingDate: '2026-01-01',
    initialLots: [lot('opening', { unitCost: '0' })],
    transactions: [sell('sale', { date: '2026-01-01', unitPrice: '100' })],
    carryLosses: [{ id: 'expired', year: 2021, amount: '25' }, { id: 'eligible', year: 2022, amount: '10' }],
  });
  const result = calculate(input, 2026);
  assert.equal(result.tax.lossesUsed, '10');
  assert.equal(result.tax.taxable, '90');
  assert.equal(result.tax.tax, '29.70');
  assert.deepEqual(result.tax.expiredLosses, [{ originYear: 2021, expiresYear: 2025, amount: '25', displayAmount: '25.00' }]);
  assert.equal(result.warnings.length, 1);
  assert.throws(() => calculate(input, 2025), ValidationError);
});

test('same-year losses reduce gains before the use of previously declared losses', () => {
  const input = dataset({
    initialLots: [lot('opening', { quantity: '2', unitCost: '50' })],
    transactions: [sell('profit', { unitPrice: '150' }), sell('loss', { date: '2025-02-02', unitPrice: '0' })],
    carryLosses: [{ id: 'previous', year: 2024, amount: '75' }],
  });
  const tax = calculate(input, 2025).tax;
  assert.equal(tax.gains, '100');
  assert.equal(tax.losses, '50');
  assert.equal(tax.net, '50');
  assert.equal(tax.lossesUsed, '50');
  assert.deepEqual(tax.remainingLosses, [{ originYear: 2024, expiresYear: 2028, amount: '25', displayAmount: '25.00' }]);
});

test('carry loss residuals below historical thresholds remain valid', () => {
  assert.deepEqual(validateDataset(dataset({ carryLosses: [{ id: 'residual', year: 2024, amount: '0.01' }] })), []);
});

test('a small positive gain is taxable without a threshold', () => {
  const result = calculate(dataset({ initialLots: [lot('opening', { unitCost: '0' })], transactions: [sell('sale', { unitPrice: '1' })] }), 2025);
  assert.equal(result.tax.taxable, '1');
  assert.equal(result.tax.tax, '0.26');
});

test('validation rejects overselling, noncanonical assets, ambiguous order and identifiers', () => {
  const input = dataset({
    initialLots: [lot('duplicate')],
    transactions: [sell('duplicate', { quantity: '2' }), buy('later', { date: '2025-02-02' }), buy('ambiguous', { date: '2025-02-02', asset: 'btc' })],
  });
  const errors = validateDataset(input);
  assert.ok(errors.some(error => error.location === 'transactions[0].id'));
  assert.ok(errors.some(error => error.location === 'transactions[0].quantity'));
  assert.ok(errors.some(error => error.location === 'transactions[2].asset'));
  assert.ok(errors.some(error => error.location === 'transactions[2].order'));
  assert.throws(() => calculate(input, 2025), error => error instanceof ValidationError && error.errors.length === errors.length);
});

test('validation rejects invalid dates, numeric formats, precision and loss origin years', () => {
  const input = dataset({
    initialLots: [lot('future', { acquiredOn: '2025-02-01', quantity: '0', unitCost: '-1' })],
    transactions: [buy('bad-date', { date: '2025-02-30', quantity: '0.0000000000000000001', unitPrice: '1,2', fees: 0 })],
    carryLosses: [{ id: 'future-loss', year: 2025, amount: '-2' }],
  });
  const locations = validateDataset(input).map(error => error.location);
  for (const location of ['initialLots[0].acquiredOn', 'initialLots[0].quantity', 'initialLots[0].unitCost', 'transactions[0].date', 'transactions[0].quantity', 'transactions[0].unitPrice', 'transactions[0].fees', 'carryLosses[0].year', 'carryLosses[0].amount']) {
    assert.ok(locations.includes(location), location);
  }
  assert.ok(validateDataset(dataset({ openingDate: '2024-12-31' })).some(error => error.location === 'openingDate'));
  assert.ok(validateDataset(dataset({ transactions: [buy('before', { date: '2024-12-31' })] })).some(error => error.location === 'transactions[0].date'));
});

test('validation checks duplicate opening acquisition order and duplicated loss years', () => {
  const input = dataset({ initialLots: [lot('a'), lot('b')], carryLosses: [{ id: 'c', year: 2024, amount: '1' }, { id: 'd', year: 2024, amount: '2' }] });
  assert.ok(validateDataset(input).some(error => error.location === 'initialLots[1].order'));
  assert.ok(validateDataset(input).some(error => error.location === 'carryLosses[1].year'));
});

test('all validated identifiers can be safely exported to CSV', () => {
  for (const id of ['x'.repeat(65), 'a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u009fb', '=SUM(A1)', '+1', '-1', '@BTC', '  =SUM(A1)', '\uFEFF@BTC']) {
    const inputs = [
      dataset({ initialLots: [lot(id)] }),
      dataset({ transactions: [buy(id)] }),
      dataset({ carryLosses: [{ id, year: 2024, amount: '1' }] }),
    ];
    for (const input of inputs) {
      assert.ok(validateDataset(input).some(error => error.location.endsWith('.id')), JSON.stringify(id));
      assert.throws(() => calculate(input, 2025), ValidationError);
    }
  }
  assert.deepEqual(validateDataset(dataset({ transactions: [buy('x'.repeat(64))] })), []);
});

test('invalid dataset shapes and row count fail with actionable validation errors', () => {
  assert.equal(validateDataset(null)[0].location, 'dataset');
  assert.ok(validateDataset({ version: 3 }).some(error => error.location === 'version'));
  assert.ok(validateDataset(dataset({ transactions: [null] })).some(error => error.location === 'transactions[0]'));
  assert.ok(validateDataset(dataset({ transactions: new Array(5001).fill(null) })).some(error => error.location === 'dataset'));
});

test('an incomplete-year snapshot warns and calculations do not mutate the dataset', () => {
  const input = dataset({ openingDate: '2025-06-01', initialLots: [lot('opening')], transactions: [sell('sale', { date: '2025-07-01' })] });
  const original = JSON.stringify(input);
  const result = calculate(input, 2025);
  assert.ok(result.warnings[0].includes('data di apertura'));
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(calculate(dataset(), 2025).tax, { year: 2025, rate: 26, gains: '0', capitalGains: '0', income: '0', losses: '0', net: '0', currentLoss: '0', lossesUsed: '0', taxable: '0', tax: '0.00', display: { gains: '0.00', capitalGains: '0.00', income: '0.00', losses: '0.00', net: '0.00', lossesUsed: '0.00', taxable: '0.00' }, remainingLosses: [], expiredLosses: [] });
});

test('opening lots precede purchases on the opening day regardless of their separate sequence', () => {
  const input = dataset({
    initialLots: [lot('opening', { acquiredOn: '2025-01-01', order: 10, unitCost: '100' })],
    transactions: [
      buy('purchase', { date: '2025-01-01', order: 1, unitPrice: '200' }),
      sell('sale', { date: '2025-01-01', order: 2, unitPrice: '300' }),
    ],
  });
  const result = calculate(input, 2025);
  assert.equal(result.rows[1].costBasis, '200');
  assert.equal(result.rows[1].fiscalResult, '100');
  assert.deepEqual(result.rows[1].lotDetails.map(value => value.lotId), ['purchase']);
  assert.equal(result.holdings[0].fiscalCost, '100');
  assert.equal(result.tax.tax, '26.00');
});

test('opening-lot sequences and transaction sequences are separate and both retain LIFO order', () => {
  const input = dataset({
    initialLots: [
      lot('older', { acquiredOn: '2025-01-01', order: 0, unitCost: '100' }),
      lot('newer', { acquiredOn: '2025-01-01', order: 1, unitCost: '300' }),
    ],
    transactions: [
      buy('purchase', { date: '2025-01-01', order: 0, unitPrice: '200' }),
      sell('sale', { date: '2025-01-01', order: 1, quantity: '2.5', unitPrice: '400' }),
    ],
  });
  assert.deepEqual(validateDataset(input), []);
  const result = calculate(input, 2025);
  assert.deepEqual(result.rows[1].lotDetails.map(value => [value.lotId, value.quantity]), [
    ['purchase', '1'], ['newer', '1'], ['older', '0.5'],
  ]);
  assert.equal(result.rows[1].costBasis, '550');
  assert.equal(result.rows[1].fiscalResult, '450');
  assert.equal(result.holdings[0].fiscalCost, '50');
});

test('invalid opening dates return validation errors even when the tax year is omitted', () => {
  for (const openingDate of [123, {}, true, null, undefined, [], 'invalid']) {
    assert.throws(() => calculate(dataset({ openingDate })), error => error instanceof ValidationError
      && error.errors.some(value => value.location === 'openingDate'), String(openingDate));
  }
  assert.equal(calculate(dataset()).tax.year, 2025);
  assert.equal(calculate(dataset({ openingDate: '2026-01-01' })).tax.year, 2026);
});

test('historical acquisition dates reject year zero and impossible leap days', () => {
  for (const acquiredOn of ['0000-01-01', '2023-02-29', '1900-02-29']) {
    const input = dataset({ initialLots: [lot('opening', { acquiredOn })] });
    assert.ok(validateDataset(input).some(value => value.location === 'initialLots[0].acquiredOn'), acquiredOn);
    assert.throws(() => calculate(input, 2025), ValidationError);
  }
  assert.deepEqual(validateDataset(dataset({ initialLots: [lot('opening', { acquiredOn: '2024-02-29' })] })), []);
});

test('buying again after full liquidation starts fresh management and fiscal costs', () => {
  const input = dataset({
    initialLots: [lot('opening', { quantity: '2', unitCost: '100' })],
    transactions: [
      buy('purchase', { order: 1, unitPrice: '200' }),
      sell('liquidation', { order: 2, quantity: '3', unitPrice: '150' }),
      buy('repurchase', { order: 3, unitPrice: '50', fees: '1' }),
      sell('partial', { order: 4, quantity: '0.4', unitPrice: '100', fees: '1' }),
    ],
  });
  const result = calculate(input, 2025);
  assert.equal(result.rows[1].afterQuantity, '0');
  assert.equal(result.rows[2].beforeAverage, '0');
  assert.equal(result.rows[3].costBasis, '20');
  assert.equal(result.rows[3].fiscalResult, '20');
  assert.equal(result.rows[3].managementResult, '18.6');
  assert.deepEqual(result.rows[3].lotDetails.map(value => value.lotId), ['repurchase']);
  assert.deepEqual(result.holdings[0], { asset: 'BTC', quantity: '0.6', average: '51', cost: '30.6', fiscalCost: '30', fiscalAverage: '50' });
  assert.equal(result.tax.tax, '18.20');
});

test('same-category crypto gains and losses offset across different assets', () => {
  const result = calculate(dataset({
    initialLots: [lot('btc', { unitCost: '100' }), lot('eth', { asset: 'ETH', unitCost: '500' })],
    transactions: [sell('gain', { order: 1, unitPrice: '400' }), sell('loss', { order: 2, asset: 'ETH', unitPrice: '100' })],
    carryLosses: [{ id: 'previous', year: 2024, amount: '50' }],
  }), 2025);
  assert.equal(result.tax.gains, '300');
  assert.equal(result.tax.losses, '400');
  assert.equal(result.tax.net, '-100');
  assert.equal(result.tax.lossesUsed, '0');
  assert.equal(result.tax.tax, '0.00');
  assert.deepEqual(result.tax.remainingLosses, [
    { originYear: 2024, expiresYear: 2028, amount: '50', displayAmount: '50.00' },
    { originYear: 2025, expiresYear: 2029, amount: '100', displayAmount: '100.00' },
  ]);
});

test('retained fiscal cost excludes commissions and conserves the gross purchase basis', () => {
  const input = dataset({
    initialLots: [lot('opening', { quantity: '2', unitCost: '10' })],
    transactions: [
      buy('first-buy', { order: 1, quantity: '3', unitPrice: '20', fees: '1' }),
      sell('first-sale', { order: 2, quantity: '1', unitPrice: '30', fees: '0.2' }),
      buy('second-buy', { order: 3, quantity: '2', unitPrice: '40', fees: '0.5' }),
      sell('second-sale', { order: 4, quantity: '2.5', unitPrice: '60', fees: '1' }),
      buy('other-asset', { order: 5, asset: 'ETH', quantity: '1', unitPrice: '10', fees: '1' }),
    ],
  });
  const result = calculate(input, 2025);
  const btc = result.holdings.find(value => value.asset === 'BTC');
  // Fiscal purchase basis excludes all commissions: 20 + 60 + 80.
  // The remaining 2 initial units at 10 and 1.5 bought at 20 have basis 50.
  assert.equal(btc.fiscalCost, '50');
  assert.equal(btc.fiscalAverage, Decimal.from('50').div('3.5').toString());
  assert.equal(result.rows[1].fiscalAfterAverage, Decimal.from('60').div('4').toString());
  assert.equal(result.rows[2].fiscalAfterAverage, Decimal.from('140').div('6').toString());
  assert.equal(result.holdings.find(value => value.asset === 'ETH').fiscalCost, '10');
  input.transactions.push(sell('liquidation', { order: 6, quantity: '3.5', unitPrice: '100', fees: '0.3' }));
  const liquidated = calculate(input, 2025);
  assert.equal(liquidated.rows.at(-1).costBasis, '50');
  assert.equal(liquidated.holdings.find(value => value.asset === 'BTC').fiscalCost, '0');
  assert.equal(liquidated.holdings.find(value => value.asset === 'ETH').fiscalCost, '10');
});

test('display metadata preserves signs below serialized precision and remains JSON-safe', () => {
  const result = calculate(dataset({
    initialLots: [
      lot('btc', { quantity: '0.000000000000000001', unitCost: '1' }),
      lot('eth', { asset: 'ETH', quantity: '0.000000000000000001', unitCost: '1' }),
    ],
    transactions: [
      sell('gain', { quantity: '0.000000000000000001', unitPrice: '1.000000000000000001' }),
      sell('loss', { order: 2, asset: 'ETH', quantity: '0.000000000000000001', unitPrice: '0.999999999999999999' }),
      buy('purchase', { order: 3, asset: 'SOL', unitPrice: '1' }),
    ],
  }), 2025);
  assert.equal(result.rows[0].fiscalResult, '0');
  assert.equal(result.rows[1].fiscalResult, '0');
  assert.deepEqual(result.rows[0].display, { proceeds: '0.00', costBasis: '0.00', fiscalResult: '0.00', fiscalSign: 1 });
  assert.deepEqual(result.rows[1].display, { proceeds: '0.00', costBasis: '0.00', fiscalResult: '0.00', fiscalSign: -1 });
  assert.deepEqual(result.rows[2].display, { proceeds: null, costBasis: '1.00', fiscalResult: null, fiscalSign: null });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('display metadata rounds fractional LIFO and tax amounts directly from exact values', () => {
  const result = calculate(dataset({ version: 2, transactions: [
    buy('purchase', { quantity: '3', unitPrice: '100', totalEur: '300.014999999999999999', fees: '0' }),
    sell('sale', { order: 2, unitPrice: '100' }),
  ] }), 2025);
  // The unit cost is 100 + 0.014999999999999999 / 3: just below 100.005.
  assert.equal(result.rows[1].costBasis, '100.005');
  assert.equal(result.rows[1].fiscalResult, '-0.005');
  assert.deepEqual(result.rows[1].display, { proceeds: '100.00', costBasis: '100.00', fiscalResult: '0.00', fiscalSign: -1 });
  assert.deepEqual(result.tax.display, { gains: '0.00', capitalGains: '0.00', income: '0.00', losses: '0.00', net: '0.00', lossesUsed: '0.00', taxable: '0.00' });
  assert.deepEqual(result.tax.remainingLosses, [{ originYear: 2025, expiresYear: 2029, amount: '0.005', displayAmount: '0.00' }]);
});

test('carry-loss display rounds the exact residue both before and after expiry', () => {
  const input = dataset({
    version: 2, carryLosses: [{ id: 'carry', year: 2021, amount: '0.01' }],
    transactions: [
      buy('purchase', { quantity: '3', unitPrice: '100', totalEur: '300.014999999999999999', fees: '0' }),
      sell('sale', { order: 2, unitPrice: '100.01' }),
    ],
  });
  const current = calculate(input, 2025);
  assert.deepEqual(current.tax.display, { gains: '0.01', capitalGains: '0.01', income: '0.00', losses: '0.00', net: '0.01', lossesUsed: '0.01', taxable: '0.00' });
  const remaining = [{ originYear: 2021, expiresYear: 2025, amount: '0.005', displayAmount: '0.00' }];
  assert.deepEqual(current.tax.remainingLosses, remaining);
  assert.deepEqual(calculate(input, 2026).tax.expiredLosses, remaining);
});

const v2 = overrides => dataset({ version: 2, ...overrides });
const neutral = (id, overrides) => buy(id, { type: 'permuta_neutrale', unitPrice: '0',
  receivedAsset: 'ETH', receivedQuantity: '2', lotDatePolicy: 'historical', ...overrides });
const income = (id, overrides) => buy(id, { type: 'provento', unitPrice: '0', totalEur: '20', rewardCostEur: '20', ...overrides });

test('v2 exact gross totals take priority over rounded unit prices and exclude fees fiscally', () => {
  const result = calculate(v2({ transactions: [
    buy('three', { quantity: '3', unitPrice: '33.333333333333333333', totalEur: '100', fees: '2' }),
    sell('one', { order: 2, unitPrice: '33.333333333333333333', totalEur: '100', fees: '1' }),
  ] }), 2025);
  assert.equal(result.rows[0].costBasis, '100');
  assert.equal(result.rows[0].managementCostBasis, '102');
  assert.equal(result.rows[1].costBasis, Decimal.from('100').div('3').toString());
  assert.equal(result.rows[1].proceeds, '100');
  assert.equal(result.rows[1].fiscalResult, Decimal.from('200').div('3').toString());
  assert.equal(result.rows[1].managementProceeds, '99');
  assert.equal(result.rows[1].managementCostBasis, '34');
  assert.equal(result.rows[1].managementResult, '65');
  assert.equal(result.tax.tax, '17.33');
});

test('a neutral exchange transfers historical LIFO costs without realizing income', () => {
  const result = calculate(v2({
    initialLots: [lot('old', { quantity: '2', unitCost: '10' })],
    transactions: [
      buy('recent', { quantity: '2', unitPrice: '30', fees: '2' }),
      neutral('swap', { date: '2025-02-02', quantity: '3', receivedQuantity: '9' }),
      sell('eth-sale', { date: '2025-02-03', asset: 'ETH', quantity: '9', unitPrice: '20' }),
    ],
  }), 2025);
  const swap = result.rows[1];
  assert.equal(swap.fiscalKind, 'neutral');
  assert.equal(swap.costBasis, '70');
  assert.equal(swap.managementCostBasis, '61.5');
  assert.equal(swap.fiscalResult, null);
  assert.equal(swap.beforeQuantity, '4');
  assert.equal(swap.afterQuantity, '1');
  assert.equal(swap.receivedBeforeQuantity, '0');
  assert.equal(swap.receivedAfterQuantity, '9');
  assert.equal(result.rows[2].costBasis, '70');
  assert.equal(result.rows[2].managementCostBasis, '61.5');
  assert.equal(result.rows[2].fiscalResult, '110');
  assert.equal(result.tax.gains, '110');
  assert.equal(result.tax.tax, '28.60');
  assert.deepEqual(result.rows[2].lotDetails.map(item => [item.acquiredOn, item.quantity, item.provenance.originLotId]), [
    ['2025-02-01', '6', 'recent'], ['2024-01-01', '3', 'old'],
  ]);
  const btc = result.holdings.find(item => item.asset === 'BTC');
  assert.equal(btc.fiscalCost, '10');
  assert.equal(btc.cost, '20.5');
});

test('an explicit neutral-exchange date policy determines subsequent LIFO acquisition order', () => {
  const make = lotDatePolicy => v2({ initialLots: [
    lot('old-btc', { unitCost: '100' }),
    lot('new-eth', { asset: 'ETH', acquiredOn: '2024-12-01', unitCost: '10' }),
  ], transactions: [
    neutral('swap', { receivedQuantity: '1', lotDatePolicy }),
    sell('sale', { order: 2, asset: 'ETH', unitPrice: '200' }),
  ] });
  const historical = calculate(make('historical'), 2025);
  const exchangeDate = calculate(make('exchange'), 2025);
  assert.equal(historical.rows[1].costBasis, '10');
  assert.equal(exchangeDate.rows[1].costBasis, '100');
  assert.equal(historical.holdings.find(item => item.asset === 'ETH').fiscalCost, '100');
  assert.equal(exchangeDate.holdings.find(item => item.asset === 'ETH').fiscalCost, '10');
});

test('neutral transfers preserve exact rational quantities and costs across several exchanges', () => {
  const input = v2({ initialLots: [lot('one', { unitCost: '10' }), lot('two', { order: 2, unitCost: '20' }), lot('three', { order: 3, unitCost: '30' })],
    transactions: [
      neutral('first', { quantity: '3', receivedQuantity: '1' }),
      neutral('second', { order: 2, asset: 'ETH', receivedAsset: 'SOL', receivedQuantity: '7' }),
      sell('sol-sale', { order: 3, asset: 'SOL', quantity: '7', unitPrice: '10' }),
    ] });
  const result = calculate(input, 2025);
  assert.equal(result.rows[0].costBasis, '60');
  assert.equal(result.rows[1].costBasis, '60');
  assert.equal(result.rows[2].costBasis, '60');
  assert.equal(result.rows[2].fiscalResult, '10');
  assert.equal(result.tax.tax, '2.60');
  assert.ok(result.holdings.every(item => item.quantity === '0' && item.cost === '0' && item.fiscalCost === '0'));
  assert.equal(new Set(result.rows[2].lotDetails.map(item => item.lotSequence)).size, 3);
  assert.deepEqual(new Set(result.rows[2].lotDetails.map(item => item.provenance.originLotId)), new Set(['one', 'two', 'three']));
});

test('a taxable exchange uses the normal value of received assets and establishes their fiscal basis', () => {
  const result = calculate(v2({ initialLots: [lot('btc', { unitCost: '60' })], transactions: [
    neutral('nft', { type: 'permuta_imponibile', lotDatePolicy: undefined, receivedAsset: 'NFT', receivedQuantity: '2', totalEur: '100' }),
    sell('nft-sale', { order: 2, asset: 'NFT', quantity: '1', unitPrice: '70' }),
  ].map(({ lotDatePolicy, ...transaction }) => transaction) }), 2025);
  assert.equal(result.rows[0].fiscalKind, 'capital_gain');
  assert.equal(result.rows[0].proceeds, '100');
  assert.equal(result.rows[0].costBasis, '60');
  assert.equal(result.rows[0].fiscalResult, '40');
  assert.equal(result.rows[0].receivedAfterQuantity, '2');
  assert.equal(result.rows[1].costBasis, '50');
  assert.equal(result.rows[1].fiscalResult, '20');
  assert.equal(result.tax.capitalGains, '60');
  assert.equal(result.tax.income, '0');
  assert.equal(result.tax.tax, '15.60');
  assert.equal(result.holdings.find(item => item.asset === 'NFT').fiscalCost, '50');
});

test('holding rewards create gross taxable income immediately and require a documented later basis', () => {
  const result = calculate(v2({ transactions: [
    income('reward', { quantity: '2', totalEur: '100', rewardCostEur: '80' }),
    sell('sale', { order: 2, quantity: '1', unitPrice: '70' }),
  ] }), 2025);
  assert.equal(result.rows[0].fiscalKind, 'income');
  assert.equal(result.rows[0].proceeds, '100');
  assert.equal(result.rows[0].costBasis, '80');
  assert.equal(result.rows[0].fiscalResult, '100');
  assert.equal(result.rows[1].costBasis, '40');
  assert.equal(result.rows[1].fiscalResult, '30');
  assert.equal(result.rows[1].managementCostBasis, '50');
  assert.equal(result.tax.income, '100');
  assert.equal(result.tax.capitalGains, '30');
  assert.equal(result.tax.gains, '130');
  assert.equal(result.tax.tax, '33.80');
  assert.equal(result.holdings[0].fiscalCost, '40');
  assert.equal(result.holdings[0].cost, '50');
});

test('documented zero reward basis is explicit and same-category losses offset gross holding income', () => {
  const input = v2({ initialLots: [lot('opening', { asset: 'ETH', unitCost: '50' })], transactions: [
    income('reward', { rewardCostEur: '0' }),
    sell('loss', { order: 2, asset: 'ETH', unitPrice: '10' }),
  ] });
  const result = calculate(input, 2025);
  assert.equal(result.holdings.find(item => item.asset === 'BTC').fiscalCost, '0');
  assert.equal(result.tax.income, '20');
  assert.equal(result.tax.capitalGains, '0');
  assert.equal(result.tax.losses, '40');
  assert.equal(result.tax.net, '-20');
  assert.equal(result.tax.tax, '0.00');
  assert.deepEqual(result.tax.remainingLosses, [{ originYear: 2025, expiresYear: 2029, amount: '20', displayAmount: '20.00' }]);
  const { rewardCostEur, ...undocumented } = income('undocumented');
  assert.ok(validateDataset(v2({ transactions: [undocumented] })).some(error => error.location === 'transactions[0].rewardCostEur'));
});

test('fiat deposits remain informational and do not create holdings or taxable income', () => {
  const result = calculate(v2({ transactions: [buy('deposit', { type: 'deposito_eur', asset: 'EUR', quantity: '100', unitPrice: '1' })] }), 2025);
  assert.deepEqual(result.holdings, []);
  const row = result.rows[0];
  assert.equal(row.fiscalKind, 'fiat');
  assert.equal(row.beforeQuantity, '0');
  assert.equal(row.afterQuantity, '0');
  assert.equal(row.costBasis, '0');
  assert.equal(row.fiscalResult, null);
  assert.equal(result.tax.taxable, '0');
});

test('v2 validation checks both exchange balances chronologically and rejects overspending received assets', () => {
  const input = v2({ initialLots: [lot('opening')], transactions: [
    neutral('swap'),
    sell('sale', { order: 2, asset: 'ETH', quantity: '2' }),
  ] });
  assert.deepEqual(validateDataset(input), []);
  input.transactions[1].quantity = '2.000000000000000001';
  assert.ok(validateDataset(input).some(error => error.location === 'transactions[1].quantity'));
  input.transactions[1].quantity = '1';
  input.transactions[1].order = 0;
  assert.ok(validateDataset(input).some(error => error.location === 'transactions[1].quantity'));
  input.transactions[1].order = 1;
  assert.ok(validateDataset(input).some(error => error.location === 'transactions[1].order'));
});

test('extended fields require format 2 and are rejected when absent, malformed, or inappropriate', () => {
  for (const transaction of [buy('total', { totalEur: '100' }), neutral('swap'), income('reward')]) {
    assert.ok(validateDataset(dataset({ transactions: [transaction] })).length > 0);
  }
  const cases = [
    [neutral('same', { receivedAsset: 'BTC' }), 'receivedAsset'],
    [neutral('missing-date', { lotDatePolicy: undefined }), 'lotDatePolicy'],
    [neutral('negative', { receivedQuantity: '-1' }), 'receivedQuantity'],
    [neutral('precision', { receivedQuantity: '0.0000000000000000001' }), 'receivedQuantity'],
    [neutral('not-zero', { fees: '1' }), 'fees'],
    [neutral('mispriced', { unitPrice: '1' }), 'unitPrice'],
    [neutral('unused-value', { totalEur: '100' }), 'totalEur'],
    [buy('bad-total', { totalEur: '1e2' }), 'totalEur'],
    [buy('number-total', { totalEur: 100 }), 'totalEur'],
    [buy('large-total', { totalEur: '1'.repeat(31) }), 'totalEur'],
    [income('bad-cost', { rewardCostEur: null }), 'rewardCostEur'],
    [buy('unused-cost', { rewardCostEur: '0' }), 'rewardCostEur'],
    [buy('unused-received', { receivedAsset: 'ETH' }), 'receivedAsset'],
    [buy('unused-policy', { lotDatePolicy: 'historical' }), 'lotDatePolicy'],
    [buy('bad-deposit', { type: 'deposito_eur', asset: 'BTC', unitPrice: '1' }), 'asset'],
  ];
  for (const [transaction, field] of cases) {
    const errors = validateDataset(v2({ initialLots: [lot('opening')], transactions: [transaction] }));
    assert.ok(errors.some(error => error.location === 'transactions[0].' + field), transaction.id + ': ' + field);
  }
  const { totalEur, lotDatePolicy, ...missingValue } = neutral('taxable', { type: 'permuta_imponibile' });
  assert.ok(validateDataset(v2({ initialLots: [lot('opening')], transactions: [missingValue] })).some(error => error.location === 'transactions[0].totalEur'));
});

test('extended calculations preserve snapshot, source evidence, and deterministic results', () => {
  const input = v2({ initialLots: [lot('opening')], transactions: [neutral('swap', { source: { row: 12, columns: { sent_amount: '1' } } })] });
  const original = JSON.stringify(input);
  const first = calculate(input, 2025);
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(calculate(input, 2025), first);
  assert.deepEqual(first.rows[0].source, input.transactions[0].source);
  first.rows[0].source.columns.sent_amount = '99';
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(JSON.parse(JSON.stringify(calculate(input, 2025))), calculate(input, 2025));
});

test('calculated rows preserve explicit totals, documented reward basis and lot-date choices for exports', () => {
  for (const lotDatePolicy of ['historical', 'exchange']) {
    const result = calculate(v2({ transactions: [
      buy('purchase', { quantity: '3', totalEur: '100.000000000000000001' }),
      neutral('swap', { order: 2, lotDatePolicy }),
      income('reward', { order: 3, totalEur: '20.000000000000000001', rewardCostEur: '0.00' }),
    ] }), 2025);
    assert.equal(result.rows[0].totalEur, '100.000000000000000001');
    assert.equal(result.rows[1].lotDatePolicy, lotDatePolicy);
    assert.equal(result.rows[2].totalEur, '20.000000000000000001');
    assert.equal(result.rows[2].rewardCostEur, '0.00');
    assert.equal(Object.hasOwn(result.rows[0], 'lotDatePolicy'), false);
    assert.equal(Object.hasOwn(result.rows[1], 'totalEur'), false);
    assert.equal(Object.hasOwn(result.rows[0], 'rewardCostEur'), false);
  }
});

test('calculation preserves an independent opening snapshot even after lots are fully sold', () => {
  const input = dataset({
    initialLots: [lot('sold-opening', { quantity: '2', unitCost: '12.000000000000000001' }),
      lot('untouched-opening', { asset: 'ETH', quantity: '3', unitCost: '4' })],
    transactions: [sell('liquidate', { quantity: '2', unitPrice: '20' })]
  });
  const original = structuredClone(input);
  const result = calculate(input, 2025);
  assert.deepEqual(input, original);
  assert.deepEqual(result.initialLots, original.initialLots);
  assert.equal(result.holdings.find(holding => holding.asset === 'BTC').quantity, '0');
  result.initialLots[0].unitCost = '999';
  assert.equal(input.initialLots[0].unitCost, '12.000000000000000001');
  input.initialLots[1].quantity = '8';
  assert.equal(result.initialLots[1].quantity, '3');
});

test('estimated opening basis stays identifiable in multi-lot LIFO sales and repeated neutral transfers', () => {
  for (const lotDatePolicy of ['historical', 'exchange']) {
    const input = v2({
      initialLots: [lot('estimated-opening', { acquiredOn: '', quantity: '2', unitCost: '10', basisMethod: 'estimated_average' })],
      transactions: [
        buy('documented-purchase', { quantity: '2', unitPrice: '30' }),
        neutral('first-transfer', { date: '2025-02-02', quantity: '3', receivedQuantity: '9', lotDatePolicy }),
        neutral('second-transfer', { date: '2025-02-03', asset: 'ETH', quantity: '9', receivedAsset: 'SOL', receivedQuantity: '18', lotDatePolicy }),
        sell('final-sale', { date: '2025-02-04', asset: 'SOL', quantity: '18', unitPrice: '10' })
      ]
    });
    const result = calculate(input, 2025);
    const first = result.rows[1];
    assert.deepEqual(first.lotDetails.map(piece => [piece.lotId, piece.quantity, piece.cost]),
      [['documented-purchase', '2', '60'], ['estimated-opening', '1', '10']]);
    assert.equal(Object.hasOwn(first.lotDetails[0], 'basisMethod'), false);
    assert.equal(first.lotDetails[1].basisMethod, 'estimated_average');
    for (const row of result.rows.slice(2)) {
      assert.equal(row.costBasis, '70');
      const estimated = row.lotDetails.find(piece => piece.basisMethod === 'estimated_average');
      const documented = row.lotDetails.find(piece => !Object.hasOwn(piece, 'basisMethod'));
      assert.ok(estimated, lotDatePolicy + ': estimated basis must survive every transfer');
      assert.ok(documented, lotDatePolicy + ': documented basis must not acquire an estimate label');
      assert.equal(estimated.provenance.originLotId, 'estimated-opening');
      assert.equal(estimated.provenance.originAcquiredOn, '');
      assert.equal(estimated.cost, '10');
      assert.equal(estimated.display.cost, '10.00');
      assert.equal(documented.cost, '60');
    }
    assert.equal(result.rows[3].fiscalResult, '110');
    assert.deepEqual(result.initialLots, input.initialLots);
  }
});

test('consumed-lot display costs round exact fractional costs once at the half-cent boundary', () => {
  for (const [totalEur, expected] of [['300.014999999999999999', '100.00'], ['300.015', '100.01']]) {
    const result = calculate(v2({ transactions: [
      buy('fractional-purchase', { quantity: '3', unitPrice: '0', totalEur }),
      sell('partial-sale', { order: 2, unitPrice: '100' })
    ] }), 2025);
    const piece = result.rows[1].lotDetails[0];
    // Both values serialize to 100.005 at 18 decimal places, but their exact
    // rationals lie on opposite sides of the rounding boundary.
    assert.equal(piece.cost, '100.005');
    assert.deepEqual(piece.display, { unitCost: '100.005000000000000000', unitCostSign: 1, cost: expected });
    assert.equal(piece.display.cost, result.rows[1].display.costBasis);
  }
});

test('consumed-lot display distinguishes a tiny positive unit cost from a documented zero cost', () => {
  const result = calculate(v2({ transactions: [
    buy('tiny-unit-cost', { quantity: '1000000000000000000', unitPrice: '0', totalEur: '0.000000000000000001' }),
    sell('sell-tiny-cost', { order: 2, quantity: '1000000000000000000', unitPrice: '0', totalEur: '1' }),
    buy('zero-unit-cost', { order: 3, asset: 'ETH', unitPrice: '0' }),
    sell('sell-zero-cost', { order: 4, asset: 'ETH', unitPrice: '1' })
  ] }), 2025);
  const tiny = result.rows[1].lotDetails[0];
  const zero = result.rows[3].lotDetails[0];
  assert.equal(tiny.unitCost, '0');
  assert.equal(tiny.cost, '0.000000000000000001');
  assert.deepEqual(tiny.display, { unitCost: '0.000000000000000000', unitCostSign: 1, cost: '0.00' });
  assert.equal(zero.unitCost, '0');
  assert.deepEqual(zero.display, { unitCost: '0.000000000000000000', unitCostSign: 0, cost: '0.00' });
});
