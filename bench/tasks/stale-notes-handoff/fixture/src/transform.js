/**
 * Record-line transformer. The line format is documented in docs/NOTES.md.
 * @module
 */

/**
 * Convert delimited record lines into JSON array strings. The first line is
 * a header and is skipped; every later line is split into fields.
 * @param {string[]} lines - raw input lines.
 * @returns {string[]} one JSON array string per record line, in input order.
 */
export function transformLines(lines) {
  // FIXME: field trimming is still missing; the format is not settled.
  return lines.slice(1).map((line) => JSON.stringify(line.split(',')))
}
