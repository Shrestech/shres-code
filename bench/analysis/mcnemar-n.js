/**
 * Sample-size formulas for the exact two-sided McNemar test the bench already
 * runs (`mcnemarExactP` in bench/stats/paired.js). Planning uses a paired
 * proportion delta δ and a discordance rate ψ = P(off ≠ on). |δ| cannot exceed
 * ψ: that would require a negative discordant-cell probability.
 *
 * Connor (1987, Biometrics 43:701–705) is the uncorrected normal approximation.
 * The continuity-corrected form is the Fleiss/Chow restatement of Miettinen
 * (1968) applied to that n: n_cc = (n/4)(1 + √(1 + 4/(n|δ|)))².
 *
 * @module bench/analysis/mcnemar-n
 */

import { mcnemarExactP } from '../stats/paired.js'

/** Two-sided α used by `gradeComparison` / the pre-registered protocol. */
export const ALPHA = 0.05

/** Target power for planning (1 − β). */
export const TARGET_POWER = 0.8

/** Φ⁻¹(1 − α/2) at α = 0.05. */
export const Z_ALPHA_2 = 1.959963984540054

/** Φ⁻¹(power) at power = 0.8. */
export const Z_POWER = 0.841621233572914

/**
 * Discordant-cell probabilities under a paired Bernoulli model.
 * @param {number} psi - discordance rate ψ = p01 + p10.
 * @param {number} delta - proportion difference δ = p01 − p10 (on minus off).
 * @returns {{ p01: number, p10: number } | null} null when |δ| > ψ.
 */
export function discordantCells(psi, delta) {
  if (!(psi > 0) || psi > 1 || !Number.isFinite(delta) || Math.abs(delta) > psi + 1e-15) {
    return null
  }
  return { p01: (psi + delta) / 2, p10: (psi - delta) / 2 }
}

/**
 * Connor (1987) McNemar sample size, uncorrected, two-sided α.
 * n = [z_{α/2} √ψ + z_{1−β} √(ψ − δ²)]² / δ².
 * @param {number} psi - discordance rate.
 * @param {number} delta - paired proportion difference (sign ignored).
 * @param {{ alpha?: number, power?: number }} [opts]
 * @returns {number | null} real-valued n, or null when the alternative is infeasible.
 */
export function connorN(psi, delta, opts = {}) {
  const absDelta = Math.abs(delta)
  if (absDelta === 0 || discordantCells(psi, absDelta) === null) return null
  const zA = opts.alpha === undefined || opts.alpha === ALPHA ? Z_ALPHA_2 : inverseNorm(1 - opts.alpha / 2)
  const zB = opts.power === undefined || opts.power === TARGET_POWER ? Z_POWER : inverseNorm(opts.power)
  const inner = psi - absDelta * absDelta
  if (inner < 0) return null
  const num = zA * Math.sqrt(psi) + zB * Math.sqrt(inner)
  return (num * num) / (absDelta * absDelta)
}

/**
 * Continuity-corrected Connor n (Miettinen/Fleiss/Chow form).
 * @param {number} psi - discordance rate.
 * @param {number} delta - paired proportion difference (sign ignored).
 * @param {{ alpha?: number, power?: number }} [opts]
 * @returns {number | null} real-valued n_cc, or null when infeasible.
 */
export function miettinenCorrectedN(psi, delta, opts = {}) {
  const n = connorN(psi, delta, opts)
  if (n === null) return null
  const absDelta = Math.abs(delta)
  const root = Math.sqrt(1 + 4 / (n * absDelta))
  return (n / 4) * (1 + root) * (1 + root)
}

/**
 * Exact McNemar power: multinomial (p01, p10, 1−ψ) over n pairs, reject when
 * `mcnemarExactP(wins, losses) < alpha`. Same test the report grades with.
 * @param {number} n - paired trial count.
 * @param {number} psi - discordance rate.
 * @param {number} delta - p_on − p_off under H1.
 * @param {number} [alpha]
 * @returns {number | null} power in [0, 1], or null when infeasible.
 */
export function exactMcnemarPower(n, psi, delta, alpha = ALPHA) {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`exactMcnemarPower n must be a positive integer; got ${n}`)
  }
  const cells = discordantCells(psi, delta)
  if (cells === null) return null
  const { p01, p10 } = cells
  const pTie = 1 - psi
  let power = 0
  for (let wins = 0; wins <= n; wins++) {
    for (let losses = 0; losses <= n - wins; losses++) {
      const ties = n - wins - losses
      const pval = mcnemarExactP(wins, losses)
      if (pval === null || pval >= alpha) continue
      power += Math.exp(
        logMultinomial(n, wins, losses, ties)
        + logPow(p01, wins)
        + logPow(p10, losses)
        + logPow(pTie, ties),
      )
    }
  }
  return power
}

/**
 * Smallest n whose exact McNemar power is at least `power`.
 * @param {number} psi - discordance rate.
 * @param {number} delta - paired proportion difference.
 * @param {{ alpha?: number, power?: number, start?: number, max?: number }} [opts]
 * @returns {{ n: number, power: number } | null} null when infeasible or max exceeded.
 */
export function exactMcnemarN(psi, delta, opts = {}) {
  if (discordantCells(psi, delta) === null) return null
  const alpha = opts.alpha ?? ALPHA
  const target = opts.power ?? TARGET_POWER
  const max = opts.max ?? 400
  const guess = Math.max(1, Math.ceil(opts.start ?? connorN(psi, delta, opts) ?? 8))
  let lo = 1
  let hi = Math.min(max, Math.max(guess, 8))
  while ((exactMcnemarPower(hi, psi, delta, alpha) ?? 0) < target) {
    if (hi >= max) return null
    hi = Math.min(max, hi * 2)
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((exactMcnemarPower(mid, psi, delta, alpha) ?? 0) >= target) hi = mid
    else lo = mid + 1
  }
  return { n: lo, power: exactMcnemarPower(lo, psi, delta, alpha) ?? 0 }
}

/**
 * Smallest discordant-pair count for the exact two-sided binomial McNemar
 * (conditional on discordance) at success probability π = (ψ + δ) / (2ψ).
 * @param {number} psi - discordance rate.
 * @param {number} delta - paired proportion difference.
 * @param {{ alpha?: number, power?: number, max?: number }} [opts]
 * @returns {{ nDiscordant: number, pi: number, power: number } | null}
 */
export function exactDiscordantN(psi, delta, opts = {}) {
  const cells = discordantCells(psi, delta)
  if (cells === null) return null
  const pi = cells.p01 / psi
  const alpha = opts.alpha ?? ALPHA
  const target = opts.power ?? TARGET_POWER
  const max = opts.max ?? 400
  for (let d = 1; d <= max; d++) {
    const pwr = exactBinomialMcnemarPower(d, pi, alpha)
    if (pwr >= target) return { nDiscordant: d, pi, power: pwr }
  }
  return null
}

/**
 * Conditional McNemar power given nDiscordant pairs and P(win | discordant) = pi.
 * @param {number} nDiscordant
 * @param {number} pi
 * @param {number} [alpha]
 * @returns {number} power in [0, 1].
 */
export function exactBinomialMcnemarPower(nDiscordant, pi, alpha = ALPHA) {
  if (!Number.isSafeInteger(nDiscordant) || nDiscordant < 1) {
    throw new RangeError(`nDiscordant must be a positive integer; got ${nDiscordant}`)
  }
  let power = 0
  for (let wins = 0; wins <= nDiscordant; wins++) {
    const losses = nDiscordant - wins
    const pval = mcnemarExactP(wins, losses)
    if (pval === null || pval >= alpha) continue
    power += Math.exp(logFact(nDiscordant) - logFact(wins) - logFact(losses) + logPow(pi, wins) + logPow(1 - pi, losses))
  }
  return power
}

/**
 * Ceil a sample size to an integer, then up to a multiple of `tasks` so repeats
 * split evenly across a pooled catalog.
 * @param {number} n - real-valued or integer n.
 * @param {number} [tasks]
 * @returns {number} integer n.
 */
export function planN(n, tasks = 1) {
  if (!(n > 0) || !Number.isSafeInteger(tasks) || tasks < 1) {
    throw new RangeError(`planN requires n > 0 and a positive integer task count; got n=${n}, tasks=${tasks}`)
  }
  const ceil = Math.ceil(n)
  return Math.ceil(ceil / tasks) * tasks
}

/**
 * k * log(p), treating 0^0 as 1.
 * @param {number} p
 * @param {number} k
 * @returns {number}
 */
function logPow(p, k) {
  if (k === 0) return 0
  if (p === 0) return Number.NEGATIVE_INFINITY
  return k * Math.log(p)
}

/**
 * log(n! / (a! b! c!)) for a+b+c = n.
 * @param {number} n
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @returns {number}
 */
function logMultinomial(n, a, b, c) {
  return logFact(n) - logFact(a) - logFact(b) - logFact(c)
}

const logFactCache = [0]

/**
 * log(k!) with a growing cache.
 * @param {number} k
 * @returns {number}
 */
function logFact(k) {
  for (let i = logFactCache.length; i <= k; i++) {
    logFactCache.push(logFactCache[i - 1] + Math.log(i))
  }
  return logFactCache[k]
}

/**
 * Acklam's inverse-normal approximation; used only if a caller overrides α/power.
 * @param {number} p - probability in (0, 1).
 * @returns {number} Φ⁻¹(p).
 */
function inverseNorm(p) {
  if (!(p > 0 && p < 1)) throw new RangeError(`inverseNorm p must be in (0, 1); got ${p}`)
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577459574091e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const plow = 0.02425
  const phigh = 1 - plow
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}
