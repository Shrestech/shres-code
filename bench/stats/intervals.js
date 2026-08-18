/**
 * Uncertainty intervals: Wilson score intervals for pass-rate proportions and
 * seeded percentile-bootstrap intervals for means and paired pass-rate deltas.
 * Every aggregate the report shows carries one of these — protocol rule 3: a
 * delta without an interval is not a result.
 *
 * @module bench/stats/intervals
 */

/** Resample count for every bootstrap interval in the suite. */
export const BOOTSTRAP_RESAMPLES = 1000

/** Two-sided 95% is the suite-wide reporting level. */
const Z_95 = 1.96

/**
 * Seeded PRNG (mulberry32): the only randomness source in bench/stats, so
 * bootstrap intervals reproduce exactly across rebuilds.
 * @param {number} seed - equal seeds produce equal streams.
 * @returns {() => number} generator of uniform floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Wilson score interval for a binomial proportion. The edges need no special
 * cases: k = 0 yields a lower bound of exactly 0 and k = n an upper bound of
 * exactly 1. n = 0 has no defined proportion, so the full [0, 1] range
 * reports total uncertainty (and survives JSON serialization, unlike NaN).
 * @param {number} k - successes.
 * @param {number} n - trials.
 * @param {number} [z] - z-score of the confidence level; default 1.96 (95%).
 * @returns {[number, number]} [lower, upper] within [0, 1].
 */
export function wilsonInterval(k, n, z = Z_95) {
  if (n === 0) return [0, 1]
  const p = k / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

/**
 * Percentile bootstrap interval for the mean of `values`.
 * @param {number[]} values - the sample to resample.
 * @param {{ resamples?: number, seed?: number, level?: number }} [options]
 * @returns {[number, number]} [lower, upper]; [NaN, NaN] for empty input.
 */
export function bootstrapMeanCi(values, options = {}) {
  return bootstrap(values, (sample) => {
    let sum = 0
    for (const v of sample) sum += v
    return sum / sample.length
  }, options)
}

/**
 * Paired bootstrap interval for a pass-rate delta: resample trial pairs with
 * replacement and recompute mean(on) - mean(off) each time. Resampling whole
 * pairs (never the two arms independently) keeps the per-(task, trial)
 * matching intact.
 * @param {{ off: boolean, on: boolean }[]} pairs - matched trial outcomes.
 * @param {{ resamples?: number, seed?: number, level?: number }} [options]
 * @returns {[number, number]} [lower, upper]; [NaN, NaN] for empty input.
 */
export function bootstrapDeltaCi(pairs, options = {}) {
  return bootstrap(pairs, (sample) => {
    let sum = 0
    for (const p of sample) sum += Number(p.on) - Number(p.off)
    return sum / sample.length
  }, options)
}

/**
 * Percentile bootstrap core: resample `units` with replacement, recompute
 * `statistic` per resample, and read the interval off the sorted estimates.
 * @template T
 * @param {T[]} units - resampling units.
 * @param {(sample: T[]) => number} statistic - estimate recomputed per resample.
 * @param {{ resamples?: number, seed?: number, level?: number }} [options]
 * @returns {[number, number]} [lower, upper].
 */
function bootstrap(units, statistic, { resamples = BOOTSTRAP_RESAMPLES, seed = 1, level = 0.95 } = {}) {
  if (units.length === 0) return [NaN, NaN]
  const rng = mulberry32(seed)
  const estimates = []
  for (let r = 0; r < resamples; r++) {
    const sample = []
    for (let i = 0; i < units.length; i++) sample.push(units[Math.floor(rng() * units.length)])
    estimates.push(statistic(sample))
  }
  estimates.sort((a, b) => a - b)
  const alpha = 1 - level
  return [
    estimates[Math.floor((alpha / 2) * resamples)],
    estimates[Math.ceil((1 - alpha / 2) * resamples) - 1],
  ]
}
