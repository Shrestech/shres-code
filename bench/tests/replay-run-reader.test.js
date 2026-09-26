/**
 * Replay run reader: registration-located arms, include-all trials, and the
 * { trials, tasks, refused, discovered } composition over a synthetic run
 * directory built from the recorded real-CLI fixture, plus one keyless
 * launcher check of whole-run accounting through hostReplayRun.
 * @module
 */
import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { TrialInputIncompleteError } from '../routing/replay-frontend.js'
import { hostReplayRun } from '../routing/replay-frontend-host.js'
import { readReplayRun } from '../routing/replay-run-reader.js'
import { emptyMetrics } from '../runner/metrics.js'
import { encodeSegment, projectKey } from '../runner/session-layout.js'
import { UsageError } from '../runner/run.js'
import { fixtureMethod } from './replay-fixture-method.js'

/** The recorded real-CLI log: the unmodified fixture is the happy path. */
const RECORDED = await readFile(new URL('../routing/fixtures/replay-c-label-windows.session.jsonl', import.meta.url))
const RECORDED_HEADER = JSON.parse(RECORDED.toString('utf8').split('\n')[0])
const REPO = join(fileURLToPath(new URL('../..', import.meta.url)))

const REGISTRATION = {
  arms: {
    S: { runnerName: 'route-strong' },
    C: { runnerName: 'route-cheap' },
  },
}
const TASK_ID = 'reader-task'
const STRATUM = 'moderate'
const METHOD = fixtureMethod()

/** §5: the effective route is read from header.config; markers are ignored. */
const OWN_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }

/**
 * @param {'unmodified' | 'model-changed' | 'effort-changed' | 'markers-only' | 'torn' | 'interrupted'} variant
 * @returns {Buffer} the session artifact for that variant.
 */
function sessionBytes(variant) {
  const lines = RECORDED.toString('utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const rewritten = lines.map((line) => {
    if (variant === 'torn') return line
    if (!line.includes('"request/header"')) return line
    const record = JSON.parse(line)
    if (record.seq !== 28) return line
    if (variant === 'model-changed') record.data.header.config.model = 'deepseek-v4-flash'
    if (variant === 'effort-changed') record.data.header.config.reasoningEffort = 'low'
    if (variant === 'markers-only') record.data.header.adapterDefaults = { reasoningEffort: true, maxTokens: true }
    return JSON.stringify(record)
  })
  if (variant === 'interrupted') {
    for (const line of rewritten) {
      const record = JSON.parse(line)
      if (record.type === 'turn/end' && record.data?.reason?.kind === 'completed') {
        record.data.reason = { kind: 'interrupted' }
        rewritten[rewritten.indexOf(line)] = JSON.stringify(record)
        break
      }
    }
  }
  const text = rewritten.join('\n') + (variant === 'torn' ? '' : '\n')
  return Buffer.from(text.slice(0, variant === 'torn' ? text.length - 10 : undefined), 'utf8')
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {object} a complete trial record that passes validateTrial.
 */
function trialRecord(overrides = {}) {
  return {
    taskId: TASK_ID,
    trialIndex: 0,
    arm: 'route-strong',
    status: 'success',
    resolved: true,
    failureMode: null,
    verifier: { command: 'node verify.mjs', exitCode: 0 },
    metrics: emptyMetrics(),
    sessionFile: `sessions/${TASK_ID}/0/session.jsonl`,
    startedAt: '2026-10-16T00:00:00.000Z',
    endedAt: '2026-10-16T00:00:01.000Z',
    ...overrides,
  }
}

/**
 * Build one synthetic experiment: two registration arms under their runner
 * directories, two trials each (arm C trial 1 is an error trial, proving the
 * reader does not filter by status), every session planted at the persistence
 * identity path the runner records, and a task root with the stratum.
 * @param {{
 *   bytesFor?: (arm: string, trialIndex: number) => Buffer,
 *   sessionFile?: (arm: string, trialIndex: number) => string | null,
 *   skipArmDir?: 'C' | undefined,
 *   taskOverrides?: object,
 *   trialOverrides?: (arm: string, trialIndex: number) => object,
 *   registration?: object,
 * }} [options]
 */
async function buildRun(options = {}) {
  const {
    bytesFor = () => sessionBytes('unmodified'),
    sessionFile = (arm, trialIndex) => `sessions/${TASK_ID}/${trialIndex}/${projectKey(RECORDED_HEADER.cwd)}/${encodeSegment(RECORDED_HEADER.id)}/session.jsonl`,
    skipArmDir,
    taskOverrides,
    trialOverrides = () => ({}),
    registration = REGISTRATION,
  } = options
  const root = await mkdtemp(join(tmpdir(), 'bench-replay-run-reader-'))
  const experimentDir = join(root, 'experiment')
  const taskRoot = join(root, 'tasks')
  for (const [armName, spec] of Object.entries(REGISTRATION.arms)) {
    if (skipArmDir === armName) continue
    const armDir = join(experimentDir, spec.runnerName)
    const records = [0, 1].map((trialIndex) => {
      const override = sessionFile(armName, trialIndex)
      return trialRecord({
        taskId: TASK_ID,
        trialIndex,
        arm: spec.runnerName,
        sessionFile: override === undefined
          ? `sessions/${TASK_ID}/${trialIndex}/${projectKey(RECORDED_HEADER.cwd)}/${encodeSegment(RECORDED_HEADER.id)}/session.jsonl`
          : override,
        ...trialOverrides(armName, trialIndex),
        ...(armName === 'C' && trialIndex === 1
          ? { status: 'error', resolved: false, failureMode: 'AGENT_TIMEOUT' }
          : {}),
      })
    })
    await mkdir(armDir, { recursive: true })
    await writeFile(join(armDir, 'trials.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n')
    for (const trialIndex of [0, 1]) {
      const override = sessionFile(armName, trialIndex)
      const file = override === undefined ? `sessions/${TASK_ID}/${trialIndex}/${projectKey(RECORDED_HEADER.cwd)}/${encodeSegment(RECORDED_HEADER.id)}/session.jsonl` : override
      if (file === null) continue
      const sessionPath = join(armDir, file)
      await mkdir(sessionPath.slice(0, sessionPath.lastIndexOf('/')), { recursive: true })
      await writeFile(sessionPath, bytesFor(armName, trialIndex))
    }
  }
  await mkdir(join(taskRoot, TASK_ID), { recursive: true })
  await writeFile(join(taskRoot, TASK_ID, 'task.json'), JSON.stringify({
    taskId: TASK_ID, stratum: STRATUM, ...taskOverrides,
  }))
  return { root, input: { experimentDir, registration, taskRoot } }
}

async function withRun(options, fn) {
  const built = await buildRun(options)
  try {
    return await fn(built)
  } finally {
    await rm(built.root, { recursive: true, force: true })
  }
}

test('reads both registration arms, includes every trial regardless of status, and reads the unmodified recording as one route', async () => {
  await withRun({}, async ({ input }) => {
    const { trials, tasks, refused, discovered } = await readReplayRun(input)
    assert.deepEqual(trials.map(trial => trial.id), [
      `S/${TASK_ID}/0`, `S/${TASK_ID}/1`, `C/${TASK_ID}/0`, `C/${TASK_ID}/1`,
    ])
    assert.deepEqual(refused, [])
    assert.deepEqual(discovered, [
      `S/${TASK_ID}/0`, `S/${TASK_ID}/1`, `C/${TASK_ID}/0`, `C/${TASK_ID}/1`,
    ])
    for (const trial of trials) {
      assert.equal(trial.taskId, TASK_ID)
      assert.ok(trial.arm === 'S' || trial.arm === 'C')
      assert.deepEqual(trial.trialOwnRoute, OWN_ROUTE)
      assert.ok(trial.path.endsWith(join('session.jsonl')))
    }
    assert.equal(trials[0].trial.status, 'success')
    assert.equal(trials[3].trial.status, 'error')
    assert.equal(trials[3].trial.resolved, false)
    assert.equal(trials[3].trial.failureMode, 'AGENT_TIMEOUT')
    assert.deepEqual(tasks[TASK_ID]?.stratum, STRATUM)
  })
})

test('§5: a model change in one header is mixed-route', async () => {
  await withRun({
    bytesFor: (arm, trialIndex) => (arm === 'S' && trialIndex === 0 ? sessionBytes('model-changed') : sessionBytes('unmodified')),
  }, async ({ input }) => {
    const { trials, refused } = await readReplayRun(input)
    assert.deepEqual(refused.map(record => [record.id, record.reason]), [
      [`S/${TASK_ID}/0`, 'mixed-route'],
    ])
    assert.match(refused[0].path, /session\.jsonl$/)
    assert.equal(trials.length, 3)
  })
})

test('§5: an effective effort change in one header is mixed-route', async () => {
  await withRun({
    bytesFor: (arm, trialIndex) => (arm === 'S' && trialIndex === 0 ? sessionBytes('effort-changed') : sessionBytes('unmodified')),
  }, async ({ input }) => {
    const { refused } = await readReplayRun(input)
    assert.deepEqual(refused.map(record => [record.id, record.reason]), [
      [`S/${TASK_ID}/0`, 'mixed-route'],
    ])
  })
})

test('§5: a provenance-marker-only change is not mixed-route', async () => {
  await withRun({
    bytesFor: (arm, trialIndex) => (arm === 'S' && trialIndex === 0 ? sessionBytes('markers-only') : sessionBytes('unmodified')),
  }, async ({ input }) => {
    const { trials, refused } = await readReplayRun(input)
    assert.deepEqual(refused, [])
    assert.equal(trials.length, 4)
    assert.deepEqual(trials[0].trialOwnRoute, OWN_ROUTE)
  })
})

test('a missing arm directory is a UsageError naming the registration arm', async () => {
  await withRun({ skipArmDir: 'C' }, async ({ input }) => {
    await assert.rejects(readReplayRun(input), (error) => {
      assert.ok(error instanceof UsageError)
      assert.match(error.message, /replay arm C \(route-cheap\): missing arm directory/)
      return true
    })
  })
})

test('an arm directory without trials.jsonl is a UsageError', async () => {
  await withRun({}, async ({ root, input }) => {
    await rm(join(root, 'experiment', 'route-cheap', 'trials.jsonl'))
    await assert.rejects(readReplayRun(input), (error) => {
      assert.ok(error instanceof UsageError)
      assert.match(error.message, /route-cheap.*missing trials\.jsonl/)
      return true
    })
  })
})

test('a null sessionFile is a named refusal and never a fabricated route', async () => {
  await withRun({
    sessionFile: (arm, trialIndex) => (arm === 'C' && trialIndex === 1 ? null : undefined),
  }, async ({ input }) => {
    const { trials, refused, discovered } = await readReplayRun(input)
    assert.deepEqual(refused, [{
      id: `C/${TASK_ID}/1`,
      taskId: TASK_ID,
      trialIndex: 1,
      arm: 'C',
      path: null,
      reason: 'no-session-log',
    }])
    assert.deepEqual(trials.map(trial => trial.id), [`S/${TASK_ID}/0`, `S/${TASK_ID}/1`, `C/${TASK_ID}/0`])
    for (const trial of trials) assert.ok(trial.trialOwnRoute !== undefined)
    assert.equal(discovered.length, 4)
  })
})

test('refusals from both arms are collected together instead of short-circuiting the read', async () => {
  await withRun({
    sessionFile: (arm, trialIndex) => (arm === 'C' && trialIndex === 1 ? null : undefined),
    bytesFor: (arm, trialIndex) => (arm === 'S' && trialIndex === 0 ? sessionBytes('model-changed') : sessionBytes('unmodified')),
  }, async ({ input }) => {
    const { trials, refused, discovered } = await readReplayRun(input)
    assert.deepEqual(refused.map(record => [record.id, record.reason]), [
      [`S/${TASK_ID}/0`, 'mixed-route'],
      [`C/${TASK_ID}/1`, 'no-session-log'],
    ])
    assert.deepEqual(trials.map(trial => trial.id), [`S/${TASK_ID}/1`, `C/${TASK_ID}/0`])
    assert.deepEqual(discovered, [
      `S/${TASK_ID}/0`, `S/${TASK_ID}/1`, `C/${TASK_ID}/0`, `C/${TASK_ID}/1`,
    ])
  })
})

test('a chain trial is refused as outside the replay population', async () => {
  await withRun({}, async ({ root, input }) => {
    const chainPhase = {
      phaseIndex: 0,
      sessionFile: `sessions/${TASK_ID}/0/phase-0.jsonl`,
      resumedFrom: null,
      exitCode: 0,
      timedOut: false,
      budgetExceeded: false,
      metrics: emptyMetrics(),
      startedAt: '2026-10-16T00:00:00.000Z',
      endedAt: '2026-10-16T00:00:01.000Z',
    }
    const path = join(root, 'experiment', 'route-strong', 'trials.jsonl')
    const lines = (await readFile(path, 'utf8')).split('\n')
    lines[0] = JSON.stringify(trialRecord({ trialIndex: 0, arm: 'route-strong', phases: [chainPhase] }))
    await writeFile(path, lines.join('\n'))
    await assert.rejects(readReplayRun(input), (error) => {
      assert.ok(error instanceof UsageError)
      assert.match(error.message, /chain trials are not in the replay population: S\//)
      return true
    })
  })
})

test('a task without a preregistered stratum is a TypeError', async () => {
  await withRun({ taskOverrides: { stratum: undefined } }, async ({ input }) => {
    await assert.rejects(readReplayRun(input), (error) => {
      assert.ok(error instanceof TypeError)
      assert.match(error.message, /reader-task has no preregistered stratum/)
      return true
    })
  })
})

test('an invalid trial line surfaces the validateTrial error', async () => {
  await withRun({}, async ({ root, input }) => {
    const path = join(root, 'experiment', 'route-strong', 'trials.jsonl')
    const lines = (await readFile(path, 'utf8')).split('\n')
    lines[0] = JSON.stringify({ taskId: TASK_ID })
    await writeFile(path, lines.join('\n'))
    await assert.rejects(readReplayRun(input), /trial\.arm must be a non-empty string/)
  })
})

test('duplicate trial ids are a TypeError', async () => {
  await withRun({}, async ({ root, input }) => {
    const path = join(root, 'experiment', 'route-strong', 'trials.jsonl')
    const lines = (await readFile(path, 'utf8')).split('\n')
    const duplicate = JSON.parse(lines[0])
    duplicate.trialIndex = 0
    lines[1] = JSON.stringify(duplicate)
    await writeFile(path, lines.join('\n'))
    await assert.rejects(readReplayRun(input), (error) => {
      assert.ok(error instanceof TypeError)
      assert.match(error.message, /duplicate trial id: S\//)
      return true
    })
  })
})

test('file-boundary violations in a trial record are named refusals that read nothing', async () => {
  const cases = [
    { name: 'an absolute sessionFile', sessionFile: (arm, i) => (arm === 'S' && i === 0 ? '/var/lib/shres/owner-session.jsonl' : undefined), reason: 'absolute-session-path' },
    {
      name: 'a sessionFile escaping the arm directory',
      sessionFile: (arm, i) => (arm === 'S' && i === 0 ? 'sessions/reader-task/0/../../../elsewhere/log.jsonl' : undefined),
      reason: 'session-path-outside-trial',
    },
    {
      name: 'a sessionFile pointing into a different trial',
      sessionFile: (arm, i) => (arm === 'S' && i === 0 ? 'sessions/reader-task/1/session.jsonl' : undefined),
      reason: 'session-path-outside-trial',
    },
  ]
  for (const { name, sessionFile, reason } of cases) {
    await withRun({ sessionFile }, async ({ input }) => {
      const { trials, refused } = await readReplayRun(input)
      assert.equal(refused.length, 1, name)
      assert.equal(refused[0].id, `S/${TASK_ID}/0`, name)
      assert.equal(refused[0].reason, reason, name)
      assert.equal(trials.length, 3, name)
    })
  }
})

test('a hostile task id is a refusal and never becomes a path segment', async () => {
  await withRun({
    trialOverrides: (arm, i) => (arm === 'S' && i === 0 ? { taskId: '../outside' } : {}),
  }, async ({ input }) => {
    const { trials, refused } = await readReplayRun(input)
    assert.deepEqual(refused, [{
      id: `S/../outside/0`,
      taskId: '../outside',
      trialIndex: 0,
      arm: 'S',
      path: null,
      reason: 'task-id-not-a-segment',
    }])
    assert.equal(trials.length, 3)
  })
})

test('a symlink inside the trial directory pointing outside is refused without reading the target', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'bench-replay-reader-outside-'))
  const target = join(outside, 'owner-session.jsonl')
  const ownerBytes = Buffer.from('owner data that must never be read\n')
  await writeFile(target, ownerBytes)
  try {
    await withRun({
      sessionFile: (arm, trialIndex) => (arm === 'S' && trialIndex === 0 ? 'sessions/reader-task/0/link.jsonl' : undefined),
    }, async ({ root, input }) => {
      const link = join(root, 'experiment', 'route-strong', 'sessions', TASK_ID, '0', 'link.jsonl')
      try {
        await rm(link)
        await symlink(target, link)
      } catch {
        t.skip('symlinks unavailable on this platform')
        return
      }
      const { trials, refused } = await readReplayRun(input)
      assert.equal(refused.length, 1)
      assert.equal(refused[0].id, `S/${TASK_ID}/0`)
      assert.equal(refused[0].reason, 'session-path-outside-trial')
      assert.match(refused[0].path, /route-strong\/sessions\/reader-task\/0\/link\.jsonl$/)
      assert.equal(trials.length, 3)
      // Genuine read-proof: while the target is unreadable (mode 000), the
      // reader still returns the refusal cleanly — an attempted read of the
      // target would fail EACCES and propagate as an error, not a refusal.
      await chmod(target, 0o000)
      await chmod(target, 0o644)
      assert.deepEqual(await readFile(target), ownerBytes, 'the target bytes are unchanged (non-modification)')
    })
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('a registration runnerName outside the experiment directory is a UsageError', async () => {
  await withRun({
    registration: { arms: { S: { runnerName: '../elsewhere/run' }, C: { runnerName: 'route-cheap' } } },
  }, async ({ input }) => {
    await assert.rejects(readReplayRun(input), (error) => {
      assert.ok(error instanceof UsageError)
      assert.match(error.message, /runnerName for replay arm S must be a single path segment/)
      return true
    })
  })
})

test('a symlinked trial directory whose target holds the session artifact is confined to the canonical trial root', async () => {
  await withRun({}, async ({ root, input }) => {
    const trialDir = join(root, 'experiment', 'route-strong', 'sessions', TASK_ID, '0')
    const outside = await mkdtemp(join(tmpdir(), 'bench-replay-reader-trialdir-'))
    const outsideSessionDir = join(outside, projectKey(RECORDED_HEADER.cwd), encodeSegment(RECORDED_HEADER.id))
    await mkdir(outsideSessionDir, { recursive: true })
    await copyFile(
      join(trialDir, projectKey(RECORDED_HEADER.cwd), encodeSegment(RECORDED_HEADER.id), 'session.jsonl'),
      join(outsideSessionDir, 'session.jsonl'),
    )
    await rm(trialDir, { recursive: true })
    await symlink(outside, trialDir)
    try {
      const { trials, refused } = await readReplayRun(input)
      assert.deepEqual(refused.map(record => [record.id, record.reason]), [
        [`S/${TASK_ID}/0`, 'session-path-outside-trial'],
      ])
      assert.equal(trials.length, 3)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('an arm directory symlinked outside the experiment is a UsageError before any trial read', async () => {
  await withRun({}, async ({ root, input }) => {
    const armDir = join(root, 'experiment', 'route-strong')
    const outside = await mkdtemp(join(tmpdir(), 'bench-replay-reader-armdir-'))
    await rm(armDir, { recursive: true })
    const sessionDir = join(outside, 'sessions', TASK_ID, '0', projectKey(RECORDED_HEADER.cwd), encodeSegment(RECORDED_HEADER.id))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.jsonl'), RECORDED)
    const records = [0, 1].map((trialIndex) => trialRecord({ taskId: TASK_ID, trialIndex, arm: 'route-strong' }))
    await writeFile(join(outside, 'trials.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n')
    await symlink(outside, armDir)
    try {
      await assert.rejects(readReplayRun(input), (error) => {
        assert.ok(error instanceof UsageError)
        assert.match(error.message, /route-strong.*trials\.jsonl resolves outside the arm directory/)
        return true
      })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('a trials.jsonl symlinked outside the arm directory is a UsageError', async () => {
  await withRun({}, async ({ root, input }) => {
    const outside = await mkdtemp(join(tmpdir(), 'bench-replay-reader-trials-'))
    const records = [0, 1].map((trialIndex) => trialRecord({ taskId: TASK_ID, trialIndex, arm: 'route-strong' }))
    const outsideFile = join(outside, 'trials.jsonl')
    await writeFile(outsideFile, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    const trialsPath = join(root, 'experiment', 'route-strong', 'trials.jsonl')
    await rm(trialsPath)
    await symlink(outsideFile, trialsPath)
    try {
      await assert.rejects(readReplayRun(input), (error) => {
        assert.ok(error instanceof UsageError)
        assert.match(error.message, /route-strong.*trials\.jsonl resolves outside the arm directory/)
        return true
      })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('a task.json symlinked outside the task root is a TypeError', async () => {
  await withRun({}, async ({ root, input }) => {
    const outside = await mkdtemp(join(tmpdir(), 'bench-replay-reader-task-'))
    const outsideFile = join(outside, 'task.json')
    await writeFile(outsideFile, JSON.stringify({ taskId: TASK_ID, stratum: STRATUM }))
    const taskPath = join(root, 'tasks', TASK_ID, 'task.json')
    await rm(taskPath)
    await symlink(outsideFile, taskPath)
    try {
      await assert.rejects(readReplayRun(input), (error) => {
        assert.ok(error instanceof TypeError)
        assert.match(error.message, /reader-task: task\.json must resolve inside the task root/)
        return true
      })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('whole-run accounting: reader refusals, a host refusal, and one good trial compose into one refusal', async () => {
  await withRun({
    sessionFile: (arm, trialIndex) => (arm === 'C' && trialIndex === 1 ? null : undefined),
    bytesFor: (arm, trialIndex) => {
      if (arm === 'S' && trialIndex === 0) return sessionBytes('interrupted')
      if (arm === 'S' && trialIndex === 1) return sessionBytes('model-changed')
      return sessionBytes('unmodified')
    },
  }, async ({ input }) => {
    const { trials, tasks, refused, discovered } = await readReplayRun(input)
    assert.deepEqual(refused.map(record => [record.id, record.reason]), [
      [`S/${TASK_ID}/1`, 'mixed-route'],
      [`C/${TASK_ID}/1`, 'no-session-log'],
    ])
    assert.deepEqual(trials.map(trial => trial.id), [`S/${TASK_ID}/0`, `C/${TASK_ID}/0`])
    assert.equal(trials.length + refused.length, discovered.length)
    let caught
    try {
      await hostReplayRun({
        repoRoot: REPO,
        method: METHOD,
        tasks,
        trials,
        preRefused: refused,
        discovered,
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof TrialInputIncompleteError)
    assert.match(caught.message, /replay run refused: 3 trial\(s\)/)
    assert.deepEqual(caught.trials.map(entry => [entry.id, entry.source]), [
      [`S/${TASK_ID}/1`, 'reader'],
      [`C/${TASK_ID}/1`, 'reader'],
      [`S/${TASK_ID}/0`, 'host'],
    ])
  })
})
