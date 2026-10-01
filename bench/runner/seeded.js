/**
 * Seeded deterministic primitives shared by the routing-measurement runner:
 * a small integer PRNG and a seeded Fisher-Yates shuffle.
 *
 * The routing arms randomize trial order and draw idle gaps from seeded
 * streams so an experiment can be replayed and audited: every seed is pinned
 * in the run manifest and every consumer logs what it drew. The generator is
 * mulberry32 — 32 bits of state, no dependencies, and stable across Node
 * versions, which is the property the preregistration relies on.
 *
 * @module bench/runner/seeded
 */

/**
 * Create a mulberry32 pseudo-random stream.
 * @param {number} seed - 32-bit unsigned seed; the same seed replays the same sequence.
 * @returns {() => number} each call returns a float in [0, 1).
 */
export function mulberry32(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Shuffle a copy of a list with a seeded stream (Fisher-Yates).
 * @template T
 * @param {readonly T[]} items - list to shuffle; the input is not mutated.
 * @param {() => number} random - the seeded stream; the same stream state replays the same order.
 * @returns {T[]} shuffled copy.
 */
export function seededShuffle(items, random) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const hold = out[i]
    out[i] = out[j]
    out[j] = hold
  }
  return out
}
