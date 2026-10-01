import { balance } from './ledger.js'

/** One summary line for an account's entries. */
export function summary(entries) {
  return `balance: ${balance(entries)}`
}
