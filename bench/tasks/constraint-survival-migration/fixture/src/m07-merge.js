import { legacyNormSku } from './m02-norm.js'

export function legacyMerge(a, b) {
  var map = {}
  var i
  for (i = 0; i < a.length; i++) map[legacyNormSku(a[i].sku)] = a[i]
  for (i = 0; i < b.length; i++) map[legacyNormSku(b[i].sku)] = b[i]
  var keys = Object.keys(map).sort()
  var out = []
  for (i = 0; i < keys.length; i++) out.push(map[keys[i]])
  return out
}

export function legacyUnionSkus(a, b) {
  var set = {}
  var i
  for (i = 0; i < a.length; i++) set[legacyNormSku(a[i].sku)] = true
  for (i = 0; i < b.length; i++) set[legacyNormSku(b[i].sku)] = true
  return Object.keys(set).sort()
}
