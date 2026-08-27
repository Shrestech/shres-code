import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const tables = require('./tables.json')

export function legacyIsValidRow(row) {
  if (row == null) return false
  var sku = String(row.sku || '')
  var okPrefix = false
  for (var i = 0; i < tables.prefixes.length; i++) {
    if (sku.indexOf(tables.prefixes[i]) == 0) okPrefix = true
  }
  return okPrefix && row.price > 0 && row.qty >= 0
}

export function legacyAssertRow(row) {
  if (!legacyIsValidRow(row)) throw new Error('invalid row')
  return row
}
