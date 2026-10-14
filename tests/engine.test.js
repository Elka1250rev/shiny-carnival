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
  assert.equal(row.proceeds, '147');
  assert.equal(row.costBasis, '72');
  assert.equal(row.fiscalResult, '75');
  assert.equal(row.managementResult, '85.5');
  assert.deepEqual(row.lotDetails.map(value => [value.lotId, value.quantity, value.cost]), [['buy', '2', '62'], ['opening', '1', '10']]);
  assert.equal(row.fiscalAfterAverage, '10');
  assert.deepEqual(result.holdings[0], { asset: 'BTC', quantity: '1', average: '20.5', cost: '20.5', fiscalCost: '10', fiscalAverage: '10' });
  assert.equal(result.tax.tax, '19.50');
  assert.equal(result.rows[0].fiscalResult, null);
  assert.equal(result.rows[0].costBasis, '62');
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
  const input = dataset({ transactions: [
    buy('buy', { quantity: '3', unitPrice: '0', fees: '1' }),
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

test('sale cash fees may exceed proceeds and create a deductible loss', () => {
  const result = calculate(dataset({ initialLots: [lot('opening', { unitCost: '0' })], transactions: [sell('sale', { unitPrice: '1', fees: '2' })] }), 2025);
  assert.equal(result.rows[0].proceeds, '-1');
  assert.equal(result.tax.losses, '1');
  assert.equal(result.tax.currentLoss, '1');
  assert.equal(result.tax.tax, '0.00');
  assert.deepEqual(result.tax.remainingLosses, [{ originYear: 2025, expiresYear: 2029, amount: '1' }]);
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
  assert.deepEqual(year2025.tax.remainingLosses, [{ originYear: 2024, expiresYear: 2028, amount: '110' }]);
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
  assert.deepEqual(calculate(input, 2025).tax.remainingLosses, [{ originYear: 2025, expiresYear: 2029, amount: '100' }]);
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
  assert.deepEqual(result.tax.expiredLosses, [{ originYear: 2021, expiresYear: 2025, amount: '25' }]);
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
  assert.deepEqual(tax.remainingLosses, [{ originYear: 2024, expiresYear: 2028, amount: '25' }]);
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
  assert.ok(validateDataset({ version: 2 }).some(error => error.location === 'version'));
  assert.ok(validateDataset(dataset({ transactions: [null] })).some(error => error.location === 'transactions[0]'));
  assert.ok(validateDataset(dataset({ transactions: new Array(5001).fill(null) })).some(error => error.location === 'dataset'));
});

test('an incomplete-year snapshot warns and calculations do not mutate the dataset', () => {
  const input = dataset({ openingDate: '2025-06-01', initialLots: [lot('opening')], transactions: [sell('sale', { date: '2025-07-01' })] });
  const original = JSON.stringify(input);
  const result = calculate(input, 2025);
  assert.ok(result.warnings[0].includes('data di apertura'));
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(calculate(dataset(), 2025).tax, { year: 2025, rate: 26, gains: '0', losses: '0', net: '0', currentLoss: '0', lossesUsed: '0', taxable: '0', tax: '0.00', remainingLosses: [], expiredLosses: [] });
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
  assert.equal(result.rows[3].costBasis, '20.4');
  assert.equal(result.rows[3].fiscalResult, '18.6');
  assert.equal(result.rows[3].managementResult, '18.6');
  assert.deepEqual(result.rows[3].lotDetails.map(value => value.lotId), ['repurchase']);
  assert.deepEqual(result.holdings[0], { asset: 'BTC', quantity: '0.6', average: '51', cost: '30.6', fiscalCost: '30.6', fiscalAverage: '51' });
  assert.equal(result.tax.tax, '17.84');
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
    { originYear: 2024, expiresYear: 2028, amount: '50' },
    { originYear: 2025, expiresYear: 2029, amount: '100' },
  ]);
});

test('retained fiscal cost conserves purchase costs through partial sales and exact fee allocation', () => {
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
  // Purchase basis: 20 + 61 + 80.5. Sold basis: 61/3 + (80.5 + 61/6).
  // Remaining lots are the initial 2 at 10 and 1.5 units from the first purchase at 61/3.
  assert.equal(btc.fiscalCost, '50.5');
  assert.equal(btc.fiscalAverage, Decimal.from('50.5').div('3.5').toString());
  assert.equal(result.rows[1].fiscalAfterAverage, Decimal.from('91').div('6').toString());
  assert.equal(result.rows[2].fiscalAfterAverage, Decimal.from('847').div('36').toString());
  assert.equal(result.holdings.find(value => value.asset === 'ETH').fiscalCost, '11');
  input.transactions.push(sell('liquidation', { order: 6, quantity: '3.5', unitPrice: '100', fees: '0.3' }));
  const liquidated = calculate(input, 2025);
  assert.equal(liquidated.rows.at(-1).costBasis, '50.5');
  assert.equal(liquidated.holdings.find(value => value.asset === 'BTC').fiscalCost, '0');
  assert.equal(liquidated.holdings.find(value => value.asset === 'ETH').fiscalCost, '11');
});
