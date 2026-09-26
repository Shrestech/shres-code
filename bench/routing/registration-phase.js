/**
 * The one reader of the routing measurement registration's lifecycle phase,
 * for reports and refusal messages.
 *
 * `replayGate` is the single authoritative calibration-phase flag of
 * `bench/routing/prereg-2026-10.registration.json`; the static `status`
 * field records only that the preregistration is frozen and never encodes
 * calibration, measurement, or approval. This module derives the phase from
 * the flag and refuses any file where the two could diverge, so no reader
 * re-derives its own notion of "which phase is this file in".
 *
 * Phases:
 * - `provisional`: `replayGate` absent. The overlays carry placeholder
 *   points without `calibratedBy`, so the router logs them as `point`.
 * - `replay-failed`: the replay failed the Laya gate. The program stops and
 *   routing stays shadow-only; no `enforced` block exists.
 * - `replay-qualified`: the replay passed and the confirmatory run has not
 *   run. `enforced` exists and the confirmatory overlays may be generated.
 *   This authorizes confirmatory preparation only: real-spend runs and
 *   default-on require explicit owner decisions recorded outside this file.
 *
 * @module bench/routing/registration-phase
 */

/** The static status value every registration carries; no tool changes it. */
export const REGISTRATION_STATUS = 'preregistered'

/** The enforced fields a replay-qualified registration must carry completely. */
const ENFORCED_NUMBER_FIELDS = ['downgradeThreshold', 'downgradeMargin', 'entryRate', 'realizedREntryRate']

/**
 * Derive the registration's lifecycle phase, throwing on an inconsistent
 * file. A file that passes has exactly one reading: the phase returned.
 * @param {object} registration - the parsed registration document.
 * @returns {'provisional' | 'replay-failed' | 'replay-qualified'} the phase.
 * @throws {TypeError} when the document is not an object, `status` is not
 *   `"preregistered"`, `enforced` appears without `replayGate`, a failed
 *   gate coexists with `enforced` or any calibrated id, a passed gate lacks a
 *   complete `enforced` block or carries a `calibratedBy` other than the
 *   registration id, or `replayGate` holds an unknown value.
 */
export function registrationPhase(registration) {
  if (registration === null || typeof registration !== 'object' || Array.isArray(registration)) {
    throw new TypeError('a registration must be a JSON object')
  }
  if (registration.status !== REGISTRATION_STATUS) {
    throw new TypeError(`status must be ${JSON.stringify(REGISTRATION_STATUS)}; it never encodes calibration or approval, got ${JSON.stringify(registration.status ?? null)}`)
  }
  const { replayGate, enforced } = registration
  if (replayGate === undefined) {
    if (enforced !== undefined) throw new TypeError('enforced is present without replayGate; the enforced block exists only after the flag is set')
    return 'provisional'
  }
  if (replayGate === 'failed') {
    if (enforced !== undefined) throw new TypeError("a failed replay gate records no enforced block")
    const calibrated = findCalibratedBy(registration)
    if (calibrated !== null) throw new TypeError(`a failed replay gate records no calibrated id; found one at ${calibrated}`)
    return 'replay-failed'
  }
  if (replayGate === 'passed') {
    if (enforced === null || typeof enforced !== 'object' || Array.isArray(enforced)) {
      throw new TypeError('a passed replay gate requires the enforced block')
    }
    if (typeof enforced.calibratedBy !== 'string' || enforced.calibratedBy === '') {
      throw new TypeError('a passed replay gate requires enforced.calibratedBy')
    }
    if (enforced.calibratedBy !== registration.registration) {
      throw new TypeError(`enforced.calibratedBy ${JSON.stringify(enforced.calibratedBy)} must be the registration id ${JSON.stringify(registration.registration)}`)
    }
    for (const field of ENFORCED_NUMBER_FIELDS) {
      const value = enforced[field]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(`a passed replay gate requires enforced.${field} to be a number from 0 through 1`)
      }
    }
    if (!Number.isSafeInteger(enforced.seed) || enforced.seed < 0) {
      throw new TypeError('a passed replay gate requires enforced.seed to be a non-negative integer')
    }
    return 'replay-qualified'
  }
  throw new TypeError(`unknown replayGate value ${JSON.stringify(replayGate)}; expected it to be absent, "passed", or "failed"`)
}

/** The path of the first non-null calibratedBy value, or null when none exists. */
function findCalibratedBy(value, path = '$') {
  if (Array.isArray(value)) {
    for (const [index, member] of value.entries()) {
      const found = findCalibratedBy(member, `${path}[${index}]`)
      if (found !== null) return found
    }
    return null
  }
  if (value === null || typeof value !== 'object') return null
  for (const [key, member] of Object.entries(value)) {
    if (key === 'calibratedBy' && member !== null) return `${path}.${key}`
    const found = findCalibratedBy(member, `${path}.${key}`)
    if (found !== null) return found
  }
  return null
}
