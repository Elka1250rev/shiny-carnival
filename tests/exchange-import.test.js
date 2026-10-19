import test from 'node:test';
import assert from 'node:assert/strict';
import { EXCHANGE_CSV_COLUMNS, parseExchangeCsv } from '../dist/exchange-csv.js';
import { analyzeExchangeCsv, convertExchangeCsv } from '../dist/exchange-import.js';
import { calculate, validateDataset } from '../dist/engine.js';
import { exportCsv, parseCsv } from '../dist/csv.js';

const sourceRow = overrides => ({
  id: 'source-1', datetime_tz_CET: '2025-08-01-23:15:30', type: 'Buy',
  label: '', market_model_type: 'SPOT', order_type: 'LIMIT',
  sent_amount: '100.00', sent_currency: 'EUR', sent_value_EUR: '100.00', sent_address: '',
  received_amount: '3.000000000000000001', received_currency: 'ALFA', received_value_EUR: '99.50', received_address: '',
  fee_amount: '0.010000000000000001', fee_currency: 'ALFA', fee_value_EUR: '0.09950',
  ...overrides
});
const file = rows => [EXCHANGE_CSV_COLUMNS, ...rows.map(row => EXCHANGE_CSV_COLUMNS.map(name => row[name]))]
  .map(row => row.map(value => '"' + value.replaceAll('"', '""') + '"').join(',')).join('\r\n');
const parsed = rows => parseExchangeCsv(file(rows));
const dataset = overrides => ({ version: 1, openingDate: '2025-01-01', initialLots: [], transactions: [], carryLosses: [], ...overrides });
const options = overrides => ({ mode: 'replace', dateConfirmed: true, grossValuesConfirmed: true, ...overrides });
const trade = overrides => sourceRow({ type: 'Trade', sent_currency: 'ALFA', received_currency: 'BETA', fee_amount: '0', fee_currency: '', fee_value_EUR: '0', ...overrides });
const reward = overrides => sourceRow({ type: 'Receive', label: 'Reward', market_model_type: 'EARN',
  sent_amount: '0', sent_currency: '', sent_value_EUR: '0', received_amount: '0.500000000000000001',
  received_currency: 'ALFA', received_value_EUR: '12.345678901234567891', fee_amount: '0', fee_currency: '', fee_value_EUR: '0', ...overrides });

test('analysis inventories swaps and rewards without inferring the tax treatment of any ticker', () => {
  const result = analyzeExchangeCsv(parsed([
    trade({ id: 'swap-1' }), trade({ id: 'swap-2' }),
    trade({ id: 'swap-3', sent_currency: 'BETA', received_currency: 'ALFA', fee_currency: 'GAMMA', fee_amount: '1', fee_value_EUR: '2' }),
    reward({ id: 'reward-1' }), sourceRow({ id: 'unknown', type: 'FutureType' })
  ]));
  assert.deepEqual(result.swapPairs, [
    { key: 'ALFA→BETA', sentAsset: 'ALFA', receivedAsset: 'BETA', count: 2 },
    { key: 'BETA→ALFA', sentAsset: 'BETA', receivedAsset: 'ALFA', count: 1 }
  ]);
  assert.equal(result.rewardCount, 1);
  assert.equal(result.thirdFeeCount, 1);
  assert.deepEqual(result.counts, { Trade: 3, Receive: 1, FutureType: 1 });
  assert.deepEqual(result.unsupportedRows.map(({ line, type }) => ({ line, type })), [{ line: 6, type: 'FutureType' }]);
});

test('effective quantities, totals and source fees remain exact without double application', () => {
  const result = convertExchangeCsv(parsed([sourceRow()]), dataset(), options());
  const transaction = result.dataset.transactions[0];
  assert.equal(result.dataset.version, 2);
  assert.equal(transaction.quantity, '3.000000000000000001');
  assert.equal(transaction.totalEur, '100.00');
  assert.equal(transaction.unitPrice, '0');
  assert.equal(transaction.fees, '0');
  assert.equal(transaction.source.values.fee_amount, '0.010000000000000001');
  assert.equal(transaction.source.decisions.feePolicy, 'already_included');
  assert.equal(transaction.source.decisions.amountsPolicy, 'as_reported_confirmed');
  assert.equal(result.dataset.transactions.length, 1);
});

test('a three-unit acquisition for 100 euros never calculates a rounded unit price', () => {
  const input = convertExchangeCsv(parsed([sourceRow({ received_amount: '3', fee_amount: '0', fee_value_EUR: '0' })]), dataset(), options()).dataset;
  const result = calculate(input, 2025);
  assert.equal(input.transactions[0].unitPrice, '0');
  assert.equal(input.transactions[0].totalEur, '100.00');
  assert.equal(result.rows[0].afterAverage, '33.333333333333333333');
  assert.equal(result.holdings[0].cost, '100');
});

test('sales use the actual received euro value and never add fees a second time', () => {
  const sell = sourceRow({ type: 'Sell', sent_currency: 'ALFA', sent_amount: '2.000000000000000001',
    sent_value_EUR: '51', received_currency: 'EUR', received_amount: '49', received_value_EUR: '49.123456789012345678',
    fee_currency: 'EUR', fee_amount: '1', fee_value_EUR: '1' });
  const transaction = convertExchangeCsv(parsed([sell]), dataset(), options()).dataset.transactions[0];
  assert.equal(transaction.type, 'vendita');
  assert.equal(transaction.quantity, sell.sent_amount);
  assert.equal(transaction.totalEur, sell.received_value_EUR);
  assert.equal(transaction.fees, '0');
});

test('every exchange needs an explicit classification and neutral exchanges need a lot date choice', () => {
  const input = parsed([trade()]);
  assert.throws(() => convertExchangeCsv(input, dataset(), options()), /Riga 2.*ALFA→BETA.*neutral.*taxable/);
  assert.throws(() => convertExchangeCsv(input, dataset(), options({ swapTreatments: { 'ALFA→BETA': 'neutral' } })), /lotDatePolicy/);
  for (const lotDatePolicy of ['historical', 'exchange']) {
    const transaction = convertExchangeCsv(input, dataset(), options({ swapTreatments: { 'ALFA→BETA': 'neutral' }, lotDatePolicy })).dataset.transactions[0];
    assert.equal(transaction.type, 'permuta_neutrale');
    assert.equal(transaction.asset, 'ALFA');
    assert.equal(transaction.receivedAsset, 'BETA');
    assert.equal(transaction.quantity, '100.00');
    assert.equal(transaction.receivedQuantity, '3.000000000000000001');
    assert.equal(transaction.lotDatePolicy, lotDatePolicy);
    assert.equal(hasOwn(transaction, 'totalEur'), false);
    assert.equal(transaction.source.decisions.swapTaxTreatment, 'neutral');
  }
  const taxable = convertExchangeCsv(input, dataset(), options({ swapTreatments: { 'ALFA→BETA': 'taxable' } })).dataset.transactions[0];
  assert.equal(taxable.type, 'permuta_imponibile');
  assert.equal(taxable.totalEur, '99.50');
  assert.equal(hasOwn(taxable, 'lotDatePolicy'), false);
});
const hasOwn = (object, key) => Object.hasOwn(object, key);

test('rewards require explicit income treatment and a cost policy instead of silently assigning zero', () => {
  const input = parsed([reward()]);
  assert.throws(() => convertExchangeCsv(input, dataset(), options()), /rewardsTreatment/);
  assert.throws(() => convertExchangeCsv(input, dataset(), options({ rewardsTreatment: 'holding_income' })), /rewardCostPolicy/);
  const common = { rewardsTreatment: 'holding_income' };
  const zeroCost = convertExchangeCsv(input, dataset(), options({ ...common, rewardCostPolicy: 'zero_confirmed' })).dataset.transactions[0];
  assert.equal(zeroCost.type, 'provento');
  assert.equal(zeroCost.totalEur, '12.345678901234567891');
  assert.equal(zeroCost.rewardCostEur, '0');
  const valueCost = convertExchangeCsv(input, dataset(), options({ ...common, rewardCostPolicy: 'received_value_confirmed' })).dataset.transactions[0];
  assert.equal(valueCost.rewardCostEur, '12.345678901234567891');
  assert.throws(() => convertExchangeCsv(input, dataset(), options({ ...common, rewardCostPolicy: 'manual' })), /costo fiscale documentato/);
  const manual = convertExchangeCsv(input, dataset(), options({ ...common, rewardCostPolicy: 'manual', rewardCosts: { 'source-1': '7.000000000000000001' } })).dataset.transactions[0];
  assert.equal(manual.rewardCostEur, '7.000000000000000001');
});

test('unknown types, non-EARN receipts and incoherent legs are rejected with source line and type', () => {
  for (const row of [
    sourceRow({ type: 'Unknown' }), reward({ label: 'Transfer' }), reward({ market_model_type: 'SPOT' }),
    sourceRow({ sent_currency: 'ALFA' }), sourceRow({ received_amount: '0' }),
    trade({ received_currency: 'ALFA' }), reward({ sent_amount: '1' }),
    sourceRow({ fee_amount: '0', fee_value_EUR: '1' })
  ]) {
    assert.throws(() => convertExchangeCsv(parsed([row]), dataset(), options()), new RegExp(`Riga 2 \\(${row.type}\\):`));
  }
  const input = parsed([sourceRow({ type: 'Unknown' }), sourceRow({ id: 'second', type: 'Withdraw' })]);
  assert.throws(() => convertExchangeCsv(input, dataset(), options()), error => error.errors.length === 2
    && error.message.includes('Riga 2 (Unknown)') && error.message.includes('Riga 3 (Withdraw)'));
});

test('deposits in euros remain informational events, not invented crypto purchases', () => {
  const input = sourceRow({ type: 'Deposit', sent_amount: '0', sent_currency: '', sent_value_EUR: '0',
    received_amount: '1000.00', received_currency: 'EUR', received_value_EUR: '1000.00',
    fee_amount: '0', fee_currency: '', fee_value_EUR: '0' });
  const result = convertExchangeCsv(parsed([input]), dataset(), options());
  assert.equal(result.dataset.transactions[0].type, 'deposito_eur');
  assert.equal(result.dataset.transactions[0].asset, 'EUR');
  assert.equal(result.dataset.transactions[0].quantity, '1000.00');
  assert.equal(result.dataset.transactions[0].unitPrice, '1');
  assert.equal(result.dataset.transactions[0].totalEur, '1000.00');
  assert.equal(result.summary.transactionCount, 1);
  assert.equal(calculate(result.dataset, 2025).holdings.length, 0);
});

test('date interpretation, effective gross amounts and import mode require confirmations', () => {
  for (const patch of [{ mode: undefined }, { mode: 'merge' }, { dateConfirmed: false }, { grossValuesConfirmed: false }]) {
    assert.throws(() => convertExchangeCsv(parsed([sourceRow()]), dataset(), options(patch)), /Scegli esplicitamente|Conferma/);
  }
});

test('replacement changes transactions only; appending rejects ids already in any retained collection', () => {
  const initial = dataset({
    initialLots: [{ id: 'lot', asset: 'ALFA', acquiredOn: '2024-02-01', order: 1, quantity: '2', unitCost: '10' }],
    carryLosses: [{ id: 'loss', year: 2024, amount: '5' }],
    transactions: [{ id: 'source-1', date: '2025-07-01', order: 7, type: 'acquisto', asset: 'ALFA', quantity: '1', unitPrice: '2', fees: '0' }]
  });
  const before = structuredClone(initial);
  const result = convertExchangeCsv(parsed([sourceRow()]), initial, options());
  assert.equal(result.dataset.openingDate, initial.openingDate);
  assert.deepEqual(result.dataset.initialLots, initial.initialLots);
  assert.deepEqual(result.dataset.carryLosses, initial.carryLosses);
  assert.equal(result.dataset.transactions.length, 1);
  assert.deepEqual(initial, before);
  assert.throws(() => convertExchangeCsv(parsed([sourceRow()]), initial, options({ mode: 'append' })), /già presente/);
  assert.throws(() => convertExchangeCsv(parsed([sourceRow({ id: 'lot' })]), initial, options()), /già presente/);
  assert.throws(() => convertExchangeCsv(parsed([sourceRow({ id: 'loss' })]), initial, options()), /già presente/);
  const first = convertExchangeCsv(parsed([sourceRow()]), dataset(), options()).dataset;
  assert.throws(() => convertExchangeCsv(parsed([sourceRow()]), first, options({ mode: 'append' })), /già presente/);
});

test('append refuses overlapping calendar dates instead of inventing their order', () => {
  const initial = dataset({ transactions: [{ id: 'existing', date: '2025-08-01', order: 99, type: 'acquisto', asset: 'ALFA', quantity: '1', unitPrice: '1', fees: '0' }] });
  assert.throws(() => convertExchangeCsv(parsed([sourceRow()]), initial, options({ mode: 'append' })), /sequenza.*non è verificabile/);
  const next = sourceRow({ datetime_tz_CET: '2025-08-02-00:00:01' });
  const result = convertExchangeCsv(parsed([next]), initial, options({ mode: 'append' })).dataset;
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].order, 99);
  assert.equal(result.transactions[1].order, 1);
});

test('source timestamps sort literally, equal timestamps follow row order and each day starts at one', () => {
  const rows = [
    sourceRow({ id: 'later', datetime_tz_CET: '2025-08-02-00:01:00' }),
    sourceRow({ id: 'tie-first', datetime_tz_CET: '2025-08-01-23:59:59' }),
    sourceRow({ id: 'earlier', datetime_tz_CET: '2025-08-01-12:00:00' }),
    sourceRow({ id: 'tie-second', datetime_tz_CET: '2025-08-01-23:59:59' })
  ];
  const result = convertExchangeCsv(parsed(rows), dataset(), options()).dataset.transactions;
  assert.deepEqual(result.map(item => [item.id, item.date, item.order]), [
    ['earlier', '2025-08-01', 1], ['tie-first', '2025-08-01', 2], ['tie-second', '2025-08-01', 3], ['later', '2025-08-02', 1]
  ]);
  assert.equal(result[1].source.values.datetime_tz_CET, '2025-08-01-23:59:59');
});

test('third-asset fees require a choice and become a separate disposal only if explicitly chosen', () => {
  const input = parsed([sourceRow({ fee_currency: 'GAMMA', fee_amount: '0.100000000000000001', fee_value_EUR: '2.123456789012345678' })]);
  assert.throws(() => convertExchangeCsv(input, dataset(), options()), /thirdAssetFees/);
  const included = convertExchangeCsv(input, dataset(), options({ thirdAssetFees: 'included_no_additional_movement' })).dataset.transactions;
  assert.equal(included.length, 1);
  assert.equal(included[0].totalEur, '100.00');
  assert.equal(included[0].source.decisions.feePolicy, 'already_included');
  const separate = convertExchangeCsv(input, dataset(), options({ thirdAssetFees: 'separate_taxable_disposal' })).dataset.transactions;
  assert.equal(separate.length, 2);
  assert.equal(separate[0].totalEur, '100.00');
  assert.deepEqual([separate[1].id, separate[1].type, separate[1].asset, separate[1].quantity, separate[1].totalEur, separate[1].fees, separate[1].order],
    ['source-1.fee', 'vendita', 'GAMMA', '0.100000000000000001', '2.123456789012345678', '0', 2]);
  assert.equal(separate[1].source.derived, true);
  assert.equal(separate[1].source.values.id, 'source-1');
});

test('derived fee ids fit 64 characters and collisions fail instead of replacing any record', () => {
  const longId = 'A'.repeat(59) + '😀😀';
  const input = sourceRow({ id: longId, fee_currency: 'GAMMA', fee_amount: '1', fee_value_EUR: '2' });
  const transaction = convertExchangeCsv(parsed([input]), dataset(), options({ thirdAssetFees: 'separate_taxable_disposal' })).dataset.transactions[1];
  assert.equal(transaction.id, 'A'.repeat(59) + '.fee');
  assert.ok(transaction.id.length <= 64);
  const duplicate = sourceRow({ id: 'source-1.fee' });
  assert.throws(() => convertExchangeCsv(parsed([sourceRow({ fee_currency: 'GAMMA', fee_amount: '1' }), duplicate]), dataset(), options({ thirdAssetFees: 'separate_taxable_disposal' })), /Collisione/);
});

test('manual overrides are exact, explicit and may not silently target nonexistent records or fields', () => {
  const input = parsed([sourceRow()]);
  const result = convertExchangeCsv(input, dataset(), options({ overrides: { 'source-1': { quantity: '2.000000000000000001', totalEur: '101.000000000000000001' } } })).dataset.transactions[0];
  assert.equal(result.quantity, '2.000000000000000001');
  assert.equal(result.totalEur, '101.000000000000000001');
  assert.equal(result.source.values.received_amount, '3.000000000000000001');
  assert.equal(result.source.decisions.amountsPolicy, 'manual');
  for (const overrides of [{ absent: { totalEur: '1' } }, { 'source-1': { totalEur: 1 } }, { 'source-1': { quantity: '0' } },
    { 'source-1': { extra: '1' } }, { 'source-1': { receivedQuantity: '1' } }, { 'source-1': { rewardCostEur: '1' } }]) {
    assert.throws(() => convertExchangeCsv(input, dataset(), options({ overrides })), /Riga 2/);
  }
});

test('raw metadata stays plain text and neither source records nor the current dataset are mutated', () => {
  const source = sourceRow({ label: '<script>alert("test")</script>', sent_address: 'address, "quoted"', received_address: '<img src=x onerror=alert(1)>' });
  const input = parsed([source]);
  const initial = dataset();
  const beforeInput = structuredClone(input);
  const beforeInitial = structuredClone(initial);
  const result = convertExchangeCsv(input, initial, options()).dataset;
  assert.deepEqual(result.transactions[0].source.values, source);
  assert.deepEqual(input, beforeInput);
  assert.deepEqual(initial, beforeInitial);
  result.transactions[0].source.values.label = 'changed';
  result.initialLots.push({ id: 'not-shared' });
  assert.deepEqual(input, beforeInput);
  assert.deepEqual(initial, beforeInitial);
});


test('the recoverable CSV preserves imported evidence, chosen tax treatment and explicit amounts', () => {
  const input = parsed([
    sourceRow({ id: 'buy', received_amount: '200', fee_amount: '0', fee_value_EUR: '0', label: '<b>source label</b>' }),
    trade({ id: 'swap', datetime_tz_CET: '2025-08-02-12:00:00' }),
    reward({ id: 'reward', datetime_tz_CET: '2025-08-03-12:00:00' })
  ]);
  const converted = convertExchangeCsv(input, dataset(), options({ swapTreatments: { 'ALFA→BETA': 'neutral' },
    lotDatePolicy: 'historical', rewardsTreatment: 'holding_income', rewardCostPolicy: 'manual', rewardCosts: { reward: '4.01' } })).dataset;
  assert.deepEqual(parseCsv(exportCsv(converted)), converted);
});

test('mixed EARN records require row-level qualification and documented acquisition costs', () => {
  const input = parsed([
    reward({ id: 'holding', received_amount: '1', received_value_EUR: '10.00' }),
    reward({ id: 'cashback', received_amount: '1.000000000000000001', received_value_EUR: '20.00' })
  ]);
  const common = { rewardsTreatment: 'per_row', rewardCostPolicy: 'manual', rewardCosts: { holding: '10.00', cashback: '7.00' } };
  assert.throws(() => convertExchangeCsv(input, dataset(), options(common)), /Riga 2.*Classifica esplicitamente.*Riga 3/s);
  assert.throws(() => convertExchangeCsv(input, dataset(), options({ ...common, rewardTreatments: { holding: 'holding_income' } })), /Riga 3.*Classifica esplicitamente/);
  const result = convertExchangeCsv(input, dataset(), options({ ...common,
    rewardTreatments: { holding: 'holding_income', cashback: 'documented_acquisition' } })).dataset;
  assert.equal(result.transactions[0].type, 'provento');
  assert.equal(result.transactions[0].totalEur, '10.00');
  assert.equal(result.transactions[0].rewardCostEur, '10.00');
  assert.equal(result.transactions[1].type, 'acquisto');
  assert.equal(result.transactions[1].totalEur, '7.00');
  assert.equal(result.transactions[1].quantity, '1.000000000000000001');
  assert.equal(Object.hasOwn(result.transactions[1], 'rewardCostEur'), false);
  assert.equal(result.transactions[1].source.decisions.rewardTreatment, 'documented_acquisition');
  assert.equal(result.transactions[1].source.values.received_value_EUR, '20.00');
  const calculated = calculate(result, 2025);
  assert.equal(calculated.tax.income, '10');
  assert.equal(calculated.tax.tax, '2.60');
  assert.equal(calculated.holdings[0].fiscalCost, '17');
  assert.deepEqual(parseCsv(exportCsv(result)), result, 'Both reward categories and their source decisions must survive canonical v2 export.');
});

test('the global holding choice allows explicit per-row documented acquisitions without a zero-cost default', () => {
  const input = parsed([reward({ id: 'cashback' })]);
  const common = { rewardsTreatment: 'holding_income', rewardTreatments: { cashback: 'documented_acquisition' } };
  assert.throws(() => convertExchangeCsv(input, dataset(), options(common)), /rewardCostPolicy/);
  assert.throws(() => convertExchangeCsv(input, dataset(), options({ ...common, rewardCostPolicy: 'manual' })), /costo fiscale documentato/);
  const zeroResult = convertExchangeCsv(input, dataset(), options({ ...common, rewardCostPolicy: 'zero_confirmed' })).dataset;
  assert.equal(zeroResult.transactions[0].type, 'acquisto');
  assert.equal(zeroResult.transactions[0].totalEur, '0');
  assert.equal(calculate(zeroResult, 2025).tax.income, '0');
  assert.throws(() => convertExchangeCsv(input, dataset(), options({ ...common, rewardCostPolicy: 'zero_confirmed',
    overrides: { cashback: { rewardCostEur: '1' } } })), /contraddice zero_confirmed/);
  const documented = convertExchangeCsv(input, dataset(), options({ ...common, rewardCostPolicy: 'received_value_confirmed' })).dataset;
  assert.equal(documented.transactions[0].totalEur, '12.345678901234567891');
});

test('row-level reward classifications reject typos and no longer classify EUR cash fees as a third crypto', () => {
  const rewardInput = parsed([reward()]);
  const common = { rewardsTreatment: 'per_row', rewardCostPolicy: 'zero_confirmed' };
  assert.throws(() => convertExchangeCsv(rewardInput, dataset(), options({ ...common, rewardTreatments: { 'source-1': 'promotion' } })), /Classifica esplicitamente/);
  assert.throws(() => convertExchangeCsv(rewardInput, dataset(), options({ ...common,
    rewardTreatments: { 'source-1': 'documented_acquisition', nonexistent: 'holding_income' } })), /id premio assente/);
  const input = parsed([trade({ fee_amount: '2', fee_currency: 'EUR', fee_value_EUR: '2' })]);
  assert.equal(analyzeExchangeCsv(input).thirdFeeCount, 0);
  const result = convertExchangeCsv(input, dataset(), options({ swapTreatments: { 'ALFA→BETA': 'neutral' }, lotDatePolicy: 'historical',
    thirdAssetFees: 'separate_taxable_disposal' })).dataset;
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].source.decisions.feePolicy, 'already_included');
});


test('oversized source amounts are inventoried lexically and rejected by engine bounds before arithmetic', () => {
  const huge = '9'.repeat(100000);
  const input = parsed([sourceRow({ sent_amount: huge, sent_value_EUR: huge, received_amount: '0.' + '0'.repeat(100000) + '1',
    fee_amount: '0.' + '0'.repeat(100000), fee_value_EUR: '0' })]);
  const analysis = analyzeExchangeCsv(input);
  assert.deepEqual(analysis.unsupportedRows, []);
  assert.equal(analysis.thirdFeeCount, 0);
  const converted = convertExchangeCsv(input, dataset(), options()).dataset;
  assert.equal(converted.transactions[0].totalEur, huge);
  assert.equal(converted.transactions[0].quantity, '0.' + '0'.repeat(100000) + '1');
  const errors = validateDataset(converted);
  assert.ok(errors.some(error => error.location === 'transactions[0].totalEur'));
  assert.ok(errors.some(error => error.location === 'transactions[0].quantity'));
});

test('confirmed reward cost equality compares decimal spellings exactly without numeric coercion', () => {
  const input = parsed([reward({ received_value_EUR: '00012.3400' })]);
  const common = { rewardsTreatment: 'holding_income', rewardCostPolicy: 'received_value_confirmed' };
  const result = convertExchangeCsv(input, dataset(), options({ ...common, overrides: { 'source-1': { rewardCostEur: '12.34' } } }));
  assert.equal(result.dataset.transactions[0].rewardCostEur, '00012.3400');
  assert.throws(() => convertExchangeCsv(input, dataset(), options({ ...common,
    overrides: { 'source-1': { rewardCostEur: '12.340000000000000001' } } })), /contraddice received_value_confirmed/);
});
