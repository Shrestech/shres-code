/**
 * Replay run reader: registration-located arms, include-all trials, and
 * aggregated class-C trial inputs, over a synthetic run directory built from
 * the recorded real-CLI fixture.
 * @module
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readReplayRun } from '../routing/replay-run-reader.js'
import { emptyMetrics } from '../runner/metrics.js'
import { UsageError } from '../runner/run.js'

/** The recorded real-CLI log every synthetic session copies from. */
const RECORDED = await readFile(new URL('../routing/fixtures/replay-c-label-windows.session.jsonl', import.meta.url))

const REGISTRATION = {
  arms: {
    S: { runnerName: 'route-strong' },
    C: { runnerName: 'route-cheap' },
  },
}
const TASK_ID = 'reader-task'
const STRATUM = 'moderate'

/** The trial's own route every normalized header reports. */
const OWN_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }

/**
 * The recorded fixture's first request/header marks reasoningEffort as an
 * adapter default while the later two do not, which the mixed-route rule
 * reads as two routes. Rewriting that one marking makes the copy a
 * consistent-route log; rewriting the model makes it a genuinely mixed one.
 * @param {'normalized' | 'mixed' | 'torn'} variant
 * @returns {Buffer}
 */
function sessionBytes(variant) {
  const lines = RECORDED.toString('utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const rewritten = lines.map((line) => {
    if (!line.includes('"request/header"')) return line
    const record = JSON.parse(line)
    if (record.seq !== 10) return line
    if (variant === 'mixed') {
      record.data.header.config.model = 'deepseek-v4-flash'
      return JSON.stringify(record)
    }
    record.data.header.adapterDefaults = { maxTokens: true }
    return JSON.stringify(record)
  })
  const text = rewritten.join('\n') + (variant === 'torn' ? '' : '\n')
  return Buffer.from(text, 'utf8')
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
 * reader does not filter by status), each session a copy of the recorded
 * fixture, and a task root carrying the preregistered stratum.
 * @param {{ bytesFor?: (arm: string, trialIndex: number) => Buffer, sessionFile?: (arm: string, trialIndex: number) => string | null, skipArmDir?: 'C' | undefined, taskOverrides?: object, trialOverrides?: (arm: string, trialIndex: number) => object, registration?: object }} [options]
 */
async function buildRun(options = {}) {
  const {
    bytesFor = () => sessionBytes('normalized'),
    sessionFile = (arm, trialIndex) => `sessions/${TASK_ID}/${trialIndex}/session.jsonl`,
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
        sessionFile: override === undefined ? `sessions/${TASK_ID}/${trialIndex}/session.jsonl` : override,
        ...trialOverrides(armName, trialIndex),
        ...(armName === 'C' && trialIndex === 1
          ? { status: 'error', resolved: false, failureMode: 'AGENT_TIMEOUT' }
          : {}),
      })
    })
    if (skipArmDir !== armName) {
      await mkdir(armDir, { recursive: true })
      await writeFile(join(armDir, 'trials.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n')
    }
    for (const trialIndex of [0, 1]) {
      const override = sessionFile(armName, trialIndex)
      const file = override === undefined ? `sessions/${TASK_ID}/${trialIndex}/session.jsonl` : override
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
  return {
    root,
    input: { experimentDir, registration, taskRoot },
    taskPath: join(taskRoot, TASK_ID, 'task.json'),
  }
}

async function withRun(options, fn) {
  const built = await buildRun(options)
  try {
    return await fn(built)
  } finally {
    await rm(built.root, { recursive: true, force: true })
  }
}

test('reads both registration arms, includes every trial regardless of status, and decodes each own route', async () => {
  await withRun({}, async ({ input }) => {
    const { trials, tasks, refused, discovered } = await readReplayRun(input)
    assert.deepEqual(trials.map(trial => trial.id), [
      `S/${TASK_ID}/0`, `S/${TASK_ID}/1`, `C/${TASK_ID}/0`, `C/${TASK_ID}/1`,
    ])
    assert.deepEqual(refused, [])
    assert.deepEqual(discovered, trials.map(trial => ({ id: trial.id, taskId: TASK_ID, trialIndex: trial.trialIndex, arm: trial.arm })))
    for (const trial of trials) {
      assert.equal(trial.taskId, TASK_ID)
      assert.ok(trial.arm === 'S' || trial.arm === 'C')
      assert.deepEqual(trial.trialOwnRoute, OWN_ROUTE)
      assert.ok(trial.path.endsWith(join('session.jsonl')))
    }
    const strong = trials[0]
    assert.equal(strong.path.endsWith(join('route-strong', 'sessions', TASK_ID, '0', 'session.jsonl')), true)
    assert.deepEqual(strong.trialOwnRoute, OWN_ROUTE)
    assert.equal(strong.trial.status, 'success')
    assert.equal(trials[3].trial.status, 'error')
    assert.equal(trials[3].trial.resolved, false)
    assert.equal(trials[3].trial.failureMode, 'AGENT_TIMEOUT')
    assert.deepEqual(tasks[TASK_ID]?.stratum, STRATUM)
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

test('a null sessionFile is a named class-C refusal and never a fabricated route', async () => {
  await withRun({
    sessionFile: (arm, trialIndex) => (arm === 'C' && trialIndex === 1 ? null : `sessions/${TASK_ID}/${trialIndex}/session.jsonl`),
  }, async ({ input }) => {
    const { trials, refused, discovered } = await readReplayRun(input)
    assert.deepEqual(refused, [{
      id: `C/${TASK_ID}/1`,
      taskId: TASK_ID,
      trialIndex: 1,
      arm: 'C',
      trialId: `C/${TASK_ID}/1`,
      reason: 'no session log',
    }])
    assert.deepEqual(trials.map(trial => trial.id), [`S/${TASK_ID}/0`, `S/${TASK_ID}/1`, `C/${TASK_ID}/0`])
    for (const trial of trials) assert.ok(trial.trialOwnRoute !== undefined)
    assert.equal(discovered.length, 4)
  })
})

test('a mixed-route log is a named class-C refusal carrying the path', async () => {
  await withRun({
    bytesFor: (arm, trialIndex) => (arm === 'S' && trialIndex === 0 ? sessionBytes('mixed') : sessionBytes('normalized')),
  }, async ({ input }) => {
    const { trials, refused } = await readReplayRun(input)
    assert.equal(refused.length, 1)
    assert.equal(refused[0].id, `S/${TASK_ID}/0`)
    assert.equal(refused[0].reason, 'mixed-route trial')
    assert.match(refused[0].path, /session\.jsonl$/)
    assert.deepEqual(trials.map(trial => trial.id), [`S/${TASK_ID}/1`, `C/${TASK_ID}/0`, `C/${TASK_ID}/1`])
  })
})

test('a corrupt session log is a named class-C refusal, not a crash or a drop', async () => {
  await withRun({
    bytesFor: (arm, trialIndex) => (arm === 'S' && trialIndex === 0 ? sessionBytes('torn') : sessionBytes('normalized')),
  }, async ({ input }) => {
    const { trials, refused } = await readReplayRun(input)
    assert.equal(refused.length, 1)
    assert.match(refused[0].reason, /does not end with a newline/)
    assert.equal(trials.length, 3)
  })
})

test('refusals from both arms are collected together instead of short-circuiting the read', async () => {
  await withRun({
    sessionFile: (arm, trialIndex) => (arm === 'C' && trialIndex === 1 ? null : `sessions/${TASK_ID}/${trialIndex}/session.jsonl`),
    bytesFor: (arm, trialIndex) => (arm === 'S' && trialIndex === 0 ? sessionBytes('mixed') : sessionBytes('normalized')),
  }, async ({ input }) => {
    const { trials, refused, discovered } = await readReplayRun(input)
    assert.deepEqual(refused.map(record => [record.id, record.reason]), [
      [`S/${TASK_ID}/0`, 'mixed-route trial'],
      [`C/${TASK_ID}/1`, 'no session log'],
    ])
    assert.deepEqual(trials.map(trial => trial.id), [`S/${TASK_ID}/1`, `C/${TASK_ID}/0`])
    assert.deepEqual(discovered.map(entry => entry.id), [
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
    const record = trialRecord({ trialIndex: 0, arm: 'route-strong', phases: [chainPhase] })
    lines[0] = JSON.stringify(record)
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

test('file-boundary violations in a trial record are named refusals that read nothing', async () => {
  const cases = [
    { name: 'an absolute sessionFile', sessionFile: (arm, i) => (arm === 'S' && i === 0 ? '/var/lib/shres/owner-session.jsonl' : undefined), reason: 'session log path is absolute' },
    {
      name: 'a sessionFile escaping the arm directory',
      sessionFile: (arm, i) => (arm === 'S' && i === 0 ? 'sessions/reader-task/0/../../../elsewhere/log.jsonl' : undefined),
      reason: 'session log path is outside the declared trial directory',
    },
    {
      name: 'a sessionFile pointing into a different trial',
      sessionFile: (arm, i) => (arm === 'S' && i === 0 ? 'sessions/reader-task/1/session.jsonl' : undefined),
      reason: 'session log path is outside the declared trial directory',
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
      trialId: `S/../outside/0`,
      reason: 'trial task id is not a single path segment',
    }])
    assert.equal(trials.length, 3)
  })
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

test('the normalized recorded fixture copy stays physically decodable and the mixed copy really differs', async () => {
  const normalized = sessionBytes('normalized')
  assert.notDeepEqual(normalized, RECORDED)
  assert.match(normalized.toString('utf8').slice(-1), /\n/)
  assert.notEqual(sessionBytes('mixed').toString('utf8'), normalized.toString('utf8'))
  assert.match(sessionBytes('torn').toString('utf8').slice(-1), /[^\n]/)
})
