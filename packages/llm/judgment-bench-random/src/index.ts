/**
 * Bench-random judgment engine, registered in `ctx.judgmentEngines` as
 * `bench-random` for `judgment-dispatch` to route asks to.
 *
 * The engine implements the random-matched arm of the routing measurement
 * (`bench/routing/prereg-2026-10.md`): a seeded draw per consult selects the
 * downgrade candidate with probability `entryRate`, the rate the treated arm
 * realized at its cold points, so the contrast isolates the judge's
 * discrimination from its entry rate. The ruled draw is
 * `u = hash(seed, sessionId, consultKey)` over the ask's
 * [`JudgmentInput.correlation`](../../judgment/src/types.ts) — the router
 * supplies the session id and `turn:<n>/step:<n>`. An ask without correlation
 * fails closed `UNAVAILABLE`: the arm never runs on a draw it cannot audit.
 * The engine sends nothing anywhere — egress `none`, no credential, no model
 * request — so it prices at zero tokens like the other local engines.
 *
 * @module @shres-code/shres-code-judgment-bench-random
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { JudgmentError, judgmentEngineId, registerJudgmentEngine } from '@shres-code/shres-code-judgment'
import type { JudgmentAnswer, JudgmentEngine, JudgmentEngineDescriptor, JudgmentInput, JudgmentResult } from '@shres-code/shres-code-judgment'
import { resolveConfig } from './config.ts'
import { consult } from './engine.ts'
import type { ResolvedBenchRandomConfig } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'judgment-bench-random'

/** The engine registry must exist before the registration effect runs. */
export const inject = ['judgmentEngines']

/** Plugin config: the matched entry rate and the draw seed. */
export interface Config {
  /** Probability that one consult selects the downgrade candidate. */
  entryRate: number
  /** 32-bit seed of the consult draw hash. */
  seed: number
}

export const Config: z<Config> = z.object({
  entryRate: z.number().min(0).max(1).required(),
  seed: z.natural().required(),
})

/** Static descriptor: nothing leaves the process and no artifact is named. */
const DESCRIPTOR: JudgmentEngineDescriptor = {
  id: judgmentEngineId('bench-random'),
  label: 'Bench random-matched (seeded)',
  egress: 'none',
  calibration: 'calibrated',
  supportsFitting: false,
  models: { fast: 'bench-random', accurate: 'bench-random' },
}

/**
 * Mount the engine for the owning fiber's lifetime.
 * @param ctx - plugin context carrying the engine registry.
 * @param config - validated entry rate and seed.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedBenchRandomConfig = resolveConfig(config)
  const engine: JudgmentEngine = {
    async ask(input: JudgmentInput): Promise<JudgmentResult> {
      // The ruled draw keys on the ask's correlation facts; without them the
      // ask fails closed instead of drawing on a substitute identity.
      if (input.correlation === undefined) {
        throw new JudgmentError('UNAVAILABLE', 'bench-random needs a session correlation')
      }
      const startedAt = Date.now()
      const result = consult(resolved, input.correlation, input.questions)
      ctx.logger.info(
        'bench-random: consult u=%.6f entryRate=%.2f session=%s key=%s',
        result.draw,
        resolved.entryRate,
        input.correlation.sessionId,
        input.correlation.consultKey,
      )
      return {
        // The ids pass through unchanged from the asked questions, so the
        // question brands hold at runtime; the structural core cannot carry
        // them because it is Cordis-free.
        answers: result.answers as unknown as readonly JudgmentAnswer[],
        engine: DESCRIPTOR.id,
        model: 'bench-random',
        latencyMs: Date.now() - startedAt,
      }
    },
  }
  registerJudgmentEngine(ctx, {
    engine,
    descriptor: DESCRIPTOR,
    status: () => ({ state: 'ready' }),
  })
}
