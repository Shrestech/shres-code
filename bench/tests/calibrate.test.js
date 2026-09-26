/** Calibration CLI through the real keyless launcher; no real registration writes. @module */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { main, parseArgs } from '../routing/calibrate.js'
import { computeReplayMetrics, validateReplayRow } from '../analysis/replay-metrics.js'
import { emptyMetrics } from '../runner/metrics.js'
import { encodeSegment, projectKey } from '../runner/session-layout.js'
import { fixtureMethod } from './replay-fixture-method.js'
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
    const overlayPath = join(root, 'scripted.patch.yml')
    await writeFile(overlayPath, [
      '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-v4-pro',
      '- id: model-router', '  config:',
      '    routeFrom: [{"provider":"deepseek-official","model":"deepseek-v4-pro","objective":"quota"}]',
      '- id: bench-replay-scripted-judge', '  disabled: true',
      '- insert:', '    - id: bench-replay-scripted-fitting-judge',
      '      name: ' + JSON.stringify(REPLAY_SCRIPTED_FITTING_JUDGE_PATH),
      '      config:', '        defaultScript:', '          kind: ' + kind,
      '          probabilities: {"keep-current":0.3,"flash":0.7}', '          difficultyScore: 1', '',
    ].join('\n'))
    const outDir = join(root, 'out')
    const args = ['--experiment-dir', experimentDir, '--registration', registrationPath, '--task-root', taskRoot, '--out', outDir, '--extra-overlay', overlayPath]
    await run({ root, args, outDir, registrationPath, experimentDir, registration })
  } finally {
    assert.equal(digest(await readFile(registrationUrl)), realHash, 'committed registration is untouched')
    await rm(root, { recursive: true, force: true })
  }
}

test('CLI paths and seed are explicit and malformed options refuse', () => {
  const args = ['--experiment-dir', 'run', '--registration', 'reg.json', '--task-root', 'tasks', '--out', 'out']
  assert.equal(parseArgs(args).writeRegistration, false)
  assert.deepEqual(parseArgs(['--help']), { help: true })
  for (const extra of [['--write-registration'], ['--seed', '7'], ['--overlays-out', 'patches'], ['--unknown']]) {
    assert.throws(() => parseArgs([...args, ...extra]))
  }
  for (const seed of ['-1', '1.5', '9007199254740992']) {
    assert.throws(() => parseArgs([...args, '--write-registration', '--seed', seed, '--overlays-out', 'patches']))
  }
  assert.equal(parseArgs([...args, '--write-registration', '--seed', '0', '--overlays-out', 'patches']).seed, 0)
})

test('the real unpinned registration refuses before reading a nonexistent experiment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-unpinned-'))
  const before = digest(await readFile(registrationUrl))
  try {
    const result = await invoke(['--experiment-dir', join(root, 'absent'), '--registration', registrationUrl.pathname, '--task-root', join(root, 'absent-tasks'), '--out', join(root, 'out')])
    assert.equal(result.code, 2)
    assert.match(result.errors.join('\n'), /method is unpinned/)
    assert.deepEqual(await readdir(root), [])
    assert.equal(digest(await readFile(registrationUrl)), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('answered S rows retain unknown labels, publish evidence and refuse registration', async () => {
  await fixture('answered', async ({ root, args, outDir, registrationPath }) => {
    const before = digest(await readFile(registrationPath))
    const result = await invoke([...args, '--write-registration', '--seed', '7', '--overlays-out', join(root, 'overlays')])
    assert.equal(result.code, 4, result.errors.join('\n'))
    const rows = (await readFile(join(outDir, 'labelled-scores.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(rows.length > 0)
    assert.ok(rows.some(row => row.arm === 'S' && row.answered))
    for (const [index, row] of rows.entries()) validateReplayRow(row, `CLI row ${index}`)
    const manifest = JSON.parse(await readFile(join(outDir, 'run.json'), 'utf8'))
    assert.equal(manifest.counts.discovered, 4)
    assert.equal(manifest.counts.hosted, 4)
    assert.equal(manifest.counts.refused, 0)
    const metrics = JSON.parse(await readFile(join(outDir, 'metrics.json'), 'utf8'))
    assert.equal(metrics.gate.status, 'method-unpinned')
    assert.equal(metrics.gate.passed, null)
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

test('all-unfit replay writes an evaluated failed gate once without overlays', async () => {
  await fixture('unfit', async ({ root, args, outDir, registrationPath }) => {
    const writing = [...args, '--write-registration', '--seed', '7', '--overlays-out', join(root, 'overlays')]
    const result = await invoke(writing)
    assert.equal(result.code, 0, result.errors.join('\n'))
    const metrics = JSON.parse(await readFile(join(outDir, 'metrics.json'), 'utf8'))
    assert.ok(metrics.counts.eligible > 0)
    assert.equal(metrics.counts.answered, 0)
    assert.equal(metrics.gate.status, 'evaluated')
    assert.equal(metrics.gate.passed, false)
    const registration = JSON.parse(await readFile(registrationPath, 'utf8'))
    assert.equal(registration.replayGate, 'failed')
    assert.equal(registration.enforced, undefined)
    await assert.rejects(access(join(root, 'overlays')), { code: 'ENOENT' })
    const again = await invoke(writing)
    assert.equal(again.code, 2)
    assert.match(again.errors.join('\n'), /already finalized/)
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
