/**
 * Paired comparisons between two arms: outcome pairing on taskId+trialIndex,
 * the exact McNemar test over discordant pairs, the unbiased pass@k
 * estimator, and the pre-registered comparison grade.
 *
 * @module bench/stats/paired
 */

/** Significance level of the grade decision rule (pre-registered protocol). */
export const SIGNIFICANCE_LEVEL = 0.05

/** Maximum total-token overhead ratio (on / off) for an unqualified 'improvement'. */
export const TOKEN_OVERHEAD_MAX = 1.25

/**
 * Match two arms' trials on taskId+trialIndex and count paired outcomes from
 * the intervention arm's perspective: a win is resolved in `onTrials` but not
 * in `offTrials`. A pair enters only when both sides ran with status
 * 'success' — an infrastructure error is noise, not evidence
 * (bench/schema/trial.js). Each baseline trial pairs at most once.
 * @param {import('../schema/trial.js').Trial[]} offTrials - baseline arm.
 * @param {import('../schema/trial.js').Trial[]} onTrials - intervention arm.
 * @returns {{ pairs: { taskId: string, trialIndex: number, off: boolean, on: boolean }[], wins: number, losses: number, ties: number }}
 *   pairs in `onTrials` order; wins/losses/ties counted over them.
 */
export function pairOutcomes(offTrials, onTrials) {
  const baseline = new Map()
  for (const t of offTrials) {
    if (t.status === 'success') baseline.set(JSON.stringify([t.taskId, t.trialIndex]), t.resolved)
  }
  const pairs = []
  for (const t of onTrials) {
    if (t.status !== 'success') continue
    const key = JSON.stringify([t.taskId, t.trialIndex])
    if (!baseline.has(key)) continue
    pairs.push({ taskId: t.taskId, trialIndex: t.trialIndex, off: baseline.get(key), on: t.resolved })
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
 * Exact two-sided McNemar p-value: under the null the smaller discordant
 * count is Binomial(wins + losses, 0.5), and p = min(1, 2·P(X ≤ min(wins,
 * losses))). With no discordant pairs the test is undefined and returns null.
 * @param {number} wins - discordant pairs favouring the intervention arm.
 * @param {number} losses - discordant pairs favouring the baseline arm.
 * @returns {number | null} p in (0, 1], or null when wins + losses = 0.
 */
export function mcnemarExactP(wins, losses) {
  const n = wins + losses
  if (n === 0) return null
  const k = Math.min(wins, losses)
  let term = 0.5 ** n
  let cdf = term
  for (let i = 1; i <= k; i++) {
    term *= (n - i + 1) / i
    cdf += term
  }
  return Math.min(1, 2 * cdf)
}

/**
 * Unbiased pass@k estimator: the probability that at least one of k trials
 * sampled without replacement from n trials (of which c resolved) passes:
 * 1 - C(n-c, k) / C(n, k).
 * @param {number} n - total trials.
 * @param {number} c - resolved trials, 0 ≤ c ≤ n.
 * @param {number} k - sample size, 1 ≤ k ≤ n.
 * @returns {number} estimate in [0, 1].
 * @throws {RangeError} when the counts violate the stated bounds.
 */
export function passAtK(n, c, k) {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(c) || !Number.isSafeInteger(k)
    || n < 1 || c < 0 || c > n || k < 1 || k > n) {
    throw new RangeError(`passAtK requires integers with 1 <= k <= n and 0 <= c <= n; got n=${n}, c=${c}, k=${k}`)
  }
  if (k > n - c) return 1
  return 1 - choose(n - c, k) / choose(n, k)
}

/**
 * Pre-registered comparison grade: 'improvement' when the delta is
 * significantly positive (McNemar p < 0.05 and deltaAccuracy > 0) and the
 * total-token overhead ratio on:off stays within 1.25; 'tradeoff' under the
 * same significance with overhead above budget; 'regression' when the delta
 * is significantly negative; otherwise 'tie'. A null p (no discordant pairs)
 * is never significant.
 * @param {{ mcnemarP: number | null, deltaAccuracy: number, tokenOverheadRatio: number }} input
 * @returns {'improvement' | 'tradeoff' | 'regression' | 'tie'}
 */
export function gradeComparison({ mcnemarP, deltaAccuracy, tokenOverheadRatio }) {
  const significant = mcnemarP !== null && mcnemarP < SIGNIFICANCE_LEVEL
  if (significant && deltaAccuracy > 0) {
    return tokenOverheadRatio <= TOKEN_OVERHEAD_MAX ? 'improvement' : 'tradeoff'
  }
  if (significant && deltaAccuracy < 0) return 'regression'
  return 'tie'
}

/**
 * Binomial coefficient C(n, k) by multiplicative reduction; exact for the
 * trial counts this suite runs.
 * @param {number} n
 * @param {number} k
 * @returns {number}
 */
function choose(n, k) {
  k = Math.min(k, n - k)
  let result = 1
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1)
  return result
}
