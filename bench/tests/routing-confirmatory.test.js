/**
 * Confirmatory-overlay adoption tests: the runner flag reads the replay
 * writer's generated R and N overlays in place of the committed provisional
 * ones. The guard requires the flag, the replay-qualified phase, and exact
 * equality against the adopted files; the renderer emits the adopted body; the
 * manifest pins the adopted files by sha256. Keyless: every artifact lives in
 * a temp tree and no replay, registration write, or model call runs.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { computeReplayMetrics } from '../analysis/replay-metrics.js'
import { fixtureMethod, fixtureRow } from './replay-fixture-method.js'
import { renderArmOverlay, getArm } from '../runner/arms.js'
import { assertConfirmatoryRegistration, loadConfirmatoryOverlays, parseArgs } from '../runner/run.js'
import { validateRunManifest } from '../schema/run-manifest.js'
import { DRAFT_STATUS, REGISTRATION_STATUS } from '../routing/registration-phase.js'
import { writeRegistration } from '../routing/write-registration.js'

const routingDir = fileURLToPath(new URL('../routing/', import.meta.url))
/** The calibrated operating point only a generated overlay carries. */
const CALIBRATED_POINT = /"engine":"laya","downgradeThreshold":[\d.]+,"downgradeMargin":[\d.]+,"calibratedBy":"[^"]+"/
const REGISTRATION = 'prereg-2026-10.registration.json'
const R_OVERLAY = 'route-coldpoint.patch.yml'
const N_OVERLAY = 'random-matched.patch.yml'

function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), 'pr16-confirmatory.'))
  const benchRoot = join(root, 'bench')
  mkdirSync(join(benchRoot, 'routing'), { recursive: true })
  for (const name of [REGISTRATION, R_OVERLAY, N_OVERLAY]) {
    copyFileSync(join(routingDir, name), join(benchRoot, 'routing', name))
  }
  const path = join(benchRoot, 'routing', REGISTRATION)
  const registration = JSON.parse(readFileSync(path, 'utf8'))
  // The committed document is a draft; this temp copy explicitly simulates
  // the frozen preregistration required by confirmatory adoption.
  registration.status = REGISTRATION_STATUS
  registration.registeredAt = '2026-10-16'
  delete registration.draftedAt
  registration.method = fixtureMethod()
  writeFileSync(path, JSON.stringify(registration))
  return { root, benchRoot }
}

/** A copied draft with a complete test-only method. */
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

function row(overrides) {
  return fixtureRow({
    task: 'task', stratum: 'routine', coldPointId: 'c1',
    eligible: true, answered: true, truncated: false, headTokens: 100,
    winner: 'flash', confidence: 0.9, margin: 0.5, pCheap: 0.9, difficultyScore: 1,
    cheapSufficient: true, ...overrides,
  })
}

/** Passing replay metrics computed with the copied registration's own gate bounds. */
function passingMetrics(benchRoot) {
  const registration = JSON.parse(readFileSync(join(benchRoot, 'routing', REGISTRATION), 'utf8'))
  const rOverlay = readFileSync(join(benchRoot, 'routing', R_OVERLAY), 'utf8')
  const { aurocMin, falseDowngradeMax, coverageMin } = registration.operatingPoint.layaGate
  const entryScoreCeiling = Number(rOverlay.match(/"entryScoreCeiling":(\d+)/)[1])
  const candidates = JSON.parse(rOverlay.match(/\bcandidates: (\[.*\])$/m)[1])
  const rows = [
    row({ task: 'a', confidence: 0.9, margin: 0.5, pCheap: 0.9 }),
    row({ task: 'b', confidence: 0.9, margin: 0.3, pCheap: 0.8 }),
    row({ task: 'c', confidence: 0.7, margin: 0.2, pCheap: 0.7, stratum: 'hard' }),
    row({ task: 'd', confidence: 0.7, margin: 0.2, pCheap: 0.1, cheapSufficient: false, stratum: 'hard' }),
    fixtureRow({ task: 'e', stratum: 'hard', coldPointId: 'c1', eligible: false, answered: false, truncated: null, headTokens: null, winner: null, confidence: null, margin: null, pCheap: null, difficultyScore: null, cheapSufficient: true }),
  ]
  return computeReplayMetrics(rows, {
    method: fixtureMethod(),
    gate: { aurocMin, falseDowngradeMax, coverageMin },
    entry: { entryScoreCeiling, candidateIds: candidates.map(candidate => candidate.id) },
  })
}

/** A temp tree whose registration is replay-qualified, with the generated overlays. */
function qualifiedTree() {
  const { root, benchRoot } = fixtureTree()
  writeRegistration({
    registrationPath: join(benchRoot, 'routing', REGISTRATION),
    metrics: passingMetrics(benchRoot),
    seed: 20261016,
    outDir: join(root, 'out'),
  })
  return { root, benchRoot, outDir: join(root, 'out') }
}

test('confirmatory runs require the flag; the provisional overlays never confirm', async () => {
  const { benchRoot } = fixtureTree()
  await assert.rejects(
    () => assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'] }),
    /--confirmatory-overlays.*never confirm a run/s,
  )
})

test('a draft cannot authorize confirmatory overlays, even with a tampered passed gate', async () => {
  const { root, benchRoot } = draftTree()
  const path = join(benchRoot, 'routing', REGISTRATION)
  const registration = JSON.parse(readFileSync(path, 'utf8'))
  registration.replayGate = 'passed'
  registration.enforced = {
    calibratedBy: registration.registration,
    downgradeThreshold: 0.9,
    downgradeMargin: 0.3,
    entryRate: 0.5,
    realizedREntryRate: 0.5,
    seed: 20261016,
  }
  writeFileSync(path, JSON.stringify(registration))
  const adopted = join(root, 'adopted')
  mkdirSync(adopted, { recursive: true })
  await assert.rejects(
    () => assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'], confirmatoryOverlaysDir: adopted }),
    /draft registration cannot carry replayGate/,
  )
})

test('the writer\'s generated overlays are accepted with exact equality', async () => {
  const { root, benchRoot, outDir } = qualifiedTree()
  await assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'], confirmatoryOverlaysDir: outDir })
  // The committed routing/ overlays still hold their provisional point: the
  // guard read the adopted directory, not them.
  const provisional = readFileSync(join(benchRoot, 'routing', R_OVERLAY), 'utf8')
  assert.doesNotMatch(provisional, CALIBRATED_POINT)
})

test('a tampered generated overlay is refused', async () => {
  const { root, benchRoot, outDir } = qualifiedTree()
  const rPath = join(outDir, R_OVERLAY)
  writeFileSync(rPath, readFileSync(rPath, 'utf8').replace('"downgradeMargin":0.3', '"downgradeMargin":0.4'))
  await assert.rejects(
    () => assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'], confirmatoryOverlaysDir: outDir }),
    /differs from the registration/,
  )
})

test('adopting the provisional content in place of generated overlays is refused', async () => {
  const { root, benchRoot, outDir } = qualifiedTree()
  const provisionalDir = join(root, 'provisional')
  mkdirSync(provisionalDir, { recursive: true })
  // The writer never touches the committed overlays, so they still hold the
  // provisional point: adopting that content must refuse even though the
  // registration itself is now replay-qualified.
  copyFileSync(join(benchRoot, 'routing', R_OVERLAY), join(provisionalDir, R_OVERLAY))
  copyFileSync(join(benchRoot, 'routing', N_OVERLAY), join(provisionalDir, N_OVERLAY))
  await assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'], confirmatoryOverlaysDir: outDir })
  await assert.rejects(
    () => assertConfirmatoryRegistration({ benchRoot, arms: ['route-coldpoint', 'route-random'], confirmatoryOverlaysDir: provisionalDir }),
    /no calibrated operating point/,
  )
})

test('loadConfirmatoryOverlays returns bodies and hashes, and refuses a missing file', () => {
  const { root, benchRoot, outDir } = qualifiedTree()
  const loaded = loadConfirmatoryOverlays(outDir)
  assert.equal(loaded.dir, outDir)
  assert.match(loaded.bodies.get('route-coldpoint'), /calibratedBy/)
  assert.match(loaded.sha256s[R_OVERLAY], /^[0-9a-f]{64}$/)
  assert.throws(() => loadConfirmatoryOverlays(join(root, 'absent')), /missing the generated overlay/)
})

test('renderArmOverlay emits the adopted body with the session root baked', () => {
  const { root, benchRoot, outDir } = qualifiedTree()
  const loaded = loadConfirmatoryOverlays(outDir)
  const sessionLogRoot = join(root, 'sessions', 't')
  const adopted = renderArmOverlay(getArm('route-coldpoint'), { sessionLogRoot, pinnedBody: loaded.bodies.get('route-coldpoint') })
  assert.match(adopted, CALIBRATED_POINT)
  assert.match(adopted, new RegExp(sessionLogRoot.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const committed = renderArmOverlay(getArm('route-coldpoint'), { sessionLogRoot })
  assert.doesNotMatch(committed, CALIBRATED_POINT, 'without the flag the committed provisional body renders')
})

test('parseArgs reads the flag and refuses an empty value', () => {
  assert.equal(parseArgs(['--experiment', 'e', '--confirmatory-overlays', '/tmp/gen']).confirmatoryOverlays, '/tmp/gen')
  assert.equal(parseArgs(['--experiment', 'e']).confirmatoryOverlays, undefined)
  assert.throws(() => parseArgs(['--experiment', 'e', '--confirmatory-overlays']), /--confirmatory-overlays needs a value/)
})

test('the manifest pins the adopted overlays by sha256', () => {
  const manifest = {
    version: 1, experiment: 'e', arm: 'route-coldpoint', model: 'm', gitCommit: 'g',
    startedAt: new Date().toISOString(), endedAt: '', armConfig: {}, temperature: 1, repeats: 1,
    taskIds: ['t'], baseUrl: null, apiKeyEnv: 'K', tierPatches: [],
    confirmatoryOverlays: { dir: '/tmp/gen', sha256s: { [R_OVERLAY]: 'a'.repeat(64) } },
  }
  validateRunManifest(manifest)
  assert.throws(
    () => validateRunManifest({ ...manifest, confirmatoryOverlays: { dir: '/tmp/gen', sha256s: { [R_OVERLAY]: 'nothex' } } }),
    /hex sha256/,
  )
  assert.throws(
    () => validateRunManifest({ ...manifest, confirmatoryOverlays: { sha256s: {} } }),
    /non-empty dir/,
  )
})
