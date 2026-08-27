export function legacyParseRow(line) {
  if (line == null || line == '') return null
  var parts = String(line).split('|')
  if (parts.length != 4) return null
  return {
    sku: parts[0],
    name: parts[1],
    price: Number(parts[2]),
    qty: Number(parts[3]),
  }
}

export function legacyParseCatalog(text) {
  var lines = String(text).split('\n')
  var rows = []
  for (var i = 0; i < lines.length; i++) {
    var row = legacyParseRow(lines[i])
    if (row != null) rows.push(row)
  }
  return rows
}
