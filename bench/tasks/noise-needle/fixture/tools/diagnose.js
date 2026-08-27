/**
 * Deterministic diagnostic dump. Prints 2000 lines of build noise with three
 * runtime-config values in the middle, derived from in-script constants.
 *
 * @module
 */
import { createHash } from 'node:crypto'

const BUILD_ID = createHash('sha256').update('n33dle-build-const-v1').digest('hex').slice(0, 16)
const CACHE_KEY = createHash('sha256').update('n33dle-cache-const-v1').digest('hex').slice(0, 20)
const AUTH_REALM = `realm-${createHash('sha256').update('n33dle-realm-const-v1').digest('hex').slice(0, 8)}`

/**
 * Seeded [0, 1) generator.
 * @param {number} seed - 32-bit seed.
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = mulberry32(0xC0FFEE)
const MODULES = ['parser', 'binder', 'emitter', 'resolver', 'checker', 'linker', 'loader', 'cache']
const HINTS = ['unused local', 'implicit any', 'missing return', 'unreachable', 'deprecated import']

/**
 * One plausible diagnostic line.
 * @param {number} index - unused; present so call sites stay numbered.
 * @returns {string}
 */
function noiseLine(index) {
  void index
  const roll = rng()
  const mod = MODULES[Math.floor(rng() * MODULES.length)]
  const line = 10 + Math.floor(rng() * 400)
  const col = 1 + Math.floor(rng() * 40)
  const kb = (4 + rng() * 90).toFixed(1)
  const hint = HINTS[Math.floor(rng() * HINTS.length)]
  const ms = 10 + Math.floor(rng() * 80)
  if (roll < 0.25) return `[build] compiling src/${mod}.js (${kb} KB)`
  if (roll < 0.5) return `[tsc] src/${mod}.js(${line},${col}): hint TS6133: ${hint}`
  if (roll < 0.7) return `[eslint] src/${mod}.js:${line}:${col} warning ${hint}`
  if (roll < 0.85) return `[vite] transforming src/${mod}.js`
  return `[jest] PASS  test/${mod}.test.js (${ms} ms)`
}

for (let i = 0; i < 1516; i++) console.log(noiseLine(i))
console.log(`[runtime-config] build_id = ${BUILD_ID}`)
console.log(`[runtime-config] cache_key = ${CACHE_KEY}`)
console.log(`[runtime-config] auth_realm = ${AUTH_REALM}`)
for (let i = 0; i < 481; i++) console.log(noiseLine(1516 + i))
