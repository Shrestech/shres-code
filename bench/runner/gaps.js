/**
 * Seeded idle-gap sampler for the routing-measurement multiturn runner.
 *
 * Between scripted user turns the runner waits for a gap drawn from the
 * logged start-to-start distribution of real coding sessions, so a trial
 * exercises the same cache-expiry structure the routing policy targets. The
 * distribution is frozen as an anchor table in
 * `bench/routing/prereg-2026-10.md`; the two measured quantiles are exact
 * (29.4% of starts follow a gap over 300 s, 5.7% over 3,600 s) and the
 * interior anchors interpolate that logged distribution. Draws are seeded,
 * logged per trial in `trials.jsonl`, and never re-drawn on resume: a
 * rerun of an interrupted trial is a new attempt with a fresh stream.
 *
 * @module bench/runner/gaps
 */

import { mulberry32 } from './seeded.js'

/** The frozen start-to-start distribution: [seconds, cumulative P(≤ s)] anchors. */
export const GAP_DISTRIBUTION_ANCHORS = Object.freeze([
  [0, 0.0],
  [60, 0.28],
  [180, 0.52],
  [300, 0.706],
  [600, 0.8],
  [1200, 0.87],
  [1800, 0.91],
  [2700, 0.93],
  [3600, 0.943],
  [5400, 0.965],
  [7200, 0.978],
  [10800, 0.99],
  [21600, 1.0],
])

/** Cumulative probability at 300 s: the measured share of starts over 300 s is 29.4%. */
const CDF_AT_300S = 0.706

/**
 * Derive one trial's gap-stream seed from the experiment gap seed and the
 * trial's (taskId, trialIndex) key, so paired arms share a trial's gaps and a
 * rerun replays them exactly.
 * @param {number} baseSeed - the experiment's --gap-seed.
 * @param {string} taskId - the trial's task.
 * @param {number} trialIndex - the trial's repeat index.
 * @returns {number} a 32-bit unsigned seed.
 */
export function trialGapSeed(baseSeed, taskId, trialIndex) {
  let hash = 0x811c9dc5 ^ (baseSeed >>> 0)
  for (const part of [taskId, String(trialIndex)]) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return hash >>> 0
}

/**
 * Invert the anchor table at one uniform draw. Within a piece the draw is
 * uniform in time, which keeps the sampler auditable: an anchor pair and a u
 * determine the gap by linear interpolation alone.
 * @param {() => number} random - the seeded stream.
 * @returns {number} one gap in milliseconds.
 */
export function drawGapMs(random) {
  const u = random()
  const anchors = GAP_DISTRIBUTION_ANCHORS
  for (let i = 1; i < anchors.length; i += 1) {
    const [prevSeconds, prevCdf] = anchors[i - 1]
    const [seconds, cdf] = anchors[i]
    if (u <= cdf) {
      const share = (u - prevCdf) / (cdf - prevCdf)
      return Math.round(((prevSeconds + share * (seconds - prevSeconds)) * 1000))
    }
  }
  // The last anchor's CDF is 1.0; a float rounding above it rounds to the top.
  return anchors[anchors.length - 1][0] * 1000
}

/**
 * Draw one trial's idle gaps.
 *
 * Every task must exercise at least one gap over 300 s (the short-TTL cache
 * boundary the cold-point policy keys on), so when no draw lands in the tail
 * stratum the last gap is redrawn from it. The cap realizes
 * `min(drawn, cap)` without discarding the drawn value: L1/L2 set a
 * 20-minute cap, the over-1-hour stratum is then truncated, and the report
 * names that stratum unmeasured.
 * @param {object} options
 * @param {number} options.seed - 32-bit seed; pinned in the run manifest.
 * @param {number} options.count - gaps to draw (turns − 1), at least 1.
 * @param {number | null} options.capMs - realized-gap ceiling, or null for uncapped (L3).
 * @returns {{ index: number, drawnMs: number, gapMs: number }[]} one record per inter-turn gap, in turn order.
 */
export function drawGaps({ seed, count, capMs }) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`gap count must be a positive integer, got ${count}`)
  if (capMs !== null && (!Number.isFinite(capMs) || capMs <= 0)) throw new RangeError(`gap cap must be a positive finite number or null, got ${capMs}`)
  const random = mulberry32(seed)
  const gaps = []
  for (let index = 0; index < count; index += 1) {
    gaps.push({ index, drawnMs: drawGapMs(random), gapMs: 0 })
  }
  if (!gaps.some(gap => gap.drawnMs > 300_000)) {
    const u = CDF_AT_300S + random() * (1 - CDF_AT_300S)
    gaps[gaps.length - 1].drawnMs = drawGapMs(() => u)
  }
  for (const gap of gaps) gap.gapMs = capMs === null ? gap.drawnMs : Math.min(gap.drawnMs, capMs)
  return gaps
}
