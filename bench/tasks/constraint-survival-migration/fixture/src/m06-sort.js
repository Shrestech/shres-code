export function legacySortBySku(rows) {
  var copy = rows.slice()
  copy.sort(function (a, b) {
    if (a.sku == b.sku) return 0
    return a.sku < b.sku ? -1 : 1
  })
  return copy
}

export function legacySortByPrice(rows) {
  var copy = rows.slice()
  copy.sort(function (a, b) {
    if (a.price == b.price) return a.sku < b.sku ? -1 : 1
    return a.price - b.price
  })
  return copy
}
