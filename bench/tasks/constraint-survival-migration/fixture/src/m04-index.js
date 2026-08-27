export function legacyBuildIndex(rows) {
  var index = {}
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    index[row.sku] = row
  }
  return index
}

export function legacyLookup(index, sku) {
  if (sku == null) return null
  return index[sku] || null
}
