import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTransactionOrder, nextTransactionOrder } from '../dist/transaction-order.js';

class Input extends EventTarget {
  constructor(value) { super(); this.value = value; }
  change(value) { this.value = value; this.dispatchEvent(new Event('change')); }
}

const transactions = [
  { id: 'btc-1', date: '2026-02-01', order: 1, asset: 'BTC' },
  { id: 'eth-1', date: '2026-02-01', order: 5, asset: 'ETH' },
  { id: 'btc-2', date: '2026-02-02', order: 2, asset: 'BTC' },
  { id: 'btc-3', date: '2026-03-01', order: 20, asset: 'BTC' },
];

test('a first transaction starts at one regardless of sequences on other dates', () => {
  assert.equal(nextTransactionOrder(transactions, '2026-02-03'), 1);
  assert.equal(nextTransactionOrder([], '2026-02-03'), 1);
});

test('the suggestion follows the highest sequence for that day across all assets', () => {
  assert.equal(nextTransactionOrder(transactions, '2026-02-01'), 6);
  assert.equal(nextTransactionOrder(transactions, '2026-02-02'), 3);
});

test('opening the form and changing its date update the actual sequence input', () => {
  const dateInput = new Input('2026-02-03');
  const orderInput = new Input('99');
  bindTransactionOrder(dateInput, orderInput, transactions);
  assert.equal(orderInput.value, '1');
  dateInput.change('2026-02-01');
  assert.equal(orderInput.value, '6');
  dateInput.change('2026-02-02');
  assert.equal(orderInput.value, '3');
  dateInput.change('2026-02-04');
  assert.equal(orderInput.value, '1');
});

test('editing preserves the original sequence and restores it after returning to that date', () => {
  const transaction = transactions[0];
  const dateInput = new Input(transaction.date);
  const orderInput = new Input('99');
  bindTransactionOrder(dateInput, orderInput, transactions, transaction);
  assert.equal(orderInput.value, '1');
  dateInput.change('2026-02-02');
  assert.equal(orderInput.value, '3');
  dateInput.change('2026-02-04');
  assert.equal(orderInput.value, '1');
  dateInput.change(transaction.date);
  assert.equal(orderInput.value, '1');
});

test('a manual sequence remains editable and is recalculated only when the date changes', () => {
  const dateInput = new Input('2026-02-01');
  const orderInput = new Input('');
  bindTransactionOrder(dateInput, orderInput, transactions);
  orderInput.change('4');
  assert.equal(orderInput.value, '4');
  dateInput.change('2026-02-02');
  assert.equal(orderInput.value, '3');
});

test('the transaction being edited is excluded when calculating a new suggestion', () => {
  assert.equal(nextTransactionOrder(transactions, '2026-02-01', 'eth-1'), 2);
});
