/**
 * Report bootstrap and hash router. Reads globalThis.BENCH_REPORT (set by the
 * generated, gitignored data.js), renders the active route, keeps filter state
 * in the hash query so any view is shareable by link, and fills the top bar
 * with the experiment name, generated-at, demo badge, and comparison grade.
 * Without a payload every route renders the empty state with the generation
 * commands.
 *
 * @module bench/ui/app
 */

import { parseHash } from './model.js'
import { renderCharts, renderEmptyState, renderMatrix, renderSummary, renderTrials } from './views.js'

/**
 * One header element.
 * @param {string} tag - tag name.
 * @param {string} cls - class attribute.
 * @param {string} text - text content.
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  node.textContent = text
  return node
}

/**
 * Fill the top bar's experiment meta: name, generated-at, demo badge, and the
 * comparison grade chip. Hidden without a usable payload.
 * @param {HTMLElement} meta - #experiment-meta container.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {void}
 */
function fillMeta(meta, data) {
  const comparisons = Array.isArray(data.comparisons) ? data.comparisons : []
  const chips = comparisons.map((cmp) => {
    const chip = el('span', `chip grade-${cmp.grade}`, cmp.grade)
    chip.title = `comparison grade: ${cmp.treatment} vs off`
    return chip
  })
  meta.replaceChildren(.../** @type {HTMLElement[]} */ ([
    el('span', 'experiment-name', data.experiment),
    el('span', 'sep', '·'),
    el('span', 'generated', `generated ${data.generatedAt.replace('T', ' ').slice(0, 19)}`),
    data.demo ? el('span', 'badge badge-demo', 'demo') : null,
    ...chips,
  ].filter(Boolean)))
  meta.hidden = false
}

/**
 * Wire the router to the DOM and render the current route. Called once on load
 * in a real browser; the import guard below keeps this inert under node.
 * @returns {void}
 */
function boot() {
  const main = document.getElementById('view')
  const data = /** @type {import('../schema/report-data.js').ReportData | undefined} */ (globalThis.BENCH_REPORT)
  const usable = typeof data === 'object' && data !== null && Array.isArray(data.arms) && Array.isArray(data.cells)

  const banner = document.getElementById('demo-banner')
  if (banner) banner.hidden = !(usable && data.demo)
  const meta = document.getElementById('experiment-meta')
  if (meta && usable) fillMeta(meta, /** @type {import('../schema/report-data.js').ReportData} */ (data))

  const ctx = {
    /**
     * Navigate to a hash; `replace` swaps the current entry instead of pushing,
     * for filter changes that should not fill the history.
     * @param {string} hash - target hash from buildHash.
     * @param {{ replace?: boolean }} [opts] - navigation mode.
     * @returns {void}
     */
    navigate(hash, opts = {}) {
      if (opts.replace) {
        history.replaceState(null, '', hash)
        render()
      } else {
        location.hash = hash
      }
    },
  }

  /**
   * Render the active route into the main element.
   * @returns {void}
   */
  function render() {
    const { view, params } = parseHash(location.hash)
    for (const a of document.querySelectorAll('#nav a')) {
      const link = /** @type {HTMLElement} */ (a)
      if (link.dataset.view === view) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    document.title = `${view} — ${usable ? `${/** @type {import('../schema/report-data.js').ReportData} */ (data).experiment} ` : ''}bench report`
    main?.replaceChildren()
    if (!main) return
    if (!usable) {
      renderEmptyState(main)
      return
    }
    if (view === 'matrix') renderMatrix(main, data, ctx)
    else if (view === 'charts') renderCharts(main, data, ctx, params)
    else if (view === 'trials') renderTrials(main, data, ctx, params)
    else renderSummary(main, data)
  }

  window.addEventListener('hashchange', render)
  render()
}

const isBrowser = typeof window !== 'undefined'
  && typeof document !== 'undefined'
  && typeof document.getElementById === 'function'
  && typeof document.querySelectorAll === 'function'
if (isBrowser) boot()
