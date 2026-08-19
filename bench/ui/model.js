/**
 * Pure derivations from a ReportData payload for the four report views, plus
 * hash-route and formatting helpers. No DOM or browser globals, so the node
 * tests import this module directly.
 *
 * The Trials view reads `data.trials`, an array of schema Trial records.
 * ReportData does not declare that field, but validateReportData permits extra
 * properties and report/build.js embeds the validated trials; a payload
 * without them renders an explanatory note instead of the table.
 *
 * Trials may optionally carry `phases` (per-phase breakdown of a chain trial)
 * and `integrity` ({ violations: string[] }); every derivation here tolerates
 * their absence.
 *
 * @module bench/ui/model
 */

/** Report routes in nav order. */
export const VIEWS = Object.freeze(['summary', 'matrix', 'charts', 'trials'])

const STRATUM_ORDER = ['long', 'short', 'adversarial', 'chain']

// Numeric mirrors of the --heat-* anchors in styles.css; interpolating a
// gradient needs channels, which CSS custom properties cannot provide in JS.
const HEAT_BAD = [248, 113, 113]
const HEAT_MID = [251, 191, 36]
const HEAT_GOOD = [52, 211, 153]

// The hero's delta CI and the matrix subtotals reuse the suite's statistics.
// serve.js roots the static report at bench/ui, so the browser cannot import
// bench/stats across directories; the seeded PRNG, the paired bootstrap, the
// Wilson interval, and the outcome pairing are mirrored here and must stay
// algorithm-equivalent to bench/stats/{intervals,paired}.js.
const BOOTSTRAP_RESAMPLES = 1000

/**
 * Seeded PRNG (mulberry32), mirroring bench/stats/intervals.js.
 * @param {number} seed - equal seeds produce equal streams.
 * @returns {() => number} generator of uniform floats in [0, 1).
 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Wilson score interval for a binomial proportion, mirroring
 * bench/stats/intervals.js.
 * @param {number} k - successes.
 * @param {number} n - trials.
 * @returns {[number, number]} [lower, upper] within [0, 1]; [0, 1] when n = 0.
 */
function wilsonInterval(k, n) {
  if (n === 0) return [0, 1]
  const z = 1.96
  const p = k / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

/**
 * Paired bootstrap interval for a pass-rate delta, mirroring
 * bench/stats/intervals.js: resample whole pairs with replacement.
 * @param {{ off: boolean, on: boolean }[]} pairs - matched trial outcomes.
 * @returns {[number, number]} [lower, upper]; [NaN, NaN] for empty input.
 */
function bootstrapDeltaCi(pairs) {
  if (pairs.length === 0) return [NaN, NaN]
  const rng = mulberry32(1)
  const estimates = []
  for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) {
    let sum = 0
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[Math.floor(rng() * pairs.length)]
      sum += Number(p.on) - Number(p.off)
    }
    estimates.push(sum / pairs.length)
  }
  estimates.sort((a, b) => a - b)
  return [estimates[Math.floor(0.025 * BOOTSTRAP_RESAMPLES)], estimates[Math.ceil(0.975 * BOOTSTRAP_RESAMPLES) - 1]]
}

/**
 * Match two arms' trials on taskId+trialIndex and count paired outcomes from
 * the `on` arm's perspective, mirroring bench/stats/paired.js.
 * @param {import('../schema/trial.js').Trial[]} offTrials - baseline arm.
 * @param {import('../schema/trial.js').Trial[]} onTrials - intervention arm.
 * @returns {{ pairs: { off: boolean, on: boolean }[], wins: number, losses: number, ties: number }}
 */
function pairOutcomes(offTrials, onTrials) {
  const baseline = new Map()
  for (const t of offTrials) {
    if (t.status === 'success') baseline.set(JSON.stringify([t.taskId, t.trialIndex]), t.resolved)
  }
  const pairs = []
  for (const t of onTrials) {
    if (t.status !== 'success') continue
    const key = JSON.stringify([t.taskId, t.trialIndex])
    if (!baseline.has(key)) continue
    pairs.push({ off: baseline.get(key), on: t.resolved })
    baseline.delete(key)
  }
  return {
    pairs,
    wins: pairs.filter(p => p.on && !p.off).length,
    losses: pairs.filter(p => !p.on && p.off).length,
    ties: pairs.filter(p => p.on === p.off).length,
  }
}

/**
 * Distinct strata in report order: long, short, adversarial, chain, then any
 * extras.
 * @param {{ stratum: string }[]} tasks - report task catalog.
 * @returns {string[]}
 */
export function strataOf(tasks) {
  const seen = [...new Set(tasks.map(t => t.stratum))]
  return [
    ...STRATUM_ORDER.filter(s => seen.includes(s)),
    ...seen.filter(s => !STRATUM_ORDER.includes(s)).sort(),
  ]
}

/**
 * Lookup key for one task×arm cell.
 * @param {string} taskId
 * @param {string} arm
 * @returns {string}
 */
export function cellKey(taskId, arm) {
  return `${taskId} ${arm}`
}

/**
 * Index report cells by task×arm.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {Map<string, import('../schema/report-data.js').ReportCell>}
 */
export function cellMap(data) {
  return new Map(data.cells.map(c => [cellKey(c.taskId, c.arm), c]))
}

/**
 * Arm → CSS color reference. `off` and `on` are pinned to their palette
 * entries; further arms cycle the four extras in report order.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {Map<string, string>}
 */
export function armColorMap(data) {
  const map = new Map()
  let extra = 0
  for (const { arm } of data.arms) {
    if (arm === 'off') map.set(arm, 'var(--arm-off)')
    else if (arm === 'on') map.set(arm, 'var(--arm-on)')
    else map.set(arm, `var(--arm-x${(extra++ % 4) + 1})`)
  }
  return map
}

/**
 * Interpolate the outcome scale (bad→mid→good anchors) for a pass rate.
 * @param {number} rate - pass rate in [0, 1].
 * @returns {string | null} - `rgb(r g b)` string, or null when rate is not finite.
 */
export function heatColor(rate) {
  if (!Number.isFinite(rate)) return null
  const t = Math.min(Math.max(rate, 0), 1) * 2
  const i = Math.min(1, Math.floor(t))
  const f = t - i
  const a = [HEAT_BAD, HEAT_MID][i]
  const b = [HEAT_MID, HEAT_GOOD][i]
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(' ')})`
}

/**
 * Per-arm headline rows with derived totals and the accuracy delta vs `off`.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {(import('../schema/report-data.js').ReportArmSummary & { totalTokens: number, deltaVsOff: number | null })[]}
 */
export function summaryRows(data) {
  const off = data.arms.find(a => a.arm === 'off')
  return data.arms.map(a => ({
    ...a,
    totalTokens: a.totalInputTokens + a.totalOutputTokens,
    deltaVsOff: off && a.arm !== 'off' ? a.accuracy - off.accuracy : null,
  }))
}

/**
 * Hero-banner statistics for the off/on comparison: the payload's grade and
 * McNemar p, plus a paired bootstrap interval on the accuracy delta and the
 * discordance counts recomputed from embedded trials. Without trials the
 * interval is null and the counts fall back to summing data.pairs.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {{ grade: string, deltaAccuracy: number, deltaCi95: [number, number] | null, mcnemarP: number | null, tokenOverheadRatio: number | null, wins: number, losses: number, ties: number }}
 */
export function heroStats(data) {
  const cmp = data.comparison
  const off = data.arms.find(a => a.arm === 'off')
  const on = data.arms.find(a => a.arm === 'on')
  const offTokens = off ? off.totalInputTokens + off.totalOutputTokens : 0
  const onTokens = on ? on.totalInputTokens + on.totalOutputTokens : 0
  const tokenOverheadRatio = off && on && offTokens > 0 ? onTokens / offTokens : null
  const trials = trialList(data)
  const offTrials = trials.filter(t => t.arm === 'off')
  const onTrials = trials.filter(t => t.arm === 'on')
  if (offTrials.length > 0 && onTrials.length > 0) {
    const { pairs, wins, losses, ties } = pairOutcomes(offTrials, onTrials)
    const ci = bootstrapDeltaCi(pairs)
    return {
      grade: cmp.grade,
      deltaAccuracy: cmp.deltaAccuracy,
      deltaCi95: Number.isFinite(ci[0]) && Number.isFinite(ci[1]) ? ci : null,
      mcnemarP: cmp.mcnemarP,
      tokenOverheadRatio,
      wins,
      losses,
      ties,
    }
  }
  return {
    grade: cmp.grade,
    deltaAccuracy: cmp.deltaAccuracy,
    deltaCi95: null,
    mcnemarP: cmp.mcnemarP,
    tokenOverheadRatio,
    wins: data.pairs.reduce((n, p) => n + p.wins, 0),
    losses: data.pairs.reduce((n, p) => n + p.losses, 0),
    ties: data.pairs.reduce((n, p) => n + p.ties, 0),
  }
}

/**
 * Per-arm sparkline series over the arm's success-status trials, ordered by
 * start time: cumulative accuracy after each trial, and per-trial total
 * tokens. Empty series when the payload carries no trials.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {{ accuracy: { name: string, values: number[] }[], tokens: { name: string, values: number[] }[] }}
 */
export function sparkSeries(data) {
  const arms = data.arms.map(a => a.arm)
  const accuracy = []
  const tokens = []
  for (const arm of arms) {
    const ok = trialList(data)
      .filter(t => t.arm === arm && t.status === 'success')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.taskId.localeCompare(b.taskId) || a.trialIndex - b.trialIndex)
    let resolved = 0
    accuracy.push({ name: arm, values: ok.map((t, i) => { resolved += t.resolved ? 1 : 0; return resolved / (i + 1) }) })
    tokens.push({ name: arm, values: ok.map(t => t.metrics.inputTokens + t.metrics.outputTokens) })
  }
  return { accuracy, tokens }
}

/**
 * The arm to bold in one matrix row: the unique top pass rate whose Wilson
 * interval excludes every other arm's point estimate, else null.
 * @param {{ arm: string, cell: import('../schema/report-data.js').ReportCell | null }[]} entries - one entry per arm.
 * @returns {string | null}
 */
function bestArm(entries) {
  const withData = entries.filter(e => e.cell && e.cell.trials > 0 && Number.isFinite(e.cell.passRate))
  if (withData.length < 2) return null
  const top = withData.reduce((a, b) => (/** @type {import('../schema/report-data.js').ReportCell} */ (b.cell).passRate > /** @type {import('../schema/report-data.js').ReportCell} */ (a.cell).passRate ? b : a))
  const topRate = /** @type {import('../schema/report-data.js').ReportCell} */ (top.cell).passRate
  if (withData.filter(e => /** @type {import('../schema/report-data.js').ReportCell} */ (e.cell).passRate === topRate).length > 1) return null
  const excludes = withData.every(e => e === top || /** @type {import('../schema/report-data.js').ReportCell} */ (top.cell).ci95[0] > /** @type {import('../schema/report-data.js').ReportCell} */ (e.cell).passRate)
  return excludes ? top.arm : null
}

/**
 * Pool one stratum's cells per arm into a subtotal: summed resolved/trials
 * with a fresh Wilson interval on the pooled rate.
 * @param {import('../schema/report-data.js').ReportCell[]} cells - cells of one stratum.
 * @param {string[]} arms - arm names in report order.
 * @returns {{ arm: string, trials: number, errors: number, resolved: number, passRate: number, ci95: [number, number] }[]}
 */
function poolStratum(cells, arms) {
  return arms.map((arm) => {
    let trials = 0
    let errors = 0
    let resolved = 0
    for (const c of cells.filter(c => c.arm === arm)) {
      trials += c.trials
      errors += c.errors
      resolved += c.resolved
    }
    return { arm, trials, errors, resolved, passRate: trials > 0 ? resolved / trials : NaN, ci95: wilsonInterval(resolved, trials) }
  })
}

/**
 * Matrix rows grouped by stratum: each row carries one cell (or null) per arm
 * and the arm to bold, if any; each group carries a pooled per-arm subtotal.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {{ stratum: string, rows: { task: { taskId: string, stratum: string, description: string }, entries: { arm: string, cell: import('../schema/report-data.js').ReportCell | null }[], best: string | null }[], subtotal: { arm: string, trials: number, errors: number, resolved: number, passRate: number, ci95: [number, number] }[] }[]}
 */
export function matrixRows(data) {
  const cells = cellMap(data)
  const arms = data.arms.map(a => a.arm)
  return strataOf(data.tasks).map((stratum) => {
    const tasks = data.tasks.filter(t => t.stratum === stratum)
    return {
      stratum,
      rows: tasks.map((task) => {
        const entries = arms.map(arm => ({ arm, cell: cells.get(cellKey(task.taskId, arm)) ?? null }))
        return { task, entries, best: bestArm(entries) }
      }),
      subtotal: poolStratum(tasks.flatMap(t => arms.map(arm => cells.get(cellKey(t.taskId, arm))).filter(Boolean)), arms),
    }
  })
}

/**
 * Grouped-bar spec: pass rate per task, one series per arm, Wilson CI whiskers.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {{ categories: string[], series: { name: string, values: number[], ci: ([number, number] | undefined)[] }[] }}
 */
export function barsSpec(data) {
  const cells = cellMap(data)
  return {
    categories: data.tasks.map(t => t.taskId),
    series: data.arms.map(({ arm }) => ({
      name: arm,
      values: data.tasks.map((t) => {
        const c = cells.get(cellKey(t.taskId, arm))
        return c && Number.isFinite(c.passRate) ? c.passRate : NaN
      }),
      ci: data.tasks.map((t) => {
        const c = cells.get(cellKey(t.taskId, arm))
        return c && c.trials > 0 ? c.ci95 : undefined
      }),
    })),
  }
}

/**
 * Radar spec: pooled pass rate per stratum (tasks pooled, not averaged), one
 * series per arm, ring ceiling 1.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {{ axes: string[], series: { name: string, values: number[] }[], max: number }}
 */
export function radarSpec(data) {
  const cells = cellMap(data)
  const axes = strataOf(data.tasks)
  const series = data.arms.map(({ arm }) => ({
    name: arm,
    values: axes.map((stratum) => {
      let resolved = 0
      let trials = 0
      for (const task of data.tasks) {
        if (task.stratum !== stratum) continue
        const c = cells.get(cellKey(task.taskId, arm))
        if (c) {
          resolved += c.resolved
          trials += c.trials
        }
      }
      return trials > 0 ? resolved / trials : 0
    }),
  }))
  return { axes, series, max: 1 }
}

/**
 * Paired-scatter spec for one metric, off on x and on on y, one point per task
 * that has data in both arms.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @param {'passRate' | 'tokens'} metric - pass rate or mean total tokens.
 * @returns {{ points: { id: string, x: number, y: number }[], xLabel: string, yLabel: string, higherIsBetter: boolean }}
 */
export function scatterSpec(data, metric) {
  const cells = cellMap(data)
  const label = metric === 'tokens' ? 'mean tokens' : 'pass rate'
  const valueOf = (/** @type {import('../schema/report-data.js').ReportCell} */ c) => (metric === 'tokens' ? c.meanInputTokens + c.meanOutputTokens : c.passRate)
  const points = []
  for (const task of data.tasks) {
    const off = cells.get(cellKey(task.taskId, 'off'))
    const on = cells.get(cellKey(task.taskId, 'on'))
    if (!off || !on || off.trials === 0 || on.trials === 0) continue
    const x = valueOf(off)
    const y = valueOf(on)
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ id: task.taskId, x, y })
  }
  // Tokens are a cost: above the diagonal means on spent more, i.e. worse.
  return { points, xLabel: `off ${label}`, yLabel: `on ${label}`, higherIsBetter: metric !== 'tokens' }
}

/**
 * Delta-chart spec from the paired comparisons.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {{ items: { id: string, delta: number, ci: [number, number] }[], xLabel: string }}
 */
export function deltaSpec(data) {
  return {
    items: data.pairs.map(p => ({ id: p.taskId, delta: p.delta, ci: p.deltaCi95 })),
    xLabel: 'pass-rate delta (on − off)',
  }
}

/**
 * Trial records carried on the payload, or an empty list when absent.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {import('../schema/trial.js').Trial[]}
 */
export function trialList(data) {
  const extra = /** @type {{ trials?: unknown }} */ (data)
  return Array.isArray(extra.trials) ? /** @type {import('../schema/trial.js').Trial[]} */ (extra.trials) : []
}

/**
 * A trial's per-phase breakdown, or null when absent or malformed. Only the
 * fields the phase views read are checked; extra phase fields pass through.
 * @param {import('../schema/trial.js').Trial} trial - trial record.
 * @returns {({ phaseIndex: number, sessionFile: string | null, resumedFrom: string | null, exitCode: number, timedOut: boolean, metrics: import('../schema/trial.js').TrialMetrics, startedAt: string, endedAt: string }[]) | null}
 */
export function phasesOf(trial) {
  const extra = /** @type {{ phases?: unknown }} */ (trial)
  if (!Array.isArray(extra.phases) || extra.phases.length === 0) return null
  const ok = extra.phases.every(p => typeof p === 'object' && p !== null
    && typeof /** @type {{ phaseIndex?: unknown }} */ (p).phaseIndex === 'number'
    && typeof /** @type {{ metrics?: unknown }} */ (p).metrics === 'object' && /** @type {{ metrics?: unknown }} */ (p).metrics !== null)
  return ok ? /** @type {any} */ (extra.phases) : null
}

/**
 * A trial's integrity violations; empty when the trial is unflagged.
 * @param {import('../schema/trial.js').Trial} trial - trial record.
 * @returns {string[]}
 */
export function integrityViolations(trial) {
  const extra = /** @type {{ integrity?: { violations?: unknown } }} */ (trial)
  const v = extra.integrity?.violations
  return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
}

/**
 * Tasks in the chain stratum (multi-session trials with per-phase breakdowns).
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @returns {{ taskId: string, stratum: string, description: string }[]}
 */
export function chainTasks(data) {
  return data.tasks.filter(t => t.stratum === 'chain')
}

/**
 * Per-phase chart spec for one chain task: one category per phase index, one
 * series per arm, values = mean of the metric over trials carrying that phase
 * (NaN where no trial does). Only trials with a phases breakdown contribute.
 * @param {import('../schema/report-data.js').ReportData} data - report payload.
 * @param {string} taskId - chain task id.
 * @param {'inputTokens' | 'outputTokens' | 'durationMs' | 'turns'} metric - phase metric to average.
 * @returns {{ taskId: string, metric: string, categories: string[], series: { name: string, values: number[] }[] }}
 */
export function phaseSpec(data, taskId, metric) {
  const grouped = new Map(data.arms.map(a => [a.arm, /** @type {number[][]} */ ([])]))
  let phaseCount = 0
  for (const t of trialList(data)) {
    if (t.taskId !== taskId || !grouped.has(t.arm)) continue
    const phases = phasesOf(t)
    if (!phases) continue
    phaseCount = Math.max(phaseCount, phases.length)
    grouped.get(t.arm)?.push(phases.map(p => Number(p.metrics[metric])))
  }
  const categories = Array.from({ length: phaseCount }, (_, i) => `phase ${i + 1}`)
  const series = [...grouped.entries()].map(([arm, trialsPhases]) => ({
    name: arm,
    values: categories.map((_, i) => {
      const vals = trialsPhases.map(p => p[i]).filter(Number.isFinite)
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN
    }),
  }))
  return { taskId, metric, categories, series }
}

/** Outcome rank for sorting: resolved < failed < error. */
function outcomeRank(t) {
  return t.status === 'error' ? 2 : t.resolved ? 0 : 1
}

/**
 * Sortable Trials columns: key → ascending comparator. Ties always fall back
 * to the default task/trial-index/arm order inside filterTrials.
 */
export const TRIAL_SORTS = Object.freeze({
  arm: (/** @type {import('../schema/trial.js').Trial} */ a, /** @type {import('../schema/trial.js').Trial} */ b) => a.arm.localeCompare(b.arm),
  task: (/** @type {import('../schema/trial.js').Trial} */ a, /** @type {import('../schema/trial.js').Trial} */ b) => a.taskId.localeCompare(b.taskId),
  trial: (/** @type {import('../schema/trial.js').Trial} */ a, /** @type {import('../schema/trial.js').Trial} */ b) => a.trialIndex - b.trialIndex,
  outcome: (/** @type {import('../schema/trial.js').Trial} */ a, /** @type {import('../schema/trial.js').Trial} */ b) => outcomeRank(a) - outcomeRank(b),
  failure: (/** @type {import('../schema/trial.js').Trial} */ a, /** @type {import('../schema/trial.js').Trial} */ b) => (a.failureMode ?? '').localeCompare(b.failureMode ?? ''),
  tokens: (/** @type {import('../schema/trial.js').Trial} */ a, /** @type {import('../schema/trial.js').Trial} */ b) => (a.metrics.inputTokens + a.metrics.outputTokens) - (b.metrics.inputTokens + b.metrics.outputTokens),
  turns: (/** @type {import('../schema/trial.js').Trial} */ a, /** @type {import('../schema/trial.js').Trial} */ b) => a.metrics.turns - b.metrics.turns,
  duration: (/** @type {import('../schema/trial.js').Trial} */ a, /** @type {import('../schema/trial.js').Trial} */ b) => a.metrics.durationMs - b.metrics.durationMs,
})

/** Default Trials order: task, then trial index, then arm. */
function defaultTrialOrder(a, b) {
  return a.taskId.localeCompare(b.taskId) || a.trialIndex - b.trialIndex || a.arm.localeCompare(b.arm)
}

/**
 * Filter and sort trials for the Trials view. Filters: empty string /
 * undefined means no filter; outcome is resolved | failed | error. `sort` is a
 * TRIAL_SORTS key and `dir` is 'asc' | 'desc'; without a known sort key the
 * default order applies.
 * @param {import('../schema/trial.js').Trial[]} trials - all trials.
 * @param {{ arm?: string, task?: string, outcome?: string, sort?: string, dir?: string }} filters - filter and sort state.
 * @returns {import('../schema/trial.js').Trial[]}
 */
export function filterTrials(trials, { arm, task, outcome, sort, dir } = {}) {
  const cmp = sort && Object.hasOwn(TRIAL_SORTS, sort) ? TRIAL_SORTS[/** @type {keyof typeof TRIAL_SORTS} */ (sort)] : null
  const sign = dir === 'desc' ? -1 : 1
  return trials
    .filter(t => (!arm || t.arm === arm)
      && (!task || t.taskId === task)
      && (!outcome
        || (outcome === 'resolved' && t.status === 'success' && t.resolved)
        || (outcome === 'failed' && t.status === 'success' && !t.resolved)
        || (outcome === 'error' && t.status === 'error')))
    .sort((a, b) => {
      if (!cmp) return defaultTrialOrder(a, b)
      const primary = cmp(a, b)
      return primary !== 0 ? primary * sign : defaultTrialOrder(a, b)
    })
}

/**
 * Parse a location hash into route and filter params; unknown routes fall back
 * to summary.
 * @param {string} hash - `location.hash`, e.g. `#trials?arm=on`.
 * @returns {{ view: string, params: URLSearchParams }}
 */
export function parseHash(hash) {
  const [viewPart, query = ''] = hash.replace(/^#/, '').split('?')
  return { view: VIEWS.includes(/** @type {any} */ (viewPart)) ? viewPart : 'summary', params: new URLSearchParams(query) }
}

/**
 * Build a hash with a query string for the given filters; empty values drop
 * out so clean URLs stay short.
 * @param {string} view - route name.
 * @param {Record<string, string>} [filters] - filter values.
 * @returns {string}
 */
export function buildHash(view, filters = {}) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v)
  const q = params.toString()
  return `#${view}${q ? `?${q}` : ''}`
}

/**
 * Format a proportion as a percent.
 * @param {number} v - proportion.
 * @param {number} [digits] - decimal places.
 * @returns {string} - e.g. `83.3%`; `—` when not finite.
 */
export function formatPct(v, digits = 1) {
  return Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—'
}

/**
 * Format a signed proportion delta in percentage points.
 * @param {number | null} v - delta.
 * @returns {string} - e.g. `+25.0%`; `—` for null/non-finite.
 */
export function formatSignedPct(v) {
  if (v === null || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
}

/**
 * Format an integer with grouping separators.
 * @param {number} v - value.
 * @returns {string} - e.g. `12,340`; `—` when not finite.
 */
export function formatInt(v) {
  return Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—'
}

/**
 * Format a token count compactly.
 * @param {number} v - token count.
 * @returns {string} - e.g. `12.3k`; `—` when not finite.
 */
export function formatTokens(v) {
  if (!Number.isFinite(v)) return '—'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(Math.round(v))
}

/**
 * Format a millisecond duration.
 * @param {number} ms - duration.
 * @returns {string} - e.g. `7m 3s`; `—` when not finite.
 */
export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '—'
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  // Round to whole seconds first so 59.7s becomes `3m 0s`, never `2m 60s`.
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m ${whole % 60}s`
}

/**
 * Format a McNemar p-value; null means no discordant pairs.
 * @param {number | null} p - p-value.
 * @returns {string}
 */
export function formatP(p) {
  if (p === null || p === undefined) return 'p n/a'
  if (p < 0.001) return 'p < 0.001'
  return `p = ${p.toFixed(3)}`
}

/**
 * Format a ratio as a multiplier.
 * @param {number | null} v - ratio.
 * @returns {string} - e.g. `1.24×`; `—` for null/non-finite.
 */
export function formatRatio(v) {
  return v === null || !Number.isFinite(v) ? '—' : `${v.toFixed(2)}×`
}
