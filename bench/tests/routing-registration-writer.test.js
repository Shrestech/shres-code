/**
 * Registration-writer tests: the full round trip from replay metrics through
 * the writer to `run.js assertConfirmatoryRegistration`, the failed-gate
 * registration the runner refuses, the finalized-overwrite refusal, the
 * tampered-overlay refusal, and the distinct coverage/entry-rate denominators.
 * Keyless throughout: every artifact lives in a temp tree, and the committed
 * registration and provisional overlays are only read.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { computeReplayMetrics as computeMetrics } from '../analysis/replay-metrics.js'
import { fixtureMethod, fixtureRow } from './replay-fixture-method.js'
import { parseReplayMethod } from '../routing/replay-method.js'
import { DRAFT_STATUS, REGISTRATION_STATUS } from '../routing/registration-phase.js'
import { writeRegistration } from '../routing/write-registration.js'
import { assertConfirmatoryRegistration } from '../runner/run.js'

const execFileP = promisify(execFile)
const routingDir = fileURLToPath(new URL('../routing/', import.meta.url))
const REGISTRATION = 'prereg-2026-10.registration.json'
const R_OVERLAY = 'route-coldpoint.patch.yml'
const N_OVERLAY = 'random-matched.patch.yml'

/** Keep the arithmetic fixtures independent of method-hash serialization. */
function computeReplayMetrics(rows, { eceBins, tieBreak, ...options }) {
  const method = fixtureMethod({ eceBins, tieBreak })
  const { methodSha256 } = parseReplayMethod(method, { require: ['version', 'eceBins', 'tieBreak'] })
  return computeMetrics(rows.map(row => ({ ...row, methodSha256 })), { ...options, method })
}

/** One replayed cold-point row of the labelled-scores fixture. */
function row(overrides) {
  return fixtureRow({
    task: 'task', stratum: 'routine', coldPointId: 'c1',
    eligible: true, answered: true, truncated: false, headTokens: 100,
    winner: 'flash', confidence: 0.9, margin: 0.5, pCheap: 0.9, difficultyScore: 1,
    cheapSufficient: true, ...overrides,
  })
}

/** The unanswered shape. */
function unansweredRow(overrides) {
  return fixtureRow({
    task: 'task', stratum: 'hard', coldPointId: 'c1',
    eligible: false, answered: false, truncated: null, headTokens: null,
    winner: null, confidence: null, margin: null, pCheap: null, difficultyScore: null,
    cheapSufficient: true, ...overrides,
  })
}

/**
 * Fixture with different denominators: five cold-point rows, four eligible,
 * two routes at the chosen point — coverage 0.4 over all rows, entry rate 0.5
 * over eligible rows. Arm N's draw matches the entry rate, not the coverage.
 */
function denominatorsRows() {
  return [
    row({ task: 'a', confidence: 0.9, margin: 0.5, pCheap: 0.9 }),
    row({ task: 'b', confidence: 0.9, margin: 0.3, pCheap: 0.8 }),
    row({ task: 'c', confidence: 0.7, margin: 0.2, pCheap: 0.7, stratum: 'hard' }),
    row({ task: 'd', confidence: 0.7, margin: 0.2, pCheap: 0.1, cheapSufficient: false, stratum: 'hard' }),
    unansweredRow({ task: 'e' }),
  ]
}

/** Metrics whose gate passes, computed with the copied registration's own bounds. */
function passingMetrics(benchRoot) {
  const registration = JSON.parse(readFileSync(join(benchRoot, 'routing', REGISTRATION), 'utf8'))
  const rOverlay = readFileSync(join(benchRoot, 'routing', R_OVERLAY), 'utf8')
  const { aurocMin, falseDowngradeMax, coverageMin, eceMax } = registration.operatingPoint.layaGate
  const entryScoreCeiling = Number(rOverlay.match(/"entryScoreCeiling":(\d+)/)[1])
  const candidates = JSON.parse(rOverlay.match(/\bcandidates: (\[.*\])$/m)[1])
  return computeReplayMetrics(denominatorsRows(), {
    eceBins: 10,
    tieBreak: ['falseDowngrade', 'downgradeThreshold', 'downgradeMargin'],
    gate: { aurocMin, falseDowngradeMax, coverageMin, eceMax },
    entry: { entryScoreCeiling, candidateIds: candidates.map(candidate => candidate.id) },
  })
}

/** Metrics whose AUROC leg fails while a feasible, wide-enough point exists. */
function failingMetrics() {
  // Tied pCheap scores rank the label no better than chance (AUROC 0.5), while
  // the curve still holds a clean feasible point — the gate fails on AUROC only.
  const rows = denominatorsRows().map(entry => (entry.answered ? { ...entry, pCheap: 0.5 } : entry))
  return computeReplayMetrics(rows, {
    eceBins: 10,
    tieBreak: ['falseDowngrade', 'downgradeThreshold', 'downgradeMargin'],
    gate: { aurocMin: 0.7, falseDowngradeMax: 0.1, coverageMin: 0.15, eceMax: 0.1 },
    entry: { entryScoreCeiling: 2, candidateIds: ['flash'] },
  })
}

/** A temp bench tree holding the committed registration and provisional overlays. */
function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), 'pr16-writer-test.'))
  const benchRoot = join(root, 'bench')
  mkdirSync(join(benchRoot, 'routing'), { recursive: true })
  for (const name of [REGISTRATION, R_OVERLAY, N_OVERLAY]) {
    copyFileSync(join(routingDir, name), join(benchRoot, 'routing', name))
  }
  const registrationPath = join(benchRoot, 'routing', REGISTRATION)
  const registration = JSON.parse(readFileSync(registrationPath, 'utf8'))
  // The committed document is a draft; this temp copy explicitly simulates
  // the frozen preregistration required by the writer round-trip.
  registration.status = REGISTRATION_STATUS
  registration.registeredAt = '2026-10-16'
  delete registration.draftedAt
  registration.method = fixtureMethod()
  writeFileSync(registrationPath, JSON.stringify(registration))
  return { root, benchRoot }
}

/** A temp tree whose owner-pending draft has a complete test-only method. */
function draftTree() {
  const tree = fixtureTree()
  const path = join(tree.benchRoot, 'routing', REGISTRATION)
  const registration = JSON.parse(readFileSync(path, 'utf8'))
  registration.status = DRAFT_STATUS
  registration.registeredAt = null
  registration.draftedAt = '2026-09-27'
  writeFileSync(path, JSON.stringify(registration))
  return tree
}

/** Every path whose `calibratedBy` key carries a non-null value. */
function nonNullCalibratedBy(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((member, at) => nonNullCalibratedBy(member, `${path}[${at}]`, found))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, member] of Object.entries(value)) {
      if (key === 'calibratedBy' && member !== null) found.push(`${path}.${key}`)
      nonNullCalibratedBy(member, `${path}.${key}`, found)
    }
  }
  return found
}

test('a passed gate finalizes the registration and the runner accepts the generated overlays', async () => {
  const { root, benchRoot } = fixtureTree()
  const metrics = passingMetrics(benchRoot)
  const result = writeRegistration({
    registrationPath: join(benchRoot, 'routing', REGISTRATION),
    metrics,
    seed: 20261016,
    outDir: join(root, 'out'),
  })
  assert.equal(result.replayGate, 'passed')
  assert.deepEqual(result.enforced, {
    calibratedBy: 'prereg-2026-10',
    downgradeThreshold: metrics.operatingPoint.downgradeThreshold,
    downgradeMargin: metrics.operatingPoint.downgradeMargin,
    entryRate: metrics.operatingPoint.entryRate,
    realizedREntryRate: metrics.operatingPoint.entryRate,
    seed: 20261016,
  })
  // The denominators stay distinct: the gate's coverage divides by all five
  // cold-point rows, the enforced rate by the four eligible rows.
  assert.ok(Math.abs(metrics.operatingPoint.coverage - 0.4) < 1e-12)
  assert.ok(Math.abs(result.enforced.entryRate - 0.5) < 1e-12)
  assert.notEqual(result.enforced.entryRate, metrics.operatingPoint.coverage)
  const finalized = JSON.parse(readFileSync(join(benchRoot, 'routing', REGISTRATION), 'utf8'))
  assert.equal(finalized.replayGate, 'passed')
  assert.deepEqual(finalized.enforced, result.enforced)
  const { methodSha256, ...methodFields } = metrics.method
  assert.deepEqual(finalized.method, methodFields, 'the existing owner method is preserved')
  assert.equal(finalized.replayMetrics.method.methodSha256, methodSha256)
  assert.equal(finalized.status, 'preregistered', 'the static status survives the finalize untouched')
  assert.equal(finalized.authorizes, 'confirmatory preparation only; real-spend runs require explicit owner approval; default-on requires a confirmatory decision and owner approval')
  assert.deepEqual(finalized.replayMetrics, metrics)
  await assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'], confirmatoryOverlaysDir: join(root, 'out') })
  const nText = readFileSync(result.overlays.randomMatched, 'utf8')
  assert.match(nText, /entryRate: 0\.5\n/)
  assert.match(nText, /seed: 20261016\n/)
  const nPoint = nText.split('\n').find(line => line.includes('operatingPoints'))
  assert.ok(nPoint.includes('"engine":"bench-random"'))
  assert.ok(!nPoint.includes('calibratedBy'), "N's inert operating point stays uncalibrated")
  const rText = readFileSync(result.overlays.routeColdpoint, 'utf8')
  assert.doesNotMatch(rText, /PROVISIONAL/, 'the generated overlay does not ship the provisional paragraph')
})

test('a draft cannot write calibration or confirmatory overlays even with a passed metric', () => {
  const { root, benchRoot } = draftTree()
  const registrationPath = join(benchRoot, 'routing', REGISTRATION)
  const before = readFileSync(registrationPath)
  assert.throws(
    () => writeRegistration({ registrationPath, metrics: passingMetrics(benchRoot), seed: 20261016, outDir: join(root, 'out') }),
    /draft.*cannot be calibrated/,
  )
  assert.ok(before.equals(readFileSync(registrationPath)))
  assert.equal(existsSync(join(root, 'out')), false)
})

test('a failed gate records no calibration, and the runner refuses the registration', async () => {
  const { root, benchRoot } = fixtureTree()
  const metrics = failingMetrics()
  assert.equal(metrics.gate.passed, false)
  assert.notEqual(metrics.operatingPoint, null, 'a feasible point can exist while the gate fails on AUROC')
  const result = writeRegistration({
    registrationPath: join(benchRoot, 'routing', REGISTRATION),
    metrics,
    seed: 20261016,
    outDir: join(root, 'out'),
  })
  assert.equal(result.replayGate, 'failed')
  assert.equal(result.enforced, undefined)
  assert.equal(result.overlays, undefined)
  const finalized = JSON.parse(readFileSync(join(benchRoot, 'routing', REGISTRATION), 'utf8'))
  assert.equal(finalized.replayGate, 'failed')
  assert.equal(finalized.status, 'preregistered', 'the static status survives the finalize untouched')
  assert.ok(!('enforced' in finalized))
  assert.deepEqual(nonNullCalibratedBy(finalized), [], 'no calibratedBy value is fabricated anywhere')
  assert.deepEqual(finalized.replayMetrics, JSON.parse(JSON.stringify(metrics)), 'the metrics are embedded for the record')
  assert.ok(!existsSync(join(root, 'out')), 'a failed gate generates no confirmatory overlays')
  // With a directory adopted, the guard reaches the phase check and names the
  // failed gate; without it, the flag requirement refuses first.
  await assert.rejects(
    () => assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'] }),
    /--confirmatory-overlays/,
  )
  const emptyDir = join(root, 'adopted')
  mkdirSync(emptyDir, { recursive: true })
  await assert.rejects(
    () => assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'], confirmatoryOverlaysDir: emptyDir }),
    /replay gate failed, so routing stays shadow-only/,
  )
})

test('the runner names the phase: a provisional registration is refused, a replay-qualified one accepted', async () => {
  const { root, benchRoot } = fixtureTree()
  const emptyDir = join(root, 'adopted')
  mkdirSync(emptyDir, { recursive: true })
  await assert.rejects(
    () => assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'], confirmatoryOverlaysDir: emptyDir }),
    /still provisional/,
  )
})

test('inconsistent and non-provisional inputs are refused before any write', () => {
  const { root, benchRoot } = fixtureTree()
  const metrics = passingMetrics(benchRoot)
  const driftStatus = join(benchRoot, 'routing', 'drifted-status.json')
  const drifted = JSON.parse(readFileSync(join(benchRoot, 'routing', REGISTRATION), 'utf8'))
  drifted.status = 'preregistered-provisional-uncalibrated'
  writeFileSync(driftStatus, JSON.stringify(drifted, null, 2))
  assert.throws(
    () => writeRegistration({ registrationPath: driftStatus, metrics, seed: 20261016, outDir: join(root, 'out') }),
    /status must be "draft" or "preregistered"/,
  )
  const withEnforced = join(benchRoot, 'routing', 'with-enforced.json')
  const finalized = JSON.parse(readFileSync(join(benchRoot, 'routing', REGISTRATION), 'utf8'))
  finalized.replayGate = 'failed'
  finalized.enforced = { calibratedBy: 'prereg-2026-10' }
  writeFileSync(withEnforced, JSON.stringify(finalized, null, 2))
  assert.throws(
    () => writeRegistration({ registrationPath: withEnforced, metrics, seed: 20261016, outDir: join(root, 'out') }),
    /a failed replay gate records no enforced block/,
  )
})

test('a finalized registration is never overwritten', () => {
  const { root, benchRoot } = fixtureTree()
  const registrationPath = join(benchRoot, 'routing', REGISTRATION)
  writeRegistration({ registrationPath, metrics: passingMetrics(benchRoot), seed: 20261016, outDir: join(root, 'out') })
  assert.throws(
    () => writeRegistration({ registrationPath, metrics: passingMetrics(benchRoot), seed: 20261016, outDir: join(root, 'other') }),
    /already finalized/,
  )
  const failedTree = fixtureTree()
  const failedPath = join(failedTree.benchRoot, 'routing', REGISTRATION)
  writeRegistration({ registrationPath: failedPath, metrics: failingMetrics(), seed: 20261016, outDir: join(failedTree.root, 'out') })
  assert.throws(
    () => writeRegistration({ registrationPath: failedPath, metrics: passingMetrics(failedTree.benchRoot), seed: 1, outDir: join(failedTree.root, 'other') }),
    /already finalized/,
    'a failed gate finalizes the registration too',
  )
})

test('a tampered overlay value is refused by the runner', async () => {
  const { root, benchRoot } = fixtureTree()
  const outDir = join(root, 'out')
  const result = writeRegistration({
    registrationPath: join(benchRoot, 'routing', REGISTRATION),
    metrics: passingMetrics(benchRoot),
    seed: 20261016,
    outDir,
  })
  await assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'], confirmatoryOverlaysDir: outDir })
  const rPath = join(outDir, R_OVERLAY)
  writeFileSync(rPath, readFileSync(rPath, 'utf8').replace(String(result.enforced.downgradeThreshold), '0.85'))
  await assert.rejects(
    () => assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'], confirmatoryOverlaysDir: outDir }),
    /differs from the registration/,
  )
})

test('writes are atomic: the registration stays valid JSON and no temp file survives', () => {
  const { root, benchRoot } = fixtureTree()
  writeRegistration({
    registrationPath: join(benchRoot, 'routing', REGISTRATION),
    metrics: passingMetrics(benchRoot),
    seed: 20261016,
    outDir: join(root, 'out'),
  })
  const files = readdirSync(join(benchRoot, 'routing'))
  assert.ok(files.every(name => !name.includes('.tmp-')), `no temp file survives: ${files.join(', ')}`)
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(benchRoot, 'routing', REGISTRATION), 'utf8')))
})

test('registration failure rolls back only this attempt’s overlay pair', () => {
  const { root, benchRoot } = fixtureTree()
  const registrationPath = join(benchRoot, 'routing', REGISTRATION)
  const outDir = join(root, 'existing-out')
  mkdirSync(outDir)
  const retainedPath = join(outDir, 'retain.txt')
  writeFileSync(retainedPath, 'keep this file\n')
  const before = readFileSync(registrationPath)
  assert.throws(
    () => writeRegistration({
      registrationPath,
      metrics: passingMetrics(benchRoot),
      seed: 20261016,
      outDir,
    }, { writeRegistrationFile: () => { throw new Error('injected registration write failure') } }),
    /injected registration write failure/,
  )
  assert.ok(before.equals(readFileSync(registrationPath)), 'registration bytes remain provisional')
  assert.equal(readFileSync(retainedPath, 'utf8'), 'keep this file\n')
  assert.deepEqual(readdirSync(outDir), ['retain.txt'])

  const second = fixtureTree()
  const secondRegistration = join(second.benchRoot, 'routing', REGISTRATION)
  const secondOut = join(second.root, 'created-out')
  assert.throws(
    () => writeRegistration({
      registrationPath: secondRegistration,
      metrics: passingMetrics(second.benchRoot),
      seed: 20261016,
      outDir: secondOut,
    }, { writeRegistrationFile: () => { throw new Error('injected registration write failure') } }),
    /injected registration write failure/,
  )
  assert.equal(existsSync(secondOut), false, 'an output directory created by the attempt is removed')
})

test('refusals: missing registration, drifted schema, malformed metrics, and existing outputs', () => {
  const { root, benchRoot } = fixtureTree()
  const metrics = passingMetrics(benchRoot)
  assert.throws(
    () => writeRegistration({ registrationPath: join(benchRoot, 'routing', 'absent.json'), metrics, seed: 20261016, outDir: join(root, 'out') }),
    /does not exist/,
  )
  const drifted = join(benchRoot, 'routing', 'drifted.json')
  writeFileSync(drifted, JSON.stringify({ schema: 'other@1', registration: 'drifted' }))
  assert.throws(() => writeRegistration({ registrationPath: drifted, metrics, seed: 20261016, outDir: join(root, 'out') }), /schema/)
  const badGate = { ...metrics, gate: { ...metrics.gate, passed: undefined } }
  assert.throws(
    () => writeRegistration({ registrationPath: join(benchRoot, 'routing', REGISTRATION), metrics: badGate, seed: 20261016, outDir: join(root, 'out') }),
    /gate\.passed/,
  )
  const noPoint = { ...metrics, operatingPoint: null }
  assert.throws(
    () => writeRegistration({ registrationPath: join(benchRoot, 'routing', REGISTRATION), metrics: noPoint, seed: 20261016, outDir: join(root, 'out') }),
    /operatingPoint/,
  )
  const noRate = { ...metrics, operatingPoint: { ...metrics.operatingPoint, entryRate: null } }
  assert.throws(
    () => writeRegistration({ registrationPath: join(benchRoot, 'routing', REGISTRATION), metrics: noRate, seed: 20261016, outDir: join(root, 'out') }),
    /entryRate/,
    'an enforced rate must be a real number, never a missing denominator',
  )
  assert.throws(
    () => writeRegistration({ registrationPath: join(benchRoot, 'routing', REGISTRATION), metrics, seed: 1.5, outDir: join(root, 'out') }),
    /seed/,
  )
  writeRegistration({ registrationPath: join(benchRoot, 'routing', REGISTRATION), metrics, seed: 20261016, outDir: join(root, 'out') })
  const secondTree = fixtureTree()
  assert.throws(
    () => writeRegistration({
      registrationPath: join(secondTree.benchRoot, 'routing', REGISTRATION),
      metrics: passingMetrics(secondTree.benchRoot),
      seed: 20261016,
      outDir: join(root, 'out'),
    }),
    /already exists/,
    'the writer never overwrites an output file',
  )
})

test('the CLI writes a passed registration and refuses a usage error', async () => {
  const { root, benchRoot } = fixtureTree()
  const script = fileURLToPath(new URL('../routing/write-registration.js', import.meta.url))
  const metricsPath = join(root, 'metrics.json')
  writeFileSync(metricsPath, JSON.stringify(passingMetrics(benchRoot)))
  await execFileP(process.execPath, [
    script, metricsPath, '--seed', '20261016',
    '--registration', join(benchRoot, 'routing', REGISTRATION),
    '--out-dir', join(root, 'out'),
  ])
  const finalized = JSON.parse(readFileSync(join(benchRoot, 'routing', REGISTRATION), 'utf8'))
  assert.equal(finalized.replayGate, 'passed')
  await assert.rejects(
    execFileP(process.execPath, [script, metricsPath, '--registration', join(benchRoot, 'routing', REGISTRATION), '--out-dir', join(root, 'out2')]),
    error => error.code === 2 && /--seed/.test(error.stderr),
  )
})

test('missing or mismatched owner method writes no files and leaves registration bytes unchanged', () => {
  for (const variant of ['missing', 'partial', 'mismatch', 'bad-hash', 'unevaluated']) {
    const { root, benchRoot } = fixtureTree()
    const registrationPath = join(benchRoot, 'routing', REGISTRATION)
    const metrics = passingMetrics(benchRoot)
    const registration = JSON.parse(readFileSync(registrationPath, 'utf8'))
    if (variant === 'missing') delete registration.method
    if (variant === 'partial') delete registration.method.finalWindow
    if (variant === 'mismatch') registration.method.eceBins += 1
    if (variant === 'bad-hash') metrics.method.methodSha256 = '0'.repeat(64)
    if (variant === 'unevaluated') metrics.gate = { ...metrics.gate, status: 'method-unpinned', passed: null }
    writeFileSync(registrationPath, JSON.stringify(registration))
    const before = readFileSync(registrationPath)
    const outDir = join(root, 'not-created')
    assert.throws(() => writeRegistration({ registrationPath, metrics, seed: 7, outDir }), /method|not evaluated/)
    assert.ok(before.equals(readFileSync(registrationPath)))
    assert.equal(existsSync(outDir), false)
  }
})
