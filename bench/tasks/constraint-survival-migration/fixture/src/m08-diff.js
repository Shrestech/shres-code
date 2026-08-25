import { legacyParseRow } from './m01-parse.js'
import { basename } from 'node:path'

export function legacySourceName(filePath) {
  console.log('source', filePath)
  return basename(filePath, '.txt')
}

export function legacyAdded(before, after) {
  var have = {}
  var i
  for (i = 0; i < before.length; i++) have[before[i].sku] = true
  var out = []
  for (i = 0; i < after.length; i++) {
    if (have[after[i].sku] == true) continue
    out.push(after[i])
  }
  return out
}

export function legacyRemoved(before, after) {
  var have = {}
  var i
  for (i = 0; i < after.length; i++) have[after[i].sku] = true
  var out = []
  for (i = 0; i < before.length; i++) {
    if (have[before[i].sku] == true) continue
    out.push(before[i])
  }
  return out
}

export function legacyParseNamed(filePath, line) {
  var row = legacyParseRow(line)
  if (row == null) return null
  row.source = legacySourceName(filePath)
  return row
}
