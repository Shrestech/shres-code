/**
 * Model strength-and-cost ranking over a fake runs tree: pooled frozen pass
 * rates per model pin, realized usage summed from the recorded trial usage,
 * rank order by strength per cost, filters, the Markdown table, and the CLI.
 *
 * @module bench/tests/model-ranking.test
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { buildModelRanking, parseArgs, renderTable } from '../analysis/model-ranking.js'
import { emptyMetrics } from '../runner/metrics.js'

const SCRIPT = fileURLToPath(new URL('../analysis/model-ranking.js', import.meta.url))
const DEFAULT_RUNS_DIR = join(dirname(dirname(SCRIPT)), 'runs')
const run = promisify(execFile)

/**
 * Fabricate a valid Trial record whose usage fields are the recorded
 * `assistant/message` sums.
 * @param {{ taskId?: string, trialIndex?: number, arm?: string, resolved?: boolean, status?: 'success' | 'error', input?: number, output?: number }} spec
 * @returns {import('../schema/trial.js').Trial}
 */
function trial(spec = {}) {
  const resolved = spec.resolved ?? true
  return {
    taskId: spec.taskId ?? 'alpha',
    trialIndex: spec.trialIndex ?? 0,
    arm: spec.arm ?? 'off',
    status: spec.status ?? 'success',
    resolved,
    failureMode: resolved ? null : 'VERIFY_FAILED',
    verifier: { command: 'node verify.mjs', exitCode: resolved ? 0 : 1 },
    metrics: { ...emptyMetrics(), inputTokens: spec.input ?? 1000, outputTokens: spec.output ?? 100, turns: 3 },
    sessionFile: null,
    startedAt: '2026-08-18T00:00:00.000Z',
    endedAt: '2026-08-18T00:01:00.000Z',
  }
}

/**
 * Write one arm run: run.json pinned to `model`, plus trials.jsonl.
 * @param {string} runsDir - runs root.
 * @param {string} experiment - experiment directory name.
 * @param {string} arm - arm name.
 * @param {string} model - manifest model pin.
 * @param {import('../schema/trial.js').Trial[]} trials - trial records.
 */
async function writeArm(runsDir, experiment, arm, model, trials) {
  const dir = join(runsDir, experiment, arm)
  await mkdir(dir, { recursive: true })
  const manifest = {
    version: 1,
    experiment,
    arm,
    armConfig: { enabled: false },
    model,
    baseUrl: null,
    temperature: 0,
    repeats: 1,
    taskIds: ['alpha'],
    gitCommit: 'deadbeef',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    tierPatches: [],
    startedAt: '2026-08-18T00:00:00.000Z',
    endedAt: '2026-08-18T01:00:00.000Z',
  }
  await writeFile(join(dir, 'run.json'), JSON.stringify(manifest))
  await writeFile(join(dir, 'trials.jsonl'), trials.map(t => JSON.stringify(t)).join('\n') + '\n')
}

/**
 * Run a test body against a fresh temporary runs root.
 * @param {(runsDir: string) => Promise<void>} body
 */
async function withRunsDir(body) {
  const runsDir = await mkdtemp(join(tmpdir(), 'bench-ranking-'))
  try {
    await body(runsDir)
  } finally {
    await rm(runsDir, { recursive: true, force: true })
  }
}

describe('analysis.buildModelRanking', () => {
  it('ranks roster models by pooled pass rate per mean realized tokens and lists each arm run', async () => {
    await withRunsDir(async runsDir => {
      // strong: 2/2 passes at 4000 tokens per trial -> 1 / 4000 = 0.00025
      await writeArm(runsDir, 'exp-a', 'off', 'strong', [
        trial({ trialIndex: 0, input: 3500, output: 500 }),
        trial({ trialIndex: 1, input: 3500, output: 500 }),
      ])
      // cheap: 1/2 passes at 1000 tokens per trial -> 0.5 / 1000 = 0.0005 (ranks first)
      await writeArm(runsDir, 'exp-a', 'on', 'cheap', [
        trial({ trialIndex: 0, arm: 'on', input: 900, output: 100 }),
        trial({ trialIndex: 1, arm: 'on', resolved: false, input: 900, output: 100 }),
      ])
      // cheap also ran a second experiment: pooled over both arm runs.
      await writeArm(runsDir, 'exp-b', 'off', 'cheap', [
        trial({ trialIndex: 0, input: 900, output: 100 }),
      ])
      const rows = await buildModelRanking({ runsDir })
      assert.deepEqual(rows.map(r => [r.rank, r.model]), [[1, 'cheap'], [2, 'strong']])
      const cheap = rows[0]
      assert.equal(cheap.trials, 3)
      assert.equal(cheap.resolved, 2)
      assert.equal(cheap.strength, 2 / 3)
      assert.equal(cheap.realizedTokens, 3000)
      assert.equal(cheap.meanRealizedTokens, 1000)
      assert.equal(cheap.strengthPerCost, (2 / 3) / 1000)
      assert.deepEqual(cheap.runs, [
        { experiment: 'exp-a', arm: 'on', trials: 2, resolved: 1, passRate: 0.5, realizedTokens: 2000 },
        { experiment: 'exp-b', arm: 'off', trials: 1, resolved: 1, passRate: 1, realizedTokens: 1000 },
      ])
      const strong = rows[1]
      assert.equal(strong.strength, 1)
      assert.equal(strong.strengthPerCost, 1 / 4000)
    })
  })

  it('excludes status error trials from both strength and realized cost', async () => {
    await withRunsDir(async runsDir => {
      await writeArm(runsDir, 'exp', 'off', 'm', [
        trial({ trialIndex: 0, input: 100, output: 10 }),
        trial({ trialIndex: 1, status: 'error', resolved: false, input: 5000, output: 5000 }),
      ])
      const [row] = await buildModelRanking({ runsDir })
      assert.equal(row.trials, 1)
      assert.equal(row.strength, 1)
      assert.equal(row.realizedTokens, 110)
      assert.equal(row.runs[0].passRate, 1)
    })
  })

  it('leaves a model with no gradable trial or no realized usage unranked after the ranked rows', async () => {
    await withRunsDir(async runsDir => {
      await writeArm(runsDir, 'exp', 'off', 'zero-usage', [trial({ input: 0, output: 0 })])
      await writeArm(runsDir, 'exp', 'on', 'no-trials', [])
      await writeArm(runsDir, 'exp', 'on-sq', 'also-no-trials', [])
      await writeArm(runsDir, 'exp', 'sq-only', 'ranked', [trial({ arm: 'sq-only' })])
      const rows = await buildModelRanking({ runsDir })
      assert.deepEqual(
        rows.map(r => [r.rank, r.model]),
        [[1, 'ranked'], [null, 'zero-usage'], [null, 'also-no-trials'], [null, 'no-trials']],
      )
      const noTrials = rows[3]
      assert.equal(noTrials.strength, null)
      assert.equal(noTrials.meanRealizedTokens, null)
      assert.equal(noTrials.strengthPerCost, null)
      assert.equal(noTrials.runs[0].passRate, null)
      const zeroUsage = rows[1]
      assert.equal(zeroUsage.strength, 1)
      assert.equal(zeroUsage.meanRealizedTokens, 0)
      assert.equal(zeroUsage.strengthPerCost, null)
    })
  })

  it('breaks a strength-per-cost tie by strength, then by model name', async () => {
    await withRunsDir(async runsDir => {
      // Both rows: 0.5 / 1000 == 1 / 2000.
      await writeArm(runsDir, 'exp', 'off', 'half', [
        trial({ trialIndex: 0, input: 1000, output: 0 }),
        trial({ trialIndex: 1, resolved: false, input: 1000, output: 0 }),
      ])
      await writeArm(runsDir, 'exp', 'on', 'full', [trial({ arm: 'on', input: 2000, output: 0 })])
      await writeArm(runsDir, 'exp', 'read', 'b-twin', [trial({ arm: 'read', input: 2000, output: 0 })])
      await writeArm(runsDir, 'exp', 'code', 'a-twin', [trial({ arm: 'code', input: 2000, output: 0 })])
      const rows = await buildModelRanking({ runsDir })
      assert.deepEqual(rows.map(r => r.model), ['a-twin', 'b-twin', 'full', 'half'])
      assert.deepEqual(rows.map(r => r.rank), [1, 2, 3, 4])
    })
  })

  it('filters experiments by name substring and arms by exact name', async () => {
    await withRunsDir(async runsDir => {
      await writeArm(runsDir, 'w4-zai', 'off', 'glm', [trial()])
      await writeArm(runsDir, 'w4-zai', 'on', 'glm', [trial({ arm: 'on' })])
      await writeArm(runsDir, 'w5-other', 'off', 'other', [trial()])
      const byExperiment = await buildModelRanking({ runsDir, experiments: ['w4-'] })
      assert.deepEqual(byExperiment.map(r => r.model), ['glm'])
      assert.equal(byExperiment[0].runs.length, 2)
      const byArm = await buildModelRanking({ runsDir, arms: ['on'] })
      assert.deepEqual(byArm.map(r => r.model), ['glm'])
      assert.deepEqual(byArm[0].runs.map(r => r.arm), ['on'])
      const none = await buildModelRanking({ runsDir, experiments: ['no-such'] })
      assert.deepEqual(none, [])
    })
  })

  it('skips arm directories without run.json and fails on an invalid manifest', async () => {
    await withRunsDir(async runsDir => {
      await writeArm(runsDir, 'exp', 'off', 'm', [trial()])
      await mkdir(join(runsDir, 'exp', 'scratch'), { recursive: true })
      await writeFile(join(runsDir, 'exp', 'loose-file'), 'not a directory')
      const rows = await buildModelRanking({ runsDir })
      assert.deepEqual(rows[0].runs.map(r => r.arm), ['off'])
      await mkdir(join(runsDir, 'exp', 'broken'))
      await writeFile(join(runsDir, 'exp', 'broken', 'run.json'), JSON.stringify({ version: 2 }))
      await assert.rejects(buildModelRanking({ runsDir }), /manifest\.version must be 1/)
    })
  })

  it('fails when the runs directory does not exist', async () => {
    await assert.rejects(buildModelRanking({ runsDir: join(tmpdir(), 'bench-ranking-missing-root') }), /no runs directory at/)
  })

  it('reads bench/runs when no runs root is given', async () => {
    // `bench/runs` is gitignored output, so its presence depends on the checkout:
    // present, the default builds over whatever it holds; absent, the error names it.
    if (existsSync(DEFAULT_RUNS_DIR)) {
      assert.ok(Array.isArray(await buildModelRanking()))
    } else {
      await assert.rejects(buildModelRanking(), error => error.message === `no runs directory at ${DEFAULT_RUNS_DIR}`)
    }
  })
})

describe('analysis.model-ranking parseArgs', () => {
  it('collects repeatable filters, the runs root, and the json switch', () => {
    assert.deepEqual(parseArgs([]), { runsDir: null, experiments: [], arms: [], json: false })
    assert.deepEqual(
      parseArgs(['--experiment', 'w4', '--arm', 'off', '--arm', 'on', '--runs-dir', '/tmp/runs', '--json']),
      { runsDir: '/tmp/runs', experiments: ['w4'], arms: ['off', 'on'], json: true },
    )
  })

  it('rejects a missing or flag-like value and an unknown argument', () => {
    assert.throws(() => parseArgs(['--experiment']), /--experiment requires a value/)
    assert.throws(() => parseArgs(['--arm', '--json']), /--arm requires a value/)
    assert.throws(() => parseArgs(['--runs-dir', '']), /--runs-dir requires a value/)
    assert.throws(() => parseArgs(['--bogus']), /unknown argument: --bogus/)
  })
})

describe('analysis.model-ranking renderTable', () => {
  it('renders one line per model with its arm runs indented and dashes for undefined figures', () => {
    const text = renderTable([
      {
        rank: 1,
        model: 'ranked',
        runs: [{ experiment: 'exp', arm: 'off', trials: 2, resolved: 1, passRate: 0.5, realizedTokens: 2000 }],
        trials: 2,
        resolved: 1,
        strength: 0.5,
        realizedTokens: 2000,
        meanRealizedTokens: 1000,
        strengthPerCost: 0.0005,
      },
      {
        rank: null,
        model: 'empty',
        runs: [{ experiment: 'exp', arm: 'on', trials: 0, resolved: 0, passRate: null, realizedTokens: 0 }],
        trials: 0,
        resolved: 0,
        strength: null,
        realizedTokens: 0,
        meanRealizedTokens: null,
        strengthPerCost: null,
      },
    ])
    const lines = text.split('\n')
    assert.equal(lines[2], '| 1 | ranked | 2 | 0.500 | 2000 | 1000 | 500.000 |')
    assert.equal(lines[3], '| | ↳ exp / off | 2 | 0.500 | 2000 | | |')
    assert.equal(lines[4], '| — | empty | 0 | — | 0 | — | — |')
    assert.equal(lines[5], '| | ↳ exp / on | 0 | — | 0 | | |')
    assert.ok(text.endsWith('|\n'))
  })
})

describe('analysis.model-ranking command', () => {
  it('prints the JSON rows for an archived runs tree and the table by default', async () => {
    await withRunsDir(async runsDir => {
      await writeArm(runsDir, 'exp', 'off', 'm', [trial()])
      const { stdout } = await run(process.execPath, [SCRIPT, '--runs-dir', runsDir, '--json'])
      const rows = JSON.parse(stdout)
      assert.deepEqual(rows.map(r => [r.rank, r.model]), [[1, 'm']])
      const table = await run(process.execPath, [SCRIPT, '--runs-dir', runsDir])
      assert.match(table.stdout, /^\| Rank \| Model \|/)
      assert.match(table.stdout, /\| 1 \| m \| 1 \|/)
    })
  })

  it('exits non-zero with the message on a bad argument', async () => {
    await assert.rejects(run(process.execPath, [SCRIPT, '--bogus']), error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /unknown argument: --bogus/)
      return true
    })
  })
})
