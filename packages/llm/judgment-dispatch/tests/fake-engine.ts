/**
 * Fake judgment engines for the dispatcher suites: each records its asks and
 * answers with its own engine name, so a test can tell which engine answered.
 */

import type { Context } from '@shres-code/cordis'
import { judgmentEngineId, registerJudgmentEngine } from '@shres-code/shres-code-judgment'
import type {
  JudgmentEngine,
  JudgmentEngineDescriptor,
  JudgmentEngineHost,
  JudgmentEngineStatus,
  JudgmentFittingEngine,
  JudgmentFittingInput,
  JudgmentFittingResult,
  JudgmentInput,
  JudgmentResult,
} from '@shres-code/shres-code-judgment'

/** Config of one fake engine plugin. */
export interface FakeEngineConfig {
  /** Registry id. */
  id: string
  /** Whether the engine exposes fitting. */
  fitting?: boolean
  /** Host the descriptor requires. */
  host?: JudgmentEngineHost
  /** Initial status. */
  status?: JudgmentEngineStatus
  /** Failure every ask rejects with. */
  failWith?: Error
}

/** A registry-registered fake engine; plugin it once per id. */
export class FakeEngine implements JudgmentEngine {
  static inject = ['judgmentEngines']

  readonly asks: JudgmentInput[] = []
  readonly fittedAsks: JudgmentFittingInput[] = []
  readonly fitting?: JudgmentFittingEngine
  readonly descriptor: JudgmentEngineDescriptor
  private current: JudgmentEngineStatus
  private readonly announce: () => void

  constructor(ctx: Context, private readonly config: FakeEngineConfig) {
    this.current = config.status ?? { state: 'ready' }
    if (config.fitting === true) this.fitting = { ask: input => this.askFitted(input) }
    this.descriptor = {
      id: judgmentEngineId(config.id),
      label: `Fake ${config.id}`,
      egress: 'none',
      calibration: 'calibrated',
      supportsFitting: config.fitting === true,
      ...config.host === undefined ? {} : { host: config.host },
    }
    this.announce = registerJudgmentEngine(ctx, { engine: this, descriptor: this.descriptor, status: () => this.current })
  }

  /** Change the status and announce it. */
  setStatus(status: JudgmentEngineStatus): void {
    this.current = status
    this.announce()
  }

  ask(input: JudgmentInput): Promise<JudgmentResult> {
    this.asks.push(input)
    if (this.config.failWith !== undefined) return Promise.reject(this.config.failWith)
    return Promise.resolve({ answers: [], engine: `fake-${this.config.id}`, model: `${this.config.id}-1`, latencyMs: 1 })
  }

  private askFitted(input: JudgmentFittingInput): Promise<JudgmentFittingResult> {
    this.fittedAsks.push(input)
    if (this.config.failWith !== undefined) return Promise.reject(this.config.failWith)
    const limits = { maxSequenceTokens: 8, maxHeadTokens: 4, maxBatchTokens: 16, manifestSha256: 'fake' }
    if (input.states[0] === 'unfit') {
      return Promise.resolve({ kind: 'unfit', engine: `fake-${this.config.id}`, model: `${this.config.id}-1`, limits, reason: 'state' })
    }
    return Promise.resolve({
      kind: 'answered',
      fit: { selectedIndex: 0, state: input.states[0] ?? '', stateTokens: 1, sequenceTokens: [], paddedTokens: 0, limits },
      result: { answers: [], engine: `fake-${this.config.id}`, model: `${this.config.id}-1`, latencyMs: 1 },
    })
  }
}
