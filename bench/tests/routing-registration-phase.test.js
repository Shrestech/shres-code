/**
 * Registration-phase tests: one case per phase, one per inconsistency, and
 * acceptance of the real committed registration. The phase is the one reading
 * of `replayGate` + `status` every other tool shares.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { DRAFT_STATUS, REGISTRATION_STATUS, registrationPhase } from '../routing/registration-phase.js'
import { fixtureMethod } from './replay-fixture-method.js'

/** A minimal consistent provisional registration. */
function provisional() {
  return {
    schema: 'shres-code/routing-measurement@1',
    method: fixtureMethod(),
    registration: 'prereg-2026-10',
    status: REGISTRATION_STATUS,
    authorizes: 'confirmatory preparation only; real-spend runs require explicit owner approval; default-on requires a confirmatory decision and owner approval',
  }
}

/** A draft registration before the owner freezes the method and budget. */
function draft() {
  return {
    ...provisional(),
    status: DRAFT_STATUS,
    draftedAt: '2026-09-27',
    registeredAt: null,
  }
}

/** A complete enforced block, as the writer builds it. */
function enforced() {
  return {
    calibratedBy: 'prereg-2026-10',
    downgradeThreshold: 0.9,
    downgradeMargin: 0.3,
    entryRate: 0.5,
    realizedREntryRate: 0.5,
    seed: 20261016,
  }
}

test('the committed registration reads as a draft', () => {
  const committed = JSON.parse(readFileSync(fileURLToPath(new URL('../routing/prereg-2026-10.registration.json', import.meta.url)), 'utf8'))
  assert.equal(registrationPhase(committed), 'draft')
  assert.equal(committed.status, DRAFT_STATUS)
  assert.equal(committed.draftedAt, '2026-09-27')
  assert.equal(committed.registeredAt, null)
})

test('one case per phase', () => {
  assert.equal(registrationPhase(draft()), 'draft')
  assert.equal(registrationPhase(provisional()), 'provisional')
  assert.equal(registrationPhase({ ...provisional(), replayGate: 'failed', replayMetrics: { reason: 'fixture' } }), 'replay-failed')
  assert.equal(registrationPhase({ ...provisional(), replayGate: 'passed', enforced: enforced() }), 'replay-qualified')
})

test('inconsistencies throw, one per case', () => {
  const base = provisional()
  assert.throws(() => registrationPhase(null), /JSON object/)
  assert.throws(() => registrationPhase({ ...base, status: 'preregistered-provisional-uncalibrated' }), /status must be "draft" or "preregistered"/)
  assert.throws(() => registrationPhase({ ...base, status: 'calibrated' }), /status must be "draft" or "preregistered"/)
  assert.throws(() => registrationPhase({ ...base, enforced: enforced() }), /without replayGate/)
  assert.throws(
    () => registrationPhase({ ...base, replayGate: 'failed', enforced: enforced() }),
    /a failed replay gate records no enforced block/,
  )
  assert.throws(
    () => registrationPhase({ ...base, replayGate: 'failed', operatingPoint: { provisional: { calibratedBy: 'prereg-2026-10' } } }),
    /a failed replay gate records no calibrated id/,
  )
  assert.throws(() => registrationPhase({ ...base, replayGate: 'passed' }), /requires the enforced block/)
  assert.throws(() => registrationPhase({ ...base, replayGate: 'passed', enforced: { ...enforced(), entryRate: undefined } }), /requires enforced.entryRate/)
  assert.throws(() => registrationPhase({ ...base, replayGate: 'passed', enforced: { ...enforced(), seed: 1.5 } }), /enforced.seed/)
  assert.throws(
    () => registrationPhase({ ...base, registration: 'other', replayGate: 'passed', enforced: enforced() }),
    /must be the registration id/,
  )
  assert.throws(() => registrationPhase({ ...base, replayGate: null }), /unknown replayGate value/)
  assert.throws(() => registrationPhase({ ...base, replayGate: 'skipped' }), /unknown replayGate value/)
  assert.throws(() => registrationPhase({ ...draft(), replayGate: 'passed' }), /draft registration cannot carry replayGate/)
  assert.throws(() => registrationPhase({ ...draft(), enforced: enforced() }), /draft registration cannot carry an enforced block/)
  assert.throws(() => registrationPhase({ ...draft(), replayMetrics: { gate: { passed: true } } }), /draft registration cannot carry replay metrics/)
  assert.throws(() => registrationPhase({ ...draft(), operatingPoint: { calibratedBy: 'prereg-2026-10' } }), /draft registration cannot carry a calibrated id/)
})
