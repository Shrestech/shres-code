import { legacyParseRow } from './m01-parse.js'

export function legacyFilterByPrefix(rows, prefix) {
  var out = []
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].sku).indexOf(prefix) == 0) out.push(rows[i])
  }
  return out
}

export function legacyFilterInStock(rows) {
  var out = []
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].qty > 0) out.push(rows[i])
  }
  return out
}

export function legacyParseAndFilter(line, prefix) {
  var row = legacyParseRow(line)
  if (row == null) return null
  if (String(row.sku).indexOf(prefix) == 0) return row
  return null
}
