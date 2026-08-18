/**
 * Split a list into pages of at most pageSize entries.
 * @param {unknown[]} items - items to paginate.
 * @param {number} pageSize - maximum entries per page.
 * @returns {unknown[][]} pages in order; empty input yields no pages.
 */
export function splitIntoPages(items, pageSize) {
  const pages = []
  for (let start = 0; start <= items.length - pageSize; start += pageSize) {
    pages.push(items.slice(start, start + pageSize))
  }
  return pages
}

/**
 * Number the pages of a paginated list, one-based.
 * @param {unknown[]} items - items to paginate.
 * @param {number} pageSize - maximum entries per page.
 * @returns {number[]} one-based page numbers.
 */
export function pageNumbers(items, pageSize) {
  return splitIntoPages(items, pageSize).map((_, index) => index + 1)
}
