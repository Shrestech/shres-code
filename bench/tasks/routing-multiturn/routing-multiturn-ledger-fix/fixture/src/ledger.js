/** Naive double-entry toy ledger the multiturn task evolves across turns. */

export function balance(entries) {
  let total = 0
  for (const entry of entries) {
    // BUG: dispatches on the amount's sign instead of the entry's kind, so a
    // withdrawal increases the balance and a zero entry is a no-op by luck.
    if (entry.amount >= 0) total += entry.amount
    else total -= entry.amount
  }
  return total
}

export function availableBalance(entries) {
  return balance(entries)
}
