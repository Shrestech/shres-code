/**
 * Replay-labeller tests on the real product-written fixture: the actual
 * storage codec decodes it (keeping its ignorable escalation event), the §4
 * label windows position triggers by data.triggerSeq, any decision choice
 * counts as fired, the caller-supplied cold points are the only label input,
 * and the consult fields stay deferred. Keyless: no model call, no
 * credential, no network. The codec imports declare the pnpm-run-build
 * dependency and fail loud naming it.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { access, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { validateReplayRow } from '../analysis/replay-metrics.js'
import { ESCALATION_EVENT_NAMES, extractEscalationTriggerSeqs, labelReplayRows } from '../routing/replay-rows.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..', '..')
const FIXTURE = join(here, '..', 'routing', 'fixtures', 'replay-coldpoint-escalation.session.jsonl')
const SESSION_ID = 'bench-replay-coldpoint-escalation'
const HEADER_CWD = '/tmp/bench-replay-coldpoint'

/** Import one built package lib face, failing loud when the build is absent. */
async function builtLib(pkg) {
  const path = join(repo, pkg, 'lib', 'index.js')
  try {
    await access(path)
  } catch {
    throw new Error(`replay-rows tests decode the fixture with the actual storage codec, which needs the built ${pkg} lib; run pnpm run build first (${path} is absent)`)
  }
  return import(pathToFileURL(path).href)
}

/** Boot the real session store plus JSONL backend on a scratch root holding the fixture. */
async function decodeFixture() {
  const { Context } = await builtLib('vendor/cordis')
  const { SessionId, SessionStore } = await builtLib('packages/core/session')
  const { JsonlSessionPersistence } = await builtLib('packages/session/session-persistence-jsonl')
  const root = await mkdtemp(join(tmpdir(), 'bench-replay-rows-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore, {})
    await ctx.plugin(JsonlSessionPersistence, { root, packChunks: false, compression: 'none' })
    // The artifact must sit in the backend's own project/session layout; copy
    // the fixture there by its generated relative path.
    const projectDir = '--' + HEADER_CWD.replace(/^\//, '').replaceAll('/', '-') + '--'
    await cp(FIXTURE, join(root, projectDir, SESSION_ID, 'session.jsonl'))
    const { meta, events } = await ctx.sessionPersistence.inspect(SessionId(SESSION_ID))
    return { meta, events }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/** The cold points a replay frontend would hand the labeller for this fixture: one per step opening, in the router's stable turn/step id form. */
const FIXTURE_COLD_POINTS = [
  { coldPointId: 'turn:1/step:1', seq: 1 },
  { coldPointId: 'turn:1/step:2', seq: 6 },
  { coldPointId: 'turn:1/step:3', seq: 11 },
]

test('the actual storage codec decodes the product-written fixture and keeps the ignorable escalation event', async () => {
  const { meta, events } = await decodeFixture()
  assert.equal(meta.id, SESSION_ID)
  const decision = events.find(event => event.type === 'escalation/decision')
  assert.ok(decision, 'the codec dropped the ignorable escalation/decision record')
  assert.equal(decision.ignorable, true)
  assert.equal(decision.data.trigger, 'errorBurst')
  // The trigger fired through the engine-absent Stage 0 continue: any choice
  // counts as fired, and the window position is the trigger's evidence seq.
  assert.equal(decision.data.choice, 'continue')
  assert.equal(decision.data.triggerSeq, 8)
  assert.equal(decision.seq, 10)
})

test('the default escalation family is the worker-escalation event, positioned by triggerSeq rather than the decision seq', async () => {
  const { events } = await decodeFixture()
  assert.deepEqual(ESCALATION_EVENT_NAMES, ['escalation/decision'])
  assert.deepEqual(extractEscalationTriggerSeqs(events), [8])
})

test('the §4 windows follow the preregistered rule, and rows match the pinned schema with deferred consult fields', async () => {
  const { events } = await decodeFixture()
  const { rows, coldPoints, triggers } = labelReplayRows({
    task: 't', stratum: 'hard', events, coldPoints: FIXTURE_COLD_POINTS, taskPassed: true,
  })
  assert.equal(coldPoints, 3)
  assert.equal(triggers, 1)
  // Window (1, 6) holds no trigger: row 1 is cheap-sufficient. The trigger
  // evidence at seq 8 falls in (6, 11): row 2 is not. The last window runs
  // through the end of the log (seq 15 + 1): row 3 is cheap-sufficient.
  assert.deepEqual(rows.map(row => row.cheapSufficient), [true, false, true])
  assert.deepEqual(rows.map(row => row.coldPointId), ['turn:1/step:1', 'turn:1/step:2', 'turn:1/step:3'])
  for (const row of rows) validateReplayRow(row, 'fixture')
  assert.ok(rows.every(row => row.eligible === false && row.answered === false && row.pCheap === null))
})

test('a failed task labels every row false, and a custom escalation family is honored', async () => {
  const { events } = await decodeFixture()
  const failed = labelReplayRows({ task: 't', stratum: 'routine', events, coldPoints: FIXTURE_COLD_POINTS, taskPassed: false })
  assert.ok(failed.rows.every(row => row.cheapSufficient === false))
  const custom = labelReplayRows({
    task: 't', stratum: 'routine', events, coldPoints: FIXTURE_COLD_POINTS, taskPassed: true,
    escalationEventTypes: ['custom/trigger'],
  })
  assert.deepEqual(custom.rows.map(row => row.cheapSufficient), [true, true, true])
})

test('a caller-supplied cold-point list is the only label input: none supplied, nothing labelled', async () => {
  const { events } = await decodeFixture()
  assert.throws(
    () => labelReplayRows({ task: 't', stratum: 'hard', events, coldPoints: [], taskPassed: true }),
    /supplied no cold point/,
  )
  assert.throws(
    () => labelReplayRows({ task: 't', stratum: 'hard', events, coldPoints: [{ coldPointId: 'turn:1/step:1', seq: 1.5 }], taskPassed: true }),
    /safe-integer seq/,
  )
})

test('an escalation event without usable trigger evidence refuses to label', () => {
  assert.throws(
    () => extractEscalationTriggerSeqs([{ type: 'escalation/decision', data: { choice: 'continue' } }]),
    /safe-integer data.triggerSeq/,
  )
})
