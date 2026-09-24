/**
 * Real laya-mlx end to end: install the pinned checkpoint through the
 * provider's own install path, launch the supervised gateway, and answer a
 * routing-shaped fitted ask through `ctx.judgment`.
 *
 * Self-skips unless the host is Apple silicon and `LAYA_E2E_RUNTIME_DIR`
 * names an absolute runtime directory. The first run downloads about 850 MB of
 * pinned weights into that directory; later runs reuse the verified install.
 */
import { isAbsolute } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { judgmentQuestionId } from '@shres-code/shres-code-judgment'
import LocalSubprocessRuntime from '@shres-code/shres-code-subprocess-local'
import { LayaJudgmentEngine } from '../src/index.ts'

const RUNTIME_DIR = process.env['LAYA_E2E_RUNTIME_DIR']
const REPO = 'convaiinnovations/laya-typed-decisions'
const REVISION = 'f9ab0b228f0fc0f14d873dbc99038f135c2da1b2'
const MANIFEST_SHA256 = '028fa5c43482cf63c5d1ef8725c9cf9b196def71e39b8ea85647b3bddcf8f3bc'
const runnable = process.platform === 'darwin' && process.arch === 'arm64'
  && RUNTIME_DIR !== undefined && isAbsolute(RUNTIME_DIR)

const ROUTE = judgmentQuestionId('model-route')
const DIFFICULTY = judgmentQuestionId('turn-difficulty')
const QUESTIONS = [
  {
    kind: 'choice' as const,
    id: ROUTE,
    instructions: 'Which route should handle this turn? Choose the cheapest route that is still a safe fit.',
    options: [
      { option: 'keep-current', description: 'the current strong model' },
      { option: 'flash', description: 'a small, well-scoped change in familiar code' },
    ],
  },
  {
    kind: 'score' as const,
    id: DIFFICULTY,
    instructions: 'How hard is this turn for the model handling it?',
    levels: ['routine', 'moderate', 'involved', 'hard', 'very hard'],
  },
]

let ctx: Context | undefined
let engine: LayaJudgmentEngine

beforeAll(async () => {
  if (!runnable) return
  ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LayaJudgmentEngine, {
    model: { repo: REPO, revision: REVISION, manifestSha256: MANIFEST_SHA256 },
    checkpointContext: 1024,
    runtimeDir: RUNTIME_DIR,
  })
  engine = ctx.get('judgment') as LayaJudgmentEngine
  await waitFor(() => engine.status().state !== 'starting', 60_000)
  if (engine.status().state === 'not-installed') await engine.install()
  await waitFor(() => engine.status().state === 'ready' || engine.status().state === 'unavailable', 180_000)
}, 900_000)

afterAll(async () => {
  await ctx?.fiber.dispose()
})

describe.skipIf(!runnable)('judgment-laya with real laya-mlx', () => {
  it('serves a routing-shaped fitted ask locally with the pinned artifact', async () => {
    expect(engine.status()).toEqual({ state: 'ready' })
    const result = await engine.fitting.ask({ states: ['user: Rename total to sum in utils.py.'], questions: QUESTIONS })

    if (result.kind !== 'answered') throw new Error(`expected an answered fit, got ${result.reason}`)
    expect(result.fit.limits).toMatchObject({ maxSequenceTokens: 1024, manifestSha256: MANIFEST_SHA256 })
    expect(result.result).toMatchObject({ engine: 'shield', model: `${REPO}@${REVISION}` })
    const [route, difficulty] = result.result.answers
    expect(route?.kind).toBe('choice')
    expect(difficulty?.kind).toBe('score')
  })

  it('refuses an over-long state without inference', async () => {
    const result = await engine.fitting.ask({ states: ['word '.repeat(2_000)], questions: QUESTIONS })
    expect(result).toMatchObject({ kind: 'unfit', reason: 'state' })
  })
})

/** Poll until a condition holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not reached within ${timeoutMs} ms; status ${JSON.stringify(engine.status())}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
