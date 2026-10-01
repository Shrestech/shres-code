/**
 * Preregistered pass/fail gate of the PR 16 routing measurement.
 *
 * Computes H1–H5 and the must-hold screens of
 * `bench/routing/prereg-2026-10.md` over matched trial facts, with zero API
 * spend: the caller feeds per-trial facts extracted from `trials.jsonl` rows
 * and their session logs, and this module returns the verdict. The methods are
 * frozen here and in the preregistration; a changed method is a new experiment
 * name.
 *
 * Method summary (each stated where it is implemented):
 * - H1 is a one-sided 97.5% non-inferiority bound on the paired success
 *   difference (R − S), cluster-robust by task.
 * - H2–H5 each contribute one one-sided p-value against their null boundary
 *   (H3 also reports its two-sided interval and its 0.80 point condition),
 *   and the family {H2, H3, H4, H5} is Holm-corrected at α = 0.05. H4's
 *   p-value tests the cluster-robust mean critical-path latency against the
 *   50 ms bound; its pass condition stays the preregistered p95 figure.
 * - The screens (no warm turn judged, no lost turns, no invariant failures,
 *   the Laya replay gate) are pass/fail conditions, never p-values; the count
 *   of route-failed recoveries is reported and never gated.
 *
 * @module bench/analysis/routing-gate
 */

/** Two-sided 97.5% normal deviate (z at 0.975). */
export const Z_975 = 1.959963984540054

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 on erf, |z| ≤ 6 covers every reported z). */
export function normalCdf(z) {
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * erf)
}

/**
 * Cluster-robust mean, standard error, and one-sided z machinery for paired
 * differences grouped by task (CR1 correction for a single-regressor mean).
 * @param {{ taskId: string, value: number }[]} observations - one per pair; clusters are taskId.
 * @returns {{ mean: number, se: number, clusters: number, n: number }} estimate with its CR1 standard error.
 */
export function clusterRobustMean(observations) {
  const n = observations.length
  if (n < 2) throw new RangeError(`cluster-robust inference needs at least 2 pairs, got ${n}`)
  const mean = observations.reduce((sum, o) => sum + o.value, 0) / n
  const byTask = new Map()
  for (const o of observations) {
    const cluster = byTask.get(o.taskId) ?? { size: 0, score: 0 }
    cluster.size += 1
    cluster.score += o.value - mean
    byTask.set(o.taskId, cluster)
  }
  const clusters = byTask.size
  if (clusters < 2) throw new RangeError(`cluster-robust inference needs at least 2 tasks, got ${clusters}`)
  let ss = 0
  for (const cluster of byTask.values()) ss += cluster.score * cluster.score
  const correction = clusters / (clusters - 1)
  const se = Math.sqrt(correction * ss / (n * n))
  return { mean, se, clusters, n }
}

/** One-sided p-value that the cluster-robust mean exceeds `boundary` is 1 − Φ(z); below is Φ(z). */
function oneSidedP(estimate, boundary, direction) {
  const z = (estimate.mean - boundary) / estimate.se
  return direction === 'greater' ? 1 - normalCdf(z) : normalCdf(z)
}

/**
 * Holm step-down adjustment: rejects at α the sorted p-values meeting
 * p_(k) ≤ α / (m − k + 1); every earlier rejection gates the next.
 * @param {Record<string, number>} pValues - named one-sided p-values.
 * @param {number} alpha - family-wise level.
 * @returns {{ rejected: string[], pAdjusted: Record<string, number> }} rejected hypotheses and Holm-adjusted p-values.
 */
export function holm(pValues, alpha) {
  const entries = Object.entries(pValues).sort((a, b) => a[1] - b[1])
  const pAdjusted = {}
  const rejected = []
  let runningMax = 0
  entries.forEach(([name, p], index) => {
    const adjusted = Math.min(1, Math.max(runningMax, p * (entries.length - index)))
    runningMax = Math.max(runningMax, adjusted)
    pAdjusted[name] = adjusted
    if (adjusted <= alpha) rejected.push(name)
  })
  return { rejected, pAdjusted }
}

/** Nearest-rank percentile of a sample (ceil(p/100 · n), 1-based). */
export function percentile(samples, p) {
  if (samples.length === 0) throw new RangeError('percentile of an empty sample')
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]
}

/** Required matched pairs for power 0.8 at one-sided α 0.025: 7.849 · p_disc / δ². */
export function requiredPairs(pDisc, delta) {
  return Math.ceil((7.849 * pDisc) / (delta * delta))
}

/**
 * One matched trial's facts. `success` is the final verifier pass; the token
 * and routing fields come from the session log's usage and
 * `model-routing/decision` events on the strong route. The robustness fields
 * are null while the integrating PRs have not landed the events they are
 * counted from, and a null screen refuses a gate PASS rather than defaulting.
 * @typedef {object} TrialFacts
 * @property {string} taskId
 * @property {number} repeat
 * @property {'S' | 'R' | 'N'} arm
 * @property {'routine' | 'moderate' | 'hard'} stratum - the task's preregistered stratum;
 *   H1 must also pass within the hard stratum.
 * @property {0 | 1} success
 * @property {number} strongTokens - input + cacheRead + cacheWrite + output on the strong route.
 * @property {number} coldStrongWrites - strong cacheWrite tokens on cold calls, per session.
 * @property {number} judgedWarmTurns - judged decisions whose coldPoint is null.
 * @property {number} coldPointEntries - judged decisions that entered the candidate at a cold point.
 * @property {number} coldPoints - cold points the judge evaluated.
 * @property {number} routeFailedRecoveries - decisions that recovered from a route failure.
 * @property {number[]} judgeCriticalPathMs - per judged turn, judge latencyMs + eligibilityMs.
 * @property {number | null} lostTurns - user turns lost by the routing layer; null until sourced.
 * @property {number | null} invariantFailures - routing invariant failures; null until sourced.
 */

/**
 * Compute the preregistered gate over matched trial facts.
 * @param {TrialFacts[]} facts - S and R trials paired by (taskId, repeat); N facts included when arm N ran.
 * @param {object} options
 * @param {number} [options.delta] - H1 non-inferiority margin (0.05).
 * @param {number} [options.familyAlpha] - Holm family level (0.05).
 * @param {number} [options.h3PointMax] - H3 point-ratio condition (0.80).
 * @param {number} [options.h4P95MaxMs] - H4 latency bound (50 ms).
 * @param {number} [options.h5RatioMax] - H5 cold-write ratio bound (1.05).
 * @param {number | null} options.designPdisc - the run level's design p_disc; null skips the power check.
 * @param {boolean | null} options.layaReplayPassed - the offline replay verdict; null means not yet run.
 * @returns {object} the full verdict: hypotheses, screens, power, and the pass decision with its failure reading.
 */
export function computeRoutingGate(facts, options) {
  const delta = options.delta ?? 0.05
  const familyAlpha = options.familyAlpha ?? 0.05
  const h3PointMax = options.h3PointMax ?? 0.8
  const h4P95MaxMs = options.h4P95MaxMs ?? 50
  const h5RatioMax = options.h5RatioMax ?? 1.05
  const byArm = arm => facts.filter(fact => fact.arm === arm)
  const sFacts = byArm('S')
  const rFacts = byArm('R')
  const nFacts = byArm('N')
  if (sFacts.length === 0 || rFacts.length === 0) throw new RangeError('gate needs S and R facts')

  const sKeys = new Set(sFacts.map(fact => key(fact)))
  const rKeys = new Set(rFacts.map(fact => key(fact)))
  const pairedKeys = [...sKeys].filter(k => rKeys.has(k))
  if (pairedKeys.length === 0) throw new RangeError('gate needs at least one matched (task, repeat) S/R pair')
  const sByKey = new Map(sFacts.map(fact => [key(fact), fact]))
  const rByKey = new Map(rFacts.map(fact => [key(fact), fact]))
  const pairOf = k => ({ s: sByKey.get(k), r: rByKey.get(k) })
  const taskOf = k => k.split('\u0000')[0]

  // H1: paired success difference, cluster-robust by task — OVERALL and,
  // preregistered with equal force, within the HARD stratum. The hard
  // stratum is the harm detector the suite's discrimination filter exists
  // to feed; missing or insufficient hard data refuses the pass instead of
  // defaulting to one.
  const h1 = clusterRobustMean(pairedKeys.map(k => {
    const { s, r } = pairOf(k)
    return { taskId: taskOf(k), value: r.success - s.success }
  }))
  const h1LowerBound = h1.mean - Z_975 * h1.se
  const hardKeys = pairedKeys.filter(k => /** @type {{ s: TrialFacts }} */ (pairOf(k)).s.stratum === 'hard')
  const hardTasks = new Set(hardKeys.map(k => taskOf(k)))
  let hard
  if (hardKeys.length === 0 || hardTasks.size < 2) {
    hard = { status: 'insufficient-data', pairs: hardKeys.length, clusters: hardTasks.size }
  } else {
    const hardEst = clusterRobustMean(hardKeys.map(k => {
      const { s, r } = pairOf(k)
      return { taskId: taskOf(k), value: r.success - s.success }
    }))
    hard = {
      status: 'evaluated',
      mean: hardEst.mean,
      lowerBound975: hardEst.mean - Z_975 * hardEst.se,
      se: hardEst.se,
      pairs: hardEst.n,
      clusters: hardEst.clusters,
      pass: hardEst.mean - Z_975 * hardEst.se > -delta,
    }
  }
  const h1Pass = h1LowerBound > -delta && hard.status === 'evaluated' && hard.pass === true

  // H3/H5: paired log-ratios, cluster-robust; the ratio estimates are exp(mean).
  const h3Est = clusterRobustMean(pairedKeys.map(k => {
    const { s, r } = pairOf(k)
    return { taskId: taskOf(k), value: Math.log(requirePositive(r.strongTokens, 'strongTokens') / requirePositive(s.strongTokens, 'strongTokens')) }
  }))
  const h3Ratio = Math.exp(h3Est.mean)
  const h3Ci = [Math.exp(h3Est.mean - Z_975 * h3Est.se), Math.exp(h3Est.mean + Z_975 * h3Est.se)]
  const h5Est = clusterRobustMean(pairedKeys.map(k => {
    const { s, r } = pairOf(k)
    return { taskId: taskOf(k), value: Math.log(requirePositive(r.coldStrongWrites, 'coldStrongWrites') / requirePositive(s.coldStrongWrites, 'coldStrongWrites')) }
  }))
  const h5Ratio = Math.exp(h5Est.mean)
  const h5Upper = Math.exp(h5Est.mean + 1.6448536269514722 * h5Est.se)

  // H2 pairs R against N on common (task, repeat).
  let h2Est = null
  const nByKey = new Map(nFacts.map(fact => [key(fact), fact]))
  const h2Keys = pairedKeys.filter(k => nByKey.has(k))
  if (h2Keys.length >= 2) {
    h2Est = clusterRobustMean(h2Keys.map(k => {
      const { r } = pairOf(k)
      return { taskId: taskOf(k), value: r.success - nByKey.get(k).success }
    }))
  }

  // H4 pools R's per-turn critical-path samples.
  const criticalPathSamples = rFacts.flatMap(fact => fact.judgeCriticalPathMs)
  if (criticalPathSamples.length === 0) throw new RangeError('gate needs at least one judged R turn for H4')
  const h4P95 = percentile(criticalPathSamples, 95)
  const h4MeanEst = clusterRobustMean(rFacts
    .filter(fact => fact.judgeCriticalPathMs.length > 0)
    .map(fact => ({ taskId: fact.taskId, value: fact.judgeCriticalPathMs.reduce((a, b) => a + b, 0) / fact.judgeCriticalPathMs.length })))

  // p-values for the Holm family.
  const pValues = {
    H2: h2Est === null ? 1 : oneSidedP(h2Est, 0, 'greater'),
    H3: oneSidedP(h3Est, 0, 'less'),
    H4: oneSidedP(h4MeanEst, h4P95MaxMs, 'less'),
    H5: oneSidedP(h5Est, Math.log(h5RatioMax), 'less'),
  }
  const holmResult = holm(pValues, familyAlpha)

  // Power reading (§7): the observed p_disc is R's cold-point entry rate.
  const coldPoints = rFacts.reduce((sum, fact) => sum + fact.coldPoints, 0)
  const entries = rFacts.reduce((sum, fact) => sum + fact.coldPointEntries, 0)
  const pDisc = coldPoints > 0 ? entries / coldPoints : null
  const power = pDisc === null || options.designPdisc === null ? null : {
    observedPdisc: pDisc,
    designPdisc: options.designPdisc,
    requiredPairsAtObserved: requiredPairs(pDisc, delta),
    underpoweredByConstruction: pDisc > options.designPdisc,
  }

  const screens = {
    noWarmTurnJudged: sumOr(rFacts.map(fact => fact.judgedWarmTurns)) === 0,
    noLostTurns: everyNotNull(rFacts, 'lostTurns') ? sumOr(rFacts.map(fact => fact.lostTurns)) === 0 : null,
    noInvariantFailures: everyNotNull(rFacts, 'invariantFailures') ? sumOr(rFacts.map(fact => fact.invariantFailures)) === 0 : null,
    layaReplayPassed: options.layaReplayPassed,
  }

  const hypotheses = {
    H1: { pass: h1Pass, mean: h1.mean, lowerBound975: h1LowerBound, se: h1.se, pairs: h1.n, clusters: h1.clusters, hard },
    H2: { pass: holmResult.rejected.includes('H2'), p: pValues.H2, pHolm: holmResult.pAdjusted.H2, pairs: h2Est === null ? 0 : h2Est.n, meanDifference: h2Est === null ? null : h2Est.mean },
    H3: { pass: holmResult.rejected.includes('H3') && h3Ratio <= h3PointMax && h3Ci[1] < 1, p: pValues.H3, pHolm: holmResult.pAdjusted.H3, ratio: h3Ratio, ci95: h3Ci, pointConditionMet: h3Ratio <= h3PointMax },
    H4: { pass: holmResult.rejected.includes('H4') && h4P95 <= h4P95MaxMs, p: pValues.H4, pHolm: holmResult.pAdjusted.H4, p95Ms: h4P95, boundMs: h4P95MaxMs, turns: criticalPathSamples.length },
    H5: { pass: holmResult.rejected.includes('H5') && h5Upper <= h5RatioMax, p: pValues.H5, pHolm: holmResult.pAdjusted.H5, ratio: h5Ratio, oneSidedUpper95: h5Upper },
  }

  const routeFailedRecoveries = sumOr(rFacts.map(fact => fact.routeFailedRecoveries))
  const screensPass = screens.noWarmTurnJudged === true
    && screens.noLostTurns === true
    && screens.noInvariantFailures === true
    && screens.layaReplayPassed === true
  const secondariesPass = hypotheses.H2.pass && hypotheses.H3.pass && hypotheses.H4.pass && hypotheses.H5.pass
  const underpowered = power !== null && power.underpoweredByConstruction
  const pass = h1Pass && secondariesPass && screensPass && !underpowered

  let failureReading = null
  if (!pass) {
    if (!h1Pass && hard.status === 'evaluated' && hard.pass === false) failureReading = 'H1 failed in the hard stratum: routing stays off, and the report states the observed harm there.'
    else if (!h1Pass) failureReading = 'H1 failed: routing stays off, and the report states the observed harm.'
    else if (!hypotheses.H2.pass) failureReading = 'H2 failed: the judge adds nothing over chance. Shadow only.'
    else if (!hypotheses.H3.pass) failureReading = 'H3 failed: no value. Off.'
    else failureReading = 'Gate not met: secondary or screen conditions failed; see the verdict fields.'
  }

  return {
    pass,
    failureReading,
    hypotheses,
    screens,
    power,
    routeFailedRecoveries,
    design: { delta, familyAlpha, h3PointMax, h4P95MaxMs, h5RatioMax, z975: Z_975 },
  }
}

function key(fact) {
  return `${fact.taskId}\u0000${fact.repeat}`
}

function requirePositive(value, name) {
  if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
    throw new RangeError(`gate needs a positive ${name}, got ${value}`)
  }
  return value
}

function sumOr(values) {
  return values.reduce((sum, value) => sum + (value ?? 0), 0)
}

function everyNotNull(facts, field) {
  return facts.every(fact => fact[field] !== null)
}
