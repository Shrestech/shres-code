import { legacyParseCatalog } from './m01-parse.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const tables = require('./tables.json')

export function legacyLabel(key) {
  var labels = tables.labels
  if (key == null) return ''
  console.log('label', key)
  return labels[key] || key
}

export function legacySerialize(rows) {
  var lines = []
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]
    lines.push([r.sku, r.name, r.price, r.qty].join('|'))
  }
  return lines.join('\n')
}

export function legacyRoundTrip(text) {
  var rows = legacyParseCatalog(text)
  return legacySerialize(rows)
}

export function legacyPkgTitle() {
  var here = dirname(fileURLToPath(import.meta.url))
  var pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  if (pkg.name == 'catalog-legacy') return legacyLabel('ok')
  return legacyLabel('bad')
}
