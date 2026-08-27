export function legacyNormSku(sku) {
  console.log('norm sku')
  if (sku == null) return ''
  return String(sku).trim().toUpperCase()
}

export function legacyNormName(name) {
  if (name == null) return ''
  var s = String(name).trim().replace(/\s+/g, ' ')
  return s
}
