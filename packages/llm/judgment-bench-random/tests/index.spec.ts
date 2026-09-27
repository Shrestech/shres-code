/**
 * Plugin-wrapper tests: the mounted engine registers under its id, refuses an
 * ask without correlation, and maps a consult to the judgment result shape.
 * The context is a minimal fake — the wrapper needs only the engine registry,
 * the effect hook, and the logger.
 *
 * @module
 */
import { expect, it, describe } from 'vitest'
import type { Context } from '@shres-code/cordis'
import { JudgmentError, judgmentEngineId } from '@shres-code/shres-code-judgment'
import { apply } from '../src/index.ts'

/** A context capturing the registration effect instead of a real runtime. */
function fakeCtx() {
  const registry = new Map<string, {
    engine: { ask: (input: { questions: unknown; correlation?: unknown }) => Promise<unknown> }
    descriptor: { id: unknown; egress: string }
    status: () => { state: string }
  }>()
  const loggerLines: string[] = []
  const ctx = {
    effect: (run: () => () => void) => { run() },
    judgmentEngines: {
      register: (id: unknown, entry: never) => {
        registry.set(String(id), entry)
        const disposer = () => { registry.delete(String(id)) }
        ;(disposer as unknown as { statusChanged: () => number }).statusChanged = () => 1
        return disposer
      },
    },
    logger: { info: (line: string) => { loggerLines.push(line) } },
  } as unknown as Context
  return { ctx, registry, loggerLines }
}

const CHOICE_QUESTIONS = [{ kind: 'choice', id: 'route', options: [{ option: 'flash' }, { option: 'keep-current' }] }]

describe('apply', () => {
  it('registers the engine ready with egress none under its id', async () => {
    const { ctx, registry } = fakeCtx()
    apply(ctx, { entryRate: 1, seed: 3 })
    const entry = registry.get(String(judgmentEngineId('bench-random')))
    expect(entry).toBeDefined()
    expect(entry?.descriptor.egress).toBe('none')
    expect(entry?.status()).toEqual({ state: 'ready' })
    await expect(entry?.engine.ask({ questions: CHOICE_QUESTIONS, correlation: { sessionId: 's', consultKey: 'turn:0/step:0' } })).resolves.toMatchObject({
      engine: judgmentEngineId('bench-random'),
      model: 'bench-random',
    })
  })

  it('fails an ask without correlation closed with UNAVAILABLE', async () => {
    const { ctx, registry } = fakeCtx()
    apply(ctx, { entryRate: 1, seed: 3 })
    const entry = registry.get(String(judgmentEngineId('bench-random')))
    await expect(entry?.engine.ask({ questions: CHOICE_QUESTIONS })).rejects.toThrow(JudgmentError)
    await expect(entry?.engine.ask({ questions: CHOICE_QUESTIONS })).rejects.toThrow(/needs a session correlation/)
  })

  it('maps the consult answers and logs the draw', async () => {
    const { ctx, registry, loggerLines } = fakeCtx()
    apply(ctx, { entryRate: 1, seed: 3 })
    const entry = registry.get(String(judgmentEngineId('bench-random')))
    const result = await entry?.engine.ask({ questions: CHOICE_QUESTIONS, correlation: { sessionId: 's', consultKey: 'turn:2/step:1' } }) as {
      answers: { id: string }[]
      model: string
      latencyMs: number
    }
    expect(result.answers.map(answer => answer.id)).toEqual(['route'])
    expect(result.latencyMs).toBeTypeOf('number')
    // The runtime logger interpolates lazily, so the fake captures the format
    // string with its placeholders, not the substituted line.
    expect(loggerLines[0]).toContain('bench-random: consult u=')
    expect(loggerLines[0]).toContain('session=%s key=%s')
  })
})
