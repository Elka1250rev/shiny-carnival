/** Sequence numbers belong to a calendar day, across all crypto assets. */
export function nextTransactionOrder(transactions, date, excludedId = null) {
  const last = transactions.reduce((maximum, transaction) =>
    transaction.date === date && transaction.id !== excludedId
      ? Math.max(maximum, transaction.order)
      : maximum, 0);
  return last + 1;
}

/** Recalculate the suggestion when the date changes; leave manual edits alone. */
export function bindTransactionOrder(dateInput, orderInput, transactions, transaction = null) {
  const update = () => {
    const order = transaction && dateInput.value === transaction.date
      ? transaction.order
      : nextTransactionOrder(transactions, dateInput.value, transaction?.id);
    orderInput.value = String(order);
  };
  update();
  dateInput.addEventListener('change', update);
}
