/**
 * Configuration of the bench-random engine: the match rate and the seed.
 *
 * Both fields are required — an arm that forgets its rate or seed must fail
 * the load rather than run an unregistered contrast. The values are frozen in
 * the experiment's registration (`bench/routing/prereg-2026-10.registration.json`)
 * before any confirmatory trial; the pinned bench overlay restates them.
 *
 * @module
 */

/** Keys the engine config accepts; anything else fails the load by name. */
const CONFIG_KEYS = new Set(['entryRate', 'seed'])

/**
 * Validated engine config.
 */
export interface ResolvedBenchRandomConfig {
  /** Probability that one consult selects the downgrade candidate. */
  readonly entryRate: number
  /** 32-bit seed of the consult draw stream; the same seed replays the same sequence. */
  readonly seed: number
}

/**
 * Validate and detach the plugin config.
 * @param value - the raw config the loader hands the plugin.
 * @returns the validated config.
 */
export function resolveConfig(value: unknown): ResolvedBenchRandomConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('bench-random config must be an object')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`bench-random config rejects unknown key ${key}`)
  }
  const { entryRate, seed } = record
  if (typeof entryRate !== 'number' || !Number.isFinite(entryRate) || entryRate < 0 || entryRate > 1) {
    throw new Error('bench-random config entryRate must be a number from 0 to 1')
  }
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('bench-random config seed must be an integer from 0 to 4294967295')
  }
  return { entryRate, seed }
}
