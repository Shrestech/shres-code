/** Calibration CLI through the real keyless launcher; no real registration writes. @module */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import { calibrateRun, main, parseArgs } from '../routing/calibrate.js'
import { computeReplayMetrics, validateReplayRow } from '../analysis/replay-metrics.js'
import { emptyMetrics } from '../runner/metrics.js'
import { encodeSegment, projectKey } from '../runner/session-layout.js'
import { fixtureMethod } from './replay-fixture-method.js'
import { REGISTRATION_STATUS } from '../routing/registration-phase.js'
const REPLAY_SCRIPTED_FITTING_JUDGE_PATH = fileURLToPath(new URL('../routing/replay-scripted-fitting-judge.mjs', import.meta.url))

const registrationUrl = new URL('../routing/prereg-2026-10.registration.json', import.meta.url)
const recordingUrl = new URL('../routing/fixtures/replay-c-label-windows.session.jsonl', import.meta.url)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function invoke(args) {
  const output = []
  const errors = []
  const code = await main(args, { print: line => output.push(line), error: line => errors.push(line) })
  return { code, output, errors }
}

async function fixture(kind, run) {
  const root = await mkdtemp(join(tmpdir(), 'routing-calibrate-'))
  const realRegistration = await readFile(registrationUrl)
  const realHash = digest(realRegistration)
  try {
    const registration = JSON.parse(realRegistration.toString('utf8'))
    // The committed document is a draft; this temp copy explicitly simulates
    // the frozen preregistration needed by the keyless calibration fixture.
    registration.status = REGISTRATION_STATUS
    registration.registeredAt = '2026-10-16'
    delete registration.draftedAt
    registration.method = fixtureMethod()
    const registrationPath = join(root, 'registration.json')
    await writeFile(registrationPath, JSON.stringify(registration))
    const bytes = await readFile(recordingUrl)
    const header = JSON.parse(bytes.toString('utf8').split('\n')[0])
    const experimentDir = join(root, 'experiment')
    const taskRoot = join(root, 'tasks')
    const taskId = 'calibration-fixture'
    await mkdir(join(taskRoot, taskId), { recursive: true })
    await writeFile(join(taskRoot, taskId, 'task.json'), JSON.stringify({ taskId, stratum: 'moderate' }))
    for (const arm of ['S', 'C']) {
      const armDir = join(experimentDir, registration.arms[arm].runnerName)
      const trials = []
      for (const trialIndex of [0, 1]) {
        const dir = join(armDir, 'sessions', taskId, String(trialIndex), projectKey(header.cwd), encodeSegment(header.id))
        await mkdir(dir, { recursive: true })
        const sessionPath = join(dir, 'session.jsonl')
        await writeFile(sessionPath, bytes)
        trials.push({
          taskId, trialIndex, arm: registration.arms[arm].runnerName,
          status: 'success', resolved: true, failureMode: null,
          verifier: { command: 'node verify.mjs', exitCode: 0 }, metrics: emptyMetrics(),
          sessionFile: relative(armDir, sessionPath).split(sep).join('/'),
          startedAt: '2026-10-16T00:00:00.000Z', endedAt: '2026-10-16T00:00:01.000Z',
        })
      }
      await writeFile(join(armDir, 'trials.jsonl'), trials.map(item => JSON.stringify(item) + '\n').join(''))
    }
    const routePatch = loadYaml(await readFile(new URL('../routing/route-coldpoint.patch.yml', import.meta.url), 'utf8'))
    const routerConfig = routePatch.flatMap(row => row.insert ?? []).find(row => row.id === 'model-router').config
    const fixtureRouter = { ...routerConfig, routeFrom: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', objective: 'quota' }] }
    const overlayPath = join(root, 'scripted.patch.yml')
    await writeFile(overlayPath, [
      '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-v4-pro',
      '- id: model-router', '  config: ' + JSON.stringify(fixtureRouter),
      '',
    ].join('\n'))
    const judgeConfigPath = join(root, 'judge.json')
    await writeFile(judgeConfigPath, JSON.stringify({ defaultScript: { kind, probabilities: { 'keep-current': 0.3, flash: 0.7 }, difficultyScore: 1 } }))
    const outDir = join(root, 'out')
    const args = [
      '--experiment-dir', experimentDir, '--registration', registrationPath, '--task-root', taskRoot, '--out', outDir,
      '--extra-overlay', overlayPath, '--judge-fixture', REPLAY_SCRIPTED_FITTING_JUDGE_PATH,
      '--judge-fixture-config', judgeConfigPath, '--judge-fixture-engine', 'scripted-fitting',
    ]
    await run({ root, args, outDir, registrationPath, experimentDir, registration, overlayPath })
  } finally {
    assert.equal(digest(await readFile(registrationUrl)), realHash, 'committed registration is untouched')
    await rm(root, { recursive: true, force: true })
  }
}

test('CLI paths and seed are explicit and malformed options refuse', () => {
  const args = ['--experiment-dir', 'run', '--registration', 'reg.json', '--task-root', 'tasks', '--out', 'out']
  assert.equal(parseArgs(args).writeRegistration, false)
  assert.deepEqual(parseArgs(['--help']), { help: true })
  for (const extra of [['--write-registration'], ['--seed', '7'], ['--overlays-out', 'patches'], ['--unknown'], ['--judge-fixture', 'fixture.mjs'], ['--judge-fixture-disabled'], ['--judge-fixture-engine', 'fixture']]) {
    assert.throws(() => parseArgs([...args, ...extra]))
  }
  for (const seed of ['-1', '1.5', '9007199254740992']) {
    assert.throws(() => parseArgs([...args, '--write-registration', '--seed', seed, '--overlays-out', 'patches']))
  }
  assert.equal(parseArgs([...args, '--write-registration', '--seed', '0', '--overlays-out', 'patches']).seed, 0)
  assert.throws(
    () => parseArgs([
      ...args, '--write-registration', '--seed', '0', '--overlays-out', 'patches',
      '--judge-fixture', 'fixture.mjs', '--judge-fixture-config', 'judge.json', '--judge-fixture-engine', 'fixture',
    ]),
    /cannot be combined with --judge-fixture/,
  )
})

test('the programmatic driver refuses fixture registration before reading or creating anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-fixture-write-'))
  const registrationPath = join(root, 'registration.json')
  const outDir = join(root, 'out')
  await writeFile(registrationPath, '{"untouched":true}\n')
  const before = digest(await readFile(registrationPath))
  try {
    await assert.rejects(
      () => calibrateRun({
        experimentDir: join(root, 'missing-experiment'), registrationPath,
        taskRoot: join(root, 'missing-tasks'), outDir,
        writeRegistration: true, seed: 7, overlaysOut: join(root, 'overlays'),
        judgeFixturePath: join(root, 'fixture.mjs'), judgeFixtureEnabled: true,
      }, { repoRoot: root, env: {} }),
      /cannot be combined with --judge-fixture/,
    )
    assert.equal(digest(await readFile(registrationPath)), before)
    await assert.rejects(access(outDir), { code: 'ENOENT' })
    await assert.rejects(access(join(root, 'overlays')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the real draft registration refuses before reading a nonexistent experiment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-unpinned-'))
  const before = digest(await readFile(registrationUrl))
  try {
    const result = await invoke(['--experiment-dir', join(root, 'absent'), '--registration', registrationUrl.pathname, '--task-root', join(root, 'absent-tasks'), '--out', join(root, 'out')])
    assert.equal(result.code, 2)
    assert.match(result.errors.join('\n'), /registration is still a draft/)
    assert.deepEqual(await readdir(root), [])
    assert.equal(digest(await readFile(registrationUrl)), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fixture evidence cannot finalize registration and still records unknown labels', async () => {
  await fixture('answered', async ({ root, args, outDir, registrationPath }) => {
    const before = digest(await readFile(registrationPath))
    const refusal = await invoke([...args, '--write-registration', '--seed', '7', '--overlays-out', join(root, 'overlays')])
    assert.equal(refusal.code, 2, refusal.errors.join('\n'))
    assert.match(refusal.errors.join('\n'), /cannot be combined with --judge-fixture/)
    await assert.rejects(access(outDir), { code: 'ENOENT' })
    await assert.rejects(access(join(root, 'overlays')), { code: 'ENOENT' })
    assert.equal(digest(await readFile(registrationPath)), before)
    const result = await invoke(args)
    assert.equal(result.code, 0, result.errors.join('\n'))
    const rows = (await readFile(join(outDir, 'labelled-scores.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(rows.length > 0)
    assert.ok(rows.some(row => row.arm === 'S' && row.answered))
    for (const [index, row] of rows.entries()) validateReplayRow(row, `CLI row ${index}`)
    const manifest = JSON.parse(await readFile(join(outDir, 'run.json'), 'utf8'))
    assert.equal(manifest.judgeMode, 'fixture')
    assert.equal(typeof manifest.judgeFixtureConfigSha256, 'string')
    assert.equal(manifest.counts.discovered, 4)
    assert.equal(manifest.counts.hosted, 4)
    assert.equal(manifest.counts.refused, 0)
    const metrics = JSON.parse(await readFile(join(outDir, 'metrics.json'), 'utf8'))
    assert.equal(metrics.gate.status, 'method-unpinned')
    assert.equal(metrics.gate.passed, null)
    assert.equal(metrics.gate.bounds.eceMax, 0.1)
    assert.equal(metrics.discrimination.status, 'refused')
    assert.equal(metrics.calibration.status, 'refused')
    assert.deepEqual(metrics, computeReplayMetrics(rows, { method: fixtureMethod(), gate: metrics.gate.bounds, entry: metrics.fixed }))
    for (const [name, hash] of Object.entries(manifest.files)) assert.equal(digest(await readFile(join(outDir, name))), hash)
    assert.equal(digest(await readFile(registrationPath)), before)
    const repeated = await invoke(args)
    assert.equal(repeated.code, 2)
    assert.match(repeated.errors.join('\n'), /output already exists/)
  })
})

test('fixture replay records an evaluated failed gate without finalizing registration', async () => {
  await fixture('unfit', async ({ root, args, outDir, registrationPath }) => {
    const writing = [...args, '--write-registration', '--seed', '7', '--overlays-out', join(root, 'overlays')]
    const refusal = await invoke(writing)
    assert.equal(refusal.code, 2, refusal.errors.join('\n'))
    assert.match(refusal.errors.join('\n'), /cannot be combined with --judge-fixture/)
    const result = await invoke(args)
    assert.equal(result.code, 0, result.errors.join('\n'))
    const metrics = JSON.parse(await readFile(join(outDir, 'metrics.json'), 'utf8'))
    assert.ok(metrics.counts.eligible > 0)
    assert.equal(metrics.counts.answered, 0)
    assert.equal(metrics.gate.status, 'evaluated')
    assert.equal(metrics.gate.passed, false)
    const registration = JSON.parse(await readFile(registrationPath, 'utf8'))
    assert.equal(registration.replayGate, undefined)
    await assert.rejects(access(join(root, 'overlays')), { code: 'ENOENT' })
  })
})

test('a judgment-mutating overlay refuses after method validation without publishing output', async () => {
  await fixture('unfit', async ({ args, outDir, overlayPath }) => {
    await writeFile(overlayPath, '- id: judgment-dispatch\n  config:\n    defaultEngine: another-engine\n')
    const result = await invoke(args)
    assert.equal(result.code, 2, result.errors.join('\n'))
    assert.ok(result.errors.join('\n').includes('judgment'))
    await assert.rejects(access(outDir), { code: 'ENOENT' })
  })
})

test('a corrupt trial refuses the whole run without publishing output', async () => {
  await fixture('unfit', async ({ root, args, outDir, experimentDir, registration }) => {
    const trialFile = join(experimentDir, registration.arms.C.runnerName, 'trials.jsonl')
    const trials = (await readFile(trialFile, 'utf8')).trim().split('\n').map(JSON.parse)
    trials[1].sessionFile = null
    await writeFile(trialFile, trials.map(trial => JSON.stringify(trial) + '\n').join(''))
    const result = await invoke(args)
    assert.equal(result.code, 3, result.errors.join('\n'))
    assert.ok(result.errors.join('\n').includes('C/calibration-fixture/1'))
    await assert.rejects(access(outDir), { code: 'ENOENT' })
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.out.tmp-')), [])
  })
})
