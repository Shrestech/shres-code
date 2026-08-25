import { legacyBuildIndex } from './m04-index.js'
import { join } from 'node:path'

export function legacyFormatRow(row) {
  return row.sku + '|' + row.name + '|' + String(row.price) + '|' + String(row.qty)
}

export function legacyFormatTable(rows) {
  var lines = []
  for (var i = 0; i < rows.length; i++) lines.push(legacyFormatRow(rows[i]))
  return lines.join('\n')
}

export function legacyFormatIndexed(rows, sku) {
  console.log('format', sku)
  var index = legacyBuildIndex(rows)
  var row = index[sku]
  if (row == null) return ''
  return join('row', legacyFormatRow(row))
}
