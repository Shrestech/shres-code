/**
 * Multiturn runner tests (aegis §10.1) through a fake harness: --session-id
 * then --resume argv over one session, resumedFrom linkage, suffix-only
 * metrics, seeded capped gaps on the trial row, the byte-prefix violation,
 * and the confirmatory registration refusal.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, UsageError } from '../runner/run.js'
import { validateTrial } from '../schema/trial.js'
import { FAKE_BIN, FAKE_TSX_HOOKS } from './helpers/multiturn-fake-ts.mjs'

const tempDir = prefix => mkdtemp(join(tmpdir(), prefix))

async function writeWorld(root, tasks) {
  const repoRoot = join(root, 'repo')
  const benchRoot = join(repoRoot, 'bench')
  await mkdir(join(repoRoot, 'node_modules', 'tsx'), { recursive: true })
  await writeFile(join(repoRoot, 'package.json'), '{"name":"fake-harness","type":"module"}\n')
  await writeFile(join(repoRoot, 'tsconfig.json'), '{}\n')
  await writeFile(join(repoRoot, 'node_modules', 'tsx', 'package.json'), '{"name":"tsx","version":"0.0.0","type":"module"}\n')
  await writeFile(join(repoRoot, 'node_modules', 'tsx', 'esm.js'), "import { register } from 'node:module'\nregister('./hooks.mjs', import.meta.url)\n")
  await writeFile(join(repoRoot, 'node_modules', 'tsx', 'hooks.mjs'), FAKE_TSX_HOOKS)
  await mkdir(join(repoRoot, 'apps', 'cli', 'src'), { recursive: true })
  await writeFile(join(repoRoot, 'apps', 'cli', 'src', 'bin.ts'), FAKE_BIN)
  for (const { taskId, definition, passes = true } of tasks) {
    const dir = join(benchRoot, 'tasks', taskId)
    await mkdir(join(dir, 'fixture'), { recursive: true })
    await writeFile(join(dir, 'task.json'), JSON.stringify({
      taskId,
      stratum: 'short',
      description: taskId,
      verify: 'node verify.mjs',
      timeoutMs: 30000,
      ...definition,
    }))
    await writeFile(join(dir, 'verify.mjs'), 'process.exit(' + (passes ? 0 : 1) + ')\n')
  }
  return benchRoot
}

async function runWorld(benchRoot, argv, arm) {
  const lines = []
  const code = await main(argv, {
    benchRoot,
    env: { DEEPSEEK_API_KEY: 'fake-key' },
    print: line => lines.push(line),
  })
  const text = await readFile(join(benchRoot, 'runs', argv[1], arm, 'trials.jsonl'), 'utf8')
  return { code, lines, trials: text.trim().split('\n').map(line => JSON.parse(line)) }
}

test('multiturn trial: --session-id then --resume, one session, suffix metrics, gaps recorded', async () => {
  const root = await tempDir('bench-multiturn-')
  const benchRoot = await writeWorld(root, [{
    taskId: 'mt-three-turns',
    definition: { turns: ['turn one', 'turn two', 'turn three'], timeoutMs: 30000 },
  }])
  const { code, trials } = await runWorld(benchRoot, [
    '--experiment', 'mt', '--arms', 'off', '--repeats', '1',
    '--gap-seed', '9', '--gap-cap-ms', '1', '--nonce', '--max-total-tokens', '1000000',
  ], 'off')
  assert.equal(code, 0)
  assert.equal(trials.length, 1)
  const [trial] = trials
  validateTrial(trial)
  assert.equal(trial.phases.length, 3)
  assert.equal(trial.phases[0].resumedFrom, null)
  assert.equal(trial.phases[1].resumedFrom, trial.phases[0].sessionFile)
  assert.equal(trial.phases[2].resumedFrom, trial.phases[1].sessionFile)
  // One shared session file: every turn's sessionFile is the same path.
  assert.equal(new Set(trial.phases.map(p => p.sessionFile)).size, 1)
  // Suffix-only metrics: each turn folds exactly its own step and message
  // (10 input tokens per appended usage record, never the accumulated total).
  for (const phase of trial.phases) {
    assert.equal(phase.metrics.inputTokens, 10)
  }
  // Seeded, capped gaps ride the trial row: cap 1 realizes every gap at 1 ms.
  assert.equal(trial.gaps.length, 2)
  for (const [index, gap] of trial.gaps.entries()) {
    assert.equal(gap.index, index)
    assert.equal(gap.gapMs, 1)
    assert.ok(gap.drawnMs >= 1)
  }
  // The fake harness saw create then two resumes, all on one stable session id.
  const spawnLog = join(benchRoot, 'runs', 'mt', 'scratch', 'off', 'mt-three-turns', '0', 'spawn-log.txt')
  const spawns = (await readFile(spawnLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(spawns.map(spawn => spawn.mode), ['create', 'resume', 'resume'])
  assert.equal(new Set(spawns.map(spawn => spawn.sessionId)).size, 1)
})

test('a resume that does not grow the session byte-prefix flags an integrity violation', async () => {
  const root = await tempDir('bench-multiturn-rewrite-')
  const benchRoot = await writeWorld(root, [{
    taskId: 'mt-rewrite',
    definition: { turns: ['turn one', 'turn two', 'turn three REWRITE'], timeoutMs: 30000 },
  }])
  const { code, trials } = await runWorld(benchRoot, [
    '--experiment', 'mt-rewrite', '--arms', 'off', '--repeats', '1',
    '--gap-seed', '9', '--gap-cap-ms', '1',
  ], 'off')
  assert.equal(code, 0)
  assert.equal(trials.length, 1)
  validateTrial(trials[0])
  assert.ok(trials[0].integrity.violations.some(v => v.includes('byte-prefix')), JSON.stringify(trials[0].integrity))
})

test('confirmatory arms refuse before keys without adopted generated overlays', async () => {
  const root = await tempDir('bench-multiturn-reg-')
  const benchRoot = await writeWorld(root, [{
    taskId: 'mt-reg',
    definition: { instruction: 'single turn' },
  }])
  // main rejects with the UsageError; the bin wrapper maps it to exit 2. The
  // flag requirement fires first: no run may confirm on the provisional files.
  await assert.rejects(
    main(['--experiment', 'mt-reg', '--arms', 'route-coldpoint', '--repeats', '1'], {
      benchRoot,
      env: {},
      print: () => {},
    }),
    error => {
      assert.ok(error instanceof UsageError, 'the refusal is a UsageError')
      assert.match(error.message, /--confirmatory-overlays/)
      return true
    },
  )
})
