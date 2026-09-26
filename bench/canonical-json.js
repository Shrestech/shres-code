/** Deterministic JSON for identities and replay-method provenance. @module */
/**
 * Stable string form for retry comparison: object keys sort recursively so
 * semantically identical arguments compare equal regardless of key order.
 * @param {unknown} value - a parsed JSON value.
 * @returns {string} canonical JSON text.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}
