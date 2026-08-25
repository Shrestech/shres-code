/**
 * View renderers for the four report routes. Browser-only: builds DOM from the
 * ReportData payload using the pure derivations in model.js and the SVG
 * builders in charts.js. Every renderer replaces the contents of its container.
 *
 * @module bench/ui/views
 */

import {
  TRIAL_SORTS,
  armColorMap,
  barsSpec,
  buildHash,
  chainTasks,
  comparisonList,
  deltaSpec,
  filterTrials,
  formatInt,
  formatMs,
  formatP,
  formatPct,
  formatRatio,
  formatSignedPct,
  formatTokens,
  heatColor,
  heroList,
  integrityViolations,
  matrixRows,
  phasesOf,
  phaseSpec,
  radarSpec,
  scatterSpec,
  sparkSeries,
  strataOf,
  summaryRows,
  trialList,
} from './model.js'
import { deltaChart, groupedBarChart, pairedScatter, radarChart, sparkline } from './charts.js'

/**
 * Create one HTML element.
 * @param {string} tag - tag name.
 * @param {Record<string, unknown>} [attrs] - `class`, `text`, `html`, `on<Event>`, `dataset`, anything else as an attribute.
 * @param {(Node | string | null | undefined | (Node | string | null | undefined)[])[]} children - appended in order; nested lists are flattened one level.
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue
    if (k === 'class') node.className = /** @type {string} */ (v)
    else if (k === 'text') node.textContent = /** @type {string} */ (v)
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), /** @type {EventListener} */ (v))
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else node.setAttribute(k, String(v))
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(/** @type {Node | string} */ (child))
  return /** @type {HTMLElement} */ (node)
}

/**
 * Stat card.
 * @param {string} label - small caps label.
 * @param {Node | string} value - headline value.
 * @param {string | SVGElement | null} [sub] - muted subline or an inline chart.
 * @param {string} [extraSub] - second muted subline.
 * @returns {HTMLElement}
 */
function card(label, value, sub, extraSub) {
  return h('div', { class: 'card' },
    h('div', { class: 'label', text: label }),
    h('div', { class: 'value' }, value),
    sub && typeof sub === 'object' ? sub : sub ? h('div', { class: 'sub', text: sub }) : null,
    extraSub ? h('div', { class: 'sub', text: extraSub }) : null)
}

/**
 * Comparison grade chip.
 * @param {string} grade - comparison grade.
 * @param {string} [title] - tooltip.
 * @returns {HTMLElement}
 */
function gradeChip(grade, title) {
  return h('span', { class: `chip grade-${grade}`, ...(title ? { title } : {}), text: grade })
}

/**
 * Hero tile of the comparison banner.
 * @param {string} k - small caps label.
 * @param {Node | string} big - headline content.
 * @param {string} [sub] - muted subline.
 * @param {string} [cls] - extra class on the headline.
 * @returns {HTMLElement}
 */
function heroTile(k, big, sub, cls) {
  return h('section', {},
    h('div', { class: 'k', text: k }),
    h('div', { class: `big${cls ? ` ${cls}` : ''}` }, big),
    sub ? h('div', { class: 'sub', text: sub }) : null)
}

/**
 * Inline Wilson CI bar on a 0–100% track: band for the interval, tick for the
 * point estimate.
 * @param {number} point - point estimate in [0, 1].
 * @param {[number, number]} ci - interval.
 * @returns {HTMLElement}
 */
function ciBar(point, ci) {
  const lo = Math.max(0, Math.min(ci[0], ci[1]))
  const hi = Math.min(1, Math.max(ci[0], ci[1]))
  return h('div', {
    class: 'ci-track',
    role: 'img',
    'aria-label': `Wilson 95% CI ${formatPct(lo)} to ${formatPct(hi)}, estimate ${formatPct(point)}`,
  },
  h('div', { class: 'ci-band', style: `left:${(lo * 100).toFixed(1)}%;width:${(Math.max(0, hi - lo) * 100).toFixed(1)}%` }),
  h('div', { class: 'ci-point', style: `left:${(Math.min(Math.max(point, 0), 1) * 100).toFixed(1)}%` }))
}

/**
 * One comparison hero banner.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @param {ReturnType<typeof heroList>[number]} hero - derived hero stats.
 * @param {ReturnType<typeof summaryRows>} rows - arm rows with totals.
 * @returns {HTMLElement}
 */
function comparisonHero(data, hero, rows) {
  const off = rows.find(r => r.arm === 'off')
  const treatment = rows.find(r => r.arm === hero.treatment)
  const ciText = hero.deltaCi95
    ? `95% CI ${formatSignedPct(hero.deltaCi95[0])} … ${formatSignedPct(hero.deltaCi95[1])} · paired bootstrap`
    : '95% CI unavailable without embedded trials'
  const overheadPct = hero.tokenOverheadRatio === null ? null : (hero.tokenOverheadRatio - 1) * 100
  const overheadSub = hero.tokenOverheadRatio === null
    ? 'token totals unavailable'
    : `${hero.treatment}/off token spend ${overheadPct >= 0 ? '+' : ''}${overheadPct.toFixed(1)}% (${formatTokens(off?.totalTokens ?? NaN)} → ${formatTokens(treatment?.totalTokens ?? NaN)})`
  return h('div', { class: 'hero' },
    heroTile('Comparison verdict',
      gradeChip(hero.grade, `Δ accuracy ${formatSignedPct(hero.deltaAccuracy)} · McNemar ${formatP(hero.mcnemarP)}`),
      `${data.experiment} · ${hero.treatment} vs off across ${data.tasks.length} tasks`),
    heroTile('Δ accuracy',
      h('span', { class: hero.deltaAccuracy > 0 ? 'pos' : hero.deltaAccuracy < 0 ? 'neg' : '', text: formatSignedPct(hero.deltaAccuracy) }),
      ciText),
    heroTile('McNemar',
      formatP(hero.mcnemarP),
      `wins ${hero.wins} · losses ${hero.losses} · ties ${hero.ties}`),
    heroTile('Token overhead',
      formatRatio(hero.tokenOverheadRatio),
      overheadSub))
}

/**
 * Format a nullable mean or rate for the arms table.
 * @param {number | null | undefined} v - value.
 * @param {'pct' | 'fixed' | 'int'} kind - display kind.
 * @returns {string}
 */
function formatNullable(v, kind) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (kind === 'pct') return formatPct(v)
  if (kind === 'int') return formatInt(v)
  return v.toFixed(1)
}

/**
 * Render the Summary route: one hero comparison banner per treatment arm,
 * stat cards with sparklines, and the per-arm headline table with inline CI
 * bars plus forensics and compaction columns.
 * @param {HTMLElement} root - container to fill.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {void}
 */
export function renderSummary(root, data) {
  const rows = summaryRows(data)
  const heroes = heroList(data)
  const colors = armColorMap(data)
  const totalTrials = data.arms.reduce((n, a) => n + a.trials, 0)
  const sparks = sparkSeries(data)
  const withColors = (/** @type {{ name: string, values: number[] }[]} */ series) => series.map(s => ({ ...s, color: colors.get(s.name) ?? 'var(--muted)' }))
  const off = rows.find(r => r.arm === 'off')
  const firstTreatment = rows.find(r => r.arm !== 'off')

  const accuracySpark = sparks.accuracy.some(s => s.values.length > 0)
    ? sparkline({ series: withColors(sparks.accuracy), yMin: 0, yMax: 1, formatValue: v => formatPct(v, 0) })
    : null
  const tokenSpark = sparks.tokens.some(s => s.values.length > 0)
    ? sparkline({ series: withColors(sparks.tokens), formatValue: formatTokens })
    : null

  root.append(
    h('h2', { text: 'Summary' }),
    ...heroes.map(hero => comparisonHero(data, hero, rows)),
    h('div', { class: 'cards' },
      card('Experiment', data.experiment, `${data.tasks.length} tasks · ${totalTrials} trials · ${data.arms.length} arms`),
      card('Generated', data.generatedAt.replace('T', ' ').slice(0, 19)),
      card('Accuracy trend', off && firstTreatment ? `${formatPct(off.accuracy)} → ${formatPct(firstTreatment.accuracy)}` : '—', accuracySpark, 'cumulative pass rate per arm, trials in start order'),
      card('Tokens per trial', off && firstTreatment ? `${formatTokens(off.totalTokens)} → ${formatTokens(firstTreatment.totalTokens)}` : '—', tokenSpark, 'total input+output per arm; line = per-trial spend')),
    h('h3', { text: 'Arms' }),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'headline' },
        h('thead', {},
          h('tr', {},
            h('th', { scope: 'col', text: 'Arm' }),
            h('th', { scope: 'col', class: 'num', text: 'Accuracy ± stderr' }),
            h('th', { scope: 'col', class: 'num', text: 'Wilson 95% CI' }),
            h('th', { scope: 'col', class: 'num', text: 'Total tokens' }),
            h('th', { scope: 'col', class: 'num', text: 'Mean turns' }),
            h('th', { scope: 'col', class: 'num', text: 'Duration' }),
            h('th', { scope: 'col', class: 'num', text: 'Δ vs off' }),
            h('th', { scope: 'col', class: 'num', text: 'Dangling' }),
            h('th', { scope: 'col', class: 'num', text: 'Verified CP' }),
            h('th', { scope: 'col', class: 'num', text: 'SQ calls' }),
            h('th', { scope: 'col', class: 'num', text: 'Noop notes' }),
            h('th', { scope: 'col', class: 'num', text: 'Compactions' }),
            h('th', { scope: 'col', class: 'num', text: 'Pressure' }))),
        h('tbody', {},
          rows.map(a => h('tr', {},
            h('th', { scope: 'row' }, h('span', { class: 'dot', style: `background:${colors.get(a.arm)}` }), a.arm),
            h('td', { class: 'num', text: `${formatPct(a.accuracy)} ± ${formatPct(a.stderr)}` }),
            h('td', { class: 'num' },
              h('div', { class: 'ci-cell' },
                h('span', { class: 'ci-text', text: `${formatPct(a.ci95[0])} – ${formatPct(a.ci95[1])}` }),
                ciBar(a.accuracy, a.ci95))),
            h('td', { class: 'num', title: `${formatInt(a.totalInputTokens)} in · ${formatInt(a.totalOutputTokens)} out`, text: formatTokens(a.totalTokens) }),
            h('td', { class: 'num', text: Number.isFinite(a.meanTurns) ? a.meanTurns.toFixed(1) : '—' }),
            h('td', { class: 'num', text: formatMs(a.totalDurationMs) }),
            h('td', { class: `num ${a.deltaVsOff === null ? 'mut' : a.deltaVsOff > 0 ? 'pos' : a.deltaVsOff < 0 ? 'neg' : 'mut'}`, text: formatSignedPct(a.deltaVsOff) }),
            h('td', { class: 'num', text: formatNullable(a.meanDanglingCard, 'pct') }),
            h('td', { class: 'num', text: formatNullable(a.meanVerifiedCheckpointShare, 'pct') }),
            h('td', { class: 'num', text: formatNullable(a.meanSessionQueryCalls, 'fixed') }),
            h('td', { class: 'num', text: formatNullable(a.totalNoopNoteRefusals, 'int') }),
            h('td', { class: 'num', text: formatNullable(a.totalCompactionCount, 'int') }),
            h('td', { class: 'num', text: formatNullable(a.pressureFiredRate, 'pct') })))))),
    h('p', { class: 'note', text: 'Accuracy = resolved / success-status trials; infrastructure-error trials are excluded. Intervals are Wilson 95%. Forensics columns are means or totals over those same trials; a dash means the arm excludes the metric.' }))
}

/**
 * Render the Matrix route: tasks grouped by stratum × arms, heat-colored pass
 * rates, a pooled subtotal row per stratum, and a chain badge on multi-session
 * tasks; clicking a cell jumps to the Trials route filtered to that pair.
 * @param {HTMLElement} root - container to fill.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @param {{ navigate: (hash: string) => void }} ctx - router.
 * @returns {void}
 */
export function renderMatrix(root, data, ctx) {
  const arms = data.arms.map(a => a.arm)
  const colors = armColorMap(data)
  const strata = matrixRows(data)

  const cellFor = (task, entry, best) => {
    if (!entry.cell || entry.cell.trials === 0) {
      return h('td', { class: 'cellwrap' }, h('span', { class: 'cell missing', title: `${task.taskId} × ${entry.arm}: no data`, text: '—' }))
    }
    const c = entry.cell
    const errors = c.errors > 0 ? `, ${c.errors} error trial${c.errors > 1 ? 's' : ''}` : ''
    return h('td', { class: 'cellwrap' },
      h('button', {
        class: `cell${best ? ' best' : ''}`,
        style: `background:${heatColor(c.passRate) ?? 'var(--surface-2)'}`,
        title: `${task.taskId} × ${entry.arm}: ${formatPct(c.passRate)} (${c.resolved}/${c.trials}${errors}); 95% CI ${formatPct(c.ci95[0])} – ${formatPct(c.ci95[1])}. Click for trials.`,
        onclick: () => ctx.navigate(buildHash('trials', { task: task.taskId, arm: entry.arm })),
      },
      h('span', { class: 'rate', text: formatPct(c.passRate, 0) }),
      h('span', { class: 'mn', text: `${c.resolved}/${c.trials}` })))
  }

  const subtotalCell = (stratum, s) => {
    if (s.trials === 0) return h('td', { class: 'cellwrap' }, h('span', { class: 'cell missing', text: '—' }))
    return h('td', { class: 'cellwrap' },
      h('span', {
        class: 'cell sub',
        style: `background:${heatColor(s.passRate) ?? 'var(--surface-2)'}`,
        title: `${stratum} × ${s.arm} pooled: ${formatPct(s.passRate)} (${s.resolved}/${s.trials}); 95% CI ${formatPct(s.ci95[0])} – ${formatPct(s.ci95[1])}`,
      },
      h('span', { class: 'rate', text: formatPct(s.passRate, 0) }),
      h('span', { class: 'mn', text: `${s.resolved}/${s.trials}` })))
  }

  root.append(
    h('h2', { text: 'Matrix' }),
    h('table', { class: 'matrix' },
      h('thead', {},
        h('tr', {},
          h('th', { scope: 'col', text: 'Task' }),
          arms.map(arm => h('th', { scope: 'col' }, h('span', { class: 'dot', style: `background:${colors.get(arm)}` }), arm)))),
      h('tbody', {},
        strata.flatMap(({ stratum, rows, subtotal }) => [
          h('tr', { class: 'stratum', dataset: { stratum } }, h('th', { colspan: String(arms.length + 1), scope: 'colgroup', text: `${stratum} — ${rows.length} task${rows.length > 1 ? 's' : ''}` })),
          ...rows.map(({ task, entries, best }) => h('tr', {},
            h('th', { scope: 'row' },
              h('div', { class: 'taskhead' },
                h('div', { class: 'desc', text: task.description }),
                h('div', { class: 'badges' },
                  h('span', { class: 'id', text: task.taskId }),
                  task.stratum === 'chain'
                    ? h('span', { class: 'badge badge-chain', title: 'multi-session task: each trial runs as a chain of resumed phases', text: '⟲ chain' })
                    : null,
                  task.stratum === 'pressure'
                    ? h('span', { class: 'badge badge-pressure', title: 'memory-pressure task: global rules or recorded values must survive a long stretch of work', text: 'pressure' })
                    : null))),
            entries.map(entry => cellFor(task, entry, best === entry.arm)))),
          h('tr', { class: 'subtotal' },
            h('th', { scope: 'row', text: `${stratum} subtotal` }),
            subtotal.map(s => subtotalCell(stratum, s))),
        ]))),
    h('p', { class: 'note', text: 'Cell = pass rate with resolved/trials. Bold marks the best arm when its Wilson interval excludes every other arm’s point estimate. Subtotal rows pool the stratum’s trials per arm. Click a task cell for its trials.' }))
}

/**
 * One chart section.
 * @param {string} title - heading.
 * @param {string} caption - one-line reading guide.
 * @param {SVGElement} chart - chart element.
 * @param {boolean} [wide] - span the full grid width.
 * @returns {HTMLElement}
 */
function chartSection(title, caption, chart, wide = false) {
  return h('section', { class: `chart${wide ? ' wide' : ''}` },
    h('h3', { text: title }),
    h('p', { class: 'caption', text: caption }),
    chart)
}

/**
 * Chain-phase section: a chain-task picker plus per-phase mean input tokens
 * and duration, grouped by arm. The selection lives in the hash query
 * (`phaseTask`) so the view is shareable.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @param {(spec: { series: { name: string }[] }) => any} withColors - attach arm colors to a spec.
 * @param {{ navigate: (hash: string, opts?: { replace?: boolean }) => void }} ctx - router.
 * @param {URLSearchParams} params - current hash query.
 * @returns {HTMLElement}
 */
function phaseSection(data, withColors, ctx, params) {
  const chains = chainTasks(data)
  const wanted = params.get('phaseTask')
  const taskId = chains.some(t => t.taskId === wanted) ? /** @type {string} */ (wanted) : chains[0].taskId
  const picker = h('label', { class: 'picker' }, 'Chain task',
    h('select', {
      name: 'phaseTask',
      onchange: (/** @type {Event} */ e) => ctx.navigate(buildHash('charts', { phaseTask: /** @type {HTMLSelectElement} */ (e.target).value }), { replace: true }),
    },
    chains.map(t => h('option', { value: t.taskId, ...(t.taskId === taskId ? { selected: '' } : {}), text: t.taskId }))))
  const tokens = phaseSpec(data, taskId, 'inputTokens')
  const duration = phaseSpec(data, taskId, 'durationMs')
  return h('section', { class: 'chart wide', dataset: { section: 'phases' } },
    h('h3', { text: 'Chain phases' }),
    h('p', { class: 'caption', text: 'Per-phase means over trials with a phase breakdown; a phase no trial reached draws no bar.' }),
    picker,
    h('div', { class: 'phase-grid' },
      h('div', {},
        h('h4', { text: 'Input tokens per phase' }),
        groupedBarChart({ ...withColors(tokens), yLabel: 'input tokens', formatValue: formatTokens })),
      h('div', {},
        h('h4', { text: 'Duration per phase' }),
        groupedBarChart({ ...withColors(duration), yLabel: 'duration', formatValue: formatMs }))))
}

/**
 * Render the Charts route: grouped bars per task, paired scatters (pass rate
 * and tokens), per-stratum radar, the per-task delta chart, and — when the
 * payload has chain tasks — the per-phase breakdown for a selected chain task.
 * @param {HTMLElement} root - container to fill.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @param {{ navigate: (hash: string, opts?: { replace?: boolean }) => void }} ctx - router.
 * @param {URLSearchParams} params - current hash query.
 * @returns {void}
 */
export function renderCharts(root, data, ctx, params) {
  const colors = armColorMap(data)
  const withColors = (/** @type {{ series: { name: string }[] }} */ spec) => ({
    ...spec,
    series: spec.series.map(s => ({ ...s, color: colors.get(s.name) ?? 'var(--muted)' })),
  })

  const sections = []
  if (data.cells.length === 0) {
    root.append(h('h2', { text: 'Charts' }), h('p', { class: 'note', text: 'No aggregate cells in this payload.' }))
    return
  }
  sections.push(chartSection(
    'Pass rate by task',
    'Whiskers: Wilson 95% interval.',
    groupedBarChart({ ...withColors(barsSpec(data)), yLabel: 'pass rate', yMax: 1, formatValue: v => formatPct(v, 0) }),
    true))

  for (const comparison of comparisonList(data)) {
    const rate = scatterSpec(data, 'passRate', comparison.treatment)
    const tokens = scatterSpec(data, 'tokens', comparison.treatment)
    if (rate.points.length > 0) {
      sections.push(chartSection(`Paired pass rate · ${comparison.treatment}`, `One point per task; above the diagonal means ${comparison.treatment} beats off.`, pairedScatter(rate)))
    }
    if (tokens.points.length > 0) {
      sections.push(chartSection(`Paired mean tokens · ${comparison.treatment}`, `Same pairing, mean input+output tokens per task.`, pairedScatter(tokens)))
    }
  }
  const radar = radarSpec(data)
  if (radar.axes.length > 0) {
    sections.push(chartSection('Pass rate by stratum', 'Tasks pooled per stratum, including pressure.', radarChart(withColors(radar))))
  }
  for (const comparison of comparisonList(data)) {
    if (comparison.pairs.length === 0) continue
    sections.push(chartSection(
      `Per-task pass-rate delta · ${comparison.treatment}`,
      `Delta = ${comparison.treatment} − off; whiskers: paired bootstrap 95% interval.`,
      deltaChart(deltaSpec(data, comparison)),
      true))
  }
  if (chainTasks(data).length > 0) {
    sections.push(phaseSection(data, withColors, ctx, params))
  }
  root.append(h('h2', { text: 'Charts' }), h('div', { class: 'chart-grid' }, sections))
}

/** Trials table columns: [sort key, header label, numeric]. */
const TRIAL_COLUMNS = /** @type {[keyof typeof TRIAL_SORTS, string, boolean][]} */ ([
  ['arm', 'Arm', false],
  ['task', 'Task', false],
  ['trial', '#', true],
  ['outcome', 'Outcome', false],
  ['failure', 'Failure mode', false],
  ['tokens', 'Tokens', true],
  ['turns', 'Turns', true],
  ['duration', 'Duration', true],
])

/**
 * Per-phase breakdown table for a chain trial's expander.
 * @param {NonNullable<ReturnType<typeof phasesOf>>} phases - phase records.
 * @returns {HTMLElement}
 */
function phaseTable(phases) {
  const maxTokens = Math.max(1, ...phases.map(p => p.metrics.inputTokens + p.metrics.outputTokens))
  return h('div', { class: 'phases' },
    h('div', { class: 'k', text: `phases (${phases.length})` }),
    h('table', { class: 'phase-table' },
      h('thead', {},
        h('tr', {},
          h('th', { scope: 'col', class: 'num', text: 'Phase' }),
          h('th', { scope: 'col', text: 'Resumed from' }),
          h('th', { scope: 'col', text: 'Tokens in · out' }),
          h('th', { scope: 'col', class: 'num', text: 'Turns' }),
          h('th', { scope: 'col', class: 'num', text: 'Duration' }),
          h('th', { scope: 'col', class: 'num', text: 'Exit' }),
          h('th', { scope: 'col', text: 'Timed out' }))),
      h('tbody', {},
        phases.map(p => h('tr', {},
          h('td', { class: 'num', text: String(p.phaseIndex + 1) }),
          h('td', {}, p.resumedFrom ? h('code', { text: p.resumedFrom }) : h('code', { class: 'mut', text: 'cold' })),
          h('td', {},
            h('span', { class: 'tokenbar' }, h('span', { style: `width:${(((p.metrics.inputTokens + p.metrics.outputTokens) / maxTokens) * 100).toFixed(1)}%` })),
            `${formatInt(p.metrics.inputTokens)} · ${formatInt(p.metrics.outputTokens)}`),
          h('td', { class: 'num', text: String(p.metrics.turns) }),
          h('td', { class: 'num', text: formatMs(p.metrics.durationMs) }),
          h('td', { class: `num ${p.exitCode === 0 ? 'pos' : 'neg'}`, text: String(p.exitCode) }),
          h('td', { class: p.timedOut ? 'neg' : 'mut', text: p.timedOut ? 'yes' : 'no' }))))))
}

/**
 * Render the Trials route: filter bar (arm / task / outcome, kept in the hash
 * query) over every trial in the payload, sortable columns (sort state in the
 * hash), an integrity badge on flagged trials, and an expander with verifier,
 * session, and per-phase details.
 * @param {HTMLElement} root - container to fill.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @param {{ navigate: (hash: string, opts?: { replace?: boolean }) => void }} ctx - router.
 * @param {URLSearchParams} params - current hash query.
 * @returns {void}
 */
export function renderTrials(root, data, ctx, params) {
  const trials = trialList(data)
  root.append(h('h2', { text: 'Trials' }))
  if (trials.length === 0) {
    root.append(h('p', { class: 'note', text: 'This payload carries no trial-level records, so the Trials table is unavailable. Rebuild bench/ui/data.js with bench/report/build.js to embed them.' }))
    return
  }

  const filters = {
    arm: params.get('arm') ?? '',
    task: params.get('task') ?? '',
    outcome: params.get('outcome') ?? '',
    stratum: params.get('stratum') ?? '',
  }
  const sort = params.get('sort') ?? ''
  const dir = params.get('dir') ?? ''
  const select = (/** @type {string} */ name, /** @type {string} */ label, /** @type {[string, string][]} */ options) => h('label', {}, label,
    h('select', {
      name,
      onchange: (/** @type {Event} */ e) => ctx.navigate(buildHash('trials', { ...filters, sort, dir, [name]: /** @type {HTMLSelectElement} */ (e.target).value }), { replace: true }),
    },
    options.map(([value, text]) => h('option', { value, ...(value === filters[/** @type {'arm' | 'task' | 'outcome' | 'stratum'} */ (name)] ? { selected: '' } : {}), text }))))

  root.append(h('div', { class: 'filterbar' },
    select('arm', 'Arm', [['', 'all arms'], ...data.arms.map(a => /** @type {[string, string]} */ ([a.arm, a.arm]))]),
    select('task', 'Task', [['', 'all tasks'], ...data.tasks.map(t => /** @type {[string, string]} */ ([t.taskId, t.taskId]))]),
    select('stratum', 'Stratum', [['', 'all strata'], ...strataOf(data.tasks).map(s => /** @type {[string, string]} */ ([s, s]))]),
    select('outcome', 'Outcome', [['', 'all outcomes'], ['resolved', 'resolved'], ['failed', 'failed'], ['error', 'error']])))

  const rows = filterTrials(trials, { ...filters, tasks: data.tasks, sort, dir })
  const bar = root.querySelector('.filterbar')
  bar?.append(h('span', { class: 'count', text: `${rows.length} of ${trials.length} trials` }))

  const outcomeOf = (/** @type {import('../schema/trial.js').Trial} */ t) => (t.status === 'error' ? ['error', 'error'] : t.resolved ? ['resolved', 'resolved'] : ['failed', 'failed'])
  const detailItem = (/** @type {string} */ k, /** @type {Node | string} */ v) => h('div', {}, h('div', { class: 'k', text: k }), h('div', { class: 'v' }, v))

  const sortHeader = (/** @type {keyof typeof TRIAL_SORTS} */ key, /** @type {string} */ label, /** @type {boolean} */ numeric) => {
    const active = sort === key && (dir === 'asc' || dir === 'desc') ? dir : ''
    const next = active === 'asc' ? 'desc' : active === 'desc' ? '' : 'asc'
    return h('th', {
      scope: 'col',
      class: `sortable${numeric ? ' num' : ''}`,
      'aria-sort': active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none',
    },
    h('button', {
      class: `sort${active ? ` ${active}` : ''}`,
      title: active === 'asc' ? `sort ${label} descending` : active === 'desc' ? `clear ${label} sort` : `sort ${label} ascending`,
      onclick: () => ctx.navigate(buildHash('trials', { ...filters, sort: next ? key : '', dir: next }), { replace: true }),
    },
    label,
    h('span', { class: 'arrow', 'aria-hidden': 'true', text: active === 'asc' ? '↑' : active === 'desc' ? '↓' : '↕' })))
  }

  const body = h('tbody', {})
  for (const t of rows) {
    const [outcomeClass, outcomeText] = outcomeOf(t)
    const violations = integrityViolations(t)
    const phases = phasesOf(t)
    const caret = h('button', { class: 'caret', 'aria-expanded': 'false', 'aria-label': `details for ${t.taskId} trial ${t.trialIndex} (${t.arm})`, text: '▸' })
    const detail = h('tr', { class: 'detail', hidden: '' },
      h('td', { colspan: '9' },
        h('div', { class: 'detail-grid' },
          detailItem('verifier', h('code', { text: t.verifier.command })),
          detailItem('exit code', String(t.verifier.exitCode)),
          detailItem('verifier detail', t.verifier.detail ?? '—'),
          detailItem('session file', t.sessionFile ? h('code', { text: t.sessionFile }) : '—'),
          detailItem('tokens', `${formatInt(t.metrics.inputTokens)} in · ${formatInt(t.metrics.outputTokens)} out`),
          detailItem('loop', `${formatMs(t.metrics.durationMs)} · ${t.metrics.turns} turns · ${t.metrics.toolCalls} tool calls · ${t.metrics.identicalRetries} identical retries`),
          detailItem('jspace', `${t.metrics.checkpoints} checkpoints · ${t.metrics.shipPasses} ship passes · dangling ${t.metrics.danglingCard === null ? '—' : t.metrics.danglingCard ? 'yes' : 'no'}`),
          detailItem('forensics', `verified ${t.metrics.verifiedCheckpointShare === null ? '—' : formatPct(t.metrics.verifiedCheckpointShare)} · noop notes ${t.metrics.noopNoteRefusals} · SQ ${t.metrics.sessionQueryCalls === null ? '—' : t.metrics.sessionQueryCalls}`),
          detailItem('compaction', `${t.metrics.compactionCount} compact · pressure ${t.metrics.pressureFired ? 'yes' : 'no'}`),
          violations.length > 0
            ? detailItem('integrity', violations.map(v => h('div', { class: 'neg', text: `⚠ ${v}` })))
            : null),
        phases ? phaseTable(phases) : null))
    const toggle = () => {
      const open = detail.hasAttribute('hidden')
      detail.toggleAttribute('hidden', !open)
      caret.setAttribute('aria-expanded', String(open))
      caret.textContent = open ? '▾' : '▸'
    }
    caret.addEventListener('click', (e) => {
      e.stopPropagation()
      toggle()
    })
    body.append(
      h('tr', { class: `clickable${violations.length > 0 ? ' flagged' : ''}`, onclick: toggle },
        h('td', {}, caret),
        h('td', {}, h('span', { class: 'dot', style: `background:${armColorMap(data).get(t.arm) ?? 'var(--muted)'}` }), t.arm),
        h('td', { class: 'mono', text: t.taskId }),
        h('td', { class: 'num', text: String(t.trialIndex) }),
        h('td', {}, h('span', { class: `outcome-${outcomeClass}`, text: outcomeText }),
          violations.length > 0
            ? h('span', { class: 'badge badge-warn', title: violations.join('\n'), text: `⚠ integrity` })
            : null),
        h('td', { class: t.failureMode ? '' : 'mut', text: t.failureMode ?? '—' }),
        h('td', { class: 'num', title: `${formatInt(t.metrics.inputTokens)} in · ${formatInt(t.metrics.outputTokens)} out`, text: formatTokens(t.metrics.inputTokens + t.metrics.outputTokens) }),
        h('td', { class: 'num', text: String(t.metrics.turns) }),
        h('td', { class: 'num', text: formatMs(t.metrics.durationMs) })),
      detail)
  }

  root.append(h('table', {},
    h('thead', {},
      h('tr', {},
        h('th', { scope: 'col', 'aria-label': 'expand' }),
        TRIAL_COLUMNS.map(([key, label, numeric]) => sortHeader(key, label, numeric)))),
    body))
}

/**
 * Render the empty state used when data.js did not load a payload.
 * @param {HTMLElement} root - container to fill.
 * @returns {void}
 */
export function renderEmptyState(root) {
  root.append(h('section', { class: 'empty' },
    h('h2', { text: 'No report data' }),
    h('p', { text: 'This page renders the generated payload bench/ui/data.js, which is not loaded.' }),
    h('p', { text: 'Create it with:' }),
    h('pre', { text: 'node bench/demo/generate.js && node bench/report/build.js' }),
    h('p', { text: 'Then reload this page, or serve the report with node bench/report/serve.js.' })))
}
