/**
 * Owned local Shield provider for the typed-judgment seam.
 *
 * The provider sends one redacted typed ask to a loopback-only `/v1/judgments`
 * gateway. The gateway owns model execution and artifact provenance; this
 * package owns tier resolution, cancellation, response-size bounds, and strict
 * validation before an answer reaches a consumer. It has no Shield host-seat
 * or binary-injection-model semantics of its own. The wire client itself lives
 * in {@link createShieldWireEngine} so every provider speaking this wire shares
 * one implementation.
 *
 * @module @shres-code/shres-code-judgment-shield
 */

import { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import { JudgmentService } from '@shres-code/shres-code-judgment'
import type {
  JudgmentFittingEngine,
  JudgmentInput,
  JudgmentResult,
} from '@shres-code/shres-code-judgment'
import { createShieldWireEngine } from './client.ts'
import type { ShieldWireEngine } from './client.ts'
import {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  resolveConfig,
} from './config.ts'
import type { ResolvedShieldJudgmentConfig } from './config.ts'
import type { ShieldJudgmentConfig } from './types.ts'

export { createShieldWireEngine } from './client.ts'
export type { ShieldWireEngine, ShieldWireEngineOptions } from './client.ts'
export {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  DISTRIBUTION_TOLERANCE,
  MAX_RESPONSE_BYTES,
  resolveConfig,
  resolveTierModel,
} from './config.ts'
export type { ResolvedShieldJudgmentConfig } from './config.ts'
export {
  readFittedWireResponse,
  readWireResponse,
  SHIELD_ENGINE,
  toFittedWireRequest,
  toWireRequest,
} from './wire.ts'
export type {
  ReadShieldWireResponse,
  ShieldFittedWireRequest,
  ShieldWireQuestion,
  ShieldWireRequest,
  ShieldWireTokenFit,
  ShieldWireTokenLimits,
} from './wire.ts'
export type { ShieldJudgmentConfig, ShieldJudgmentModels } from './types.ts'

/** Config omitted by a direct `ctx.plugin(ShieldJudgmentEngine)` call. */
const NO_CONFIG = {} as ShieldJudgmentConfig

/**
 * Local Shield judgment provider. One instance registers `ctx.judgment` and
 * sends no request unless its explicit loopback endpoint is configured.
 */
export class ShieldJudgmentEngine extends JudgmentService {
  /**
   * Composition schema consumed by the Loader. Endpoint and model pin
   * validation is repeated by {@link resolveConfig} because direct
   * programmatic construction bypasses Schemastery.
   */
  static Config: z<ShieldJudgmentConfig> = z.object({
    endpoint: z.string().required(),
    models: z.object({
      fast: z.string().required(),
      accurate: z.string().required(),
    }).required(),
    timeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
    maxRequestBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_BYTES),
    maxResponseBytes: z.number().step(1).min(1).max(MAX_RESPONSE_BYTES).default(DEFAULT_MAX_RESPONSE_BYTES),
  })

  /** Resolved endpoint, artifact pins, deadline, and request/response body caps. */
  readonly config: ResolvedShieldJudgmentConfig
  /** Atomic tokenizer fitting and judgment supplied by this provider. */
  override readonly fitting: JudgmentFittingEngine
  /** The shared Shield wire client bound to this provider's configuration. */
  private readonly wire: ShieldWireEngine

  /**
   * @param ctx - context receiving `ctx.judgment`.
   * @param config - explicit loopback endpoint and fast/accurate artifact ids.
   * @throws Error when the endpoint is not loopback-only or any config field is invalid.
   */
  constructor(ctx: Context, config: ShieldJudgmentConfig = NO_CONFIG) {
    super(ctx)
    this.config = resolveConfig(config)
    this.wire = createShieldWireEngine({
      ...this.config,
      redact: state => this.redactState(state),
      label: 'judgment-shield',
    })
    this.fitting = this.wire.fitting
  }

  /**
   * Ask the owned local gateway to answer typed questions.
   *
   * The redactor runs once before the request deadline is armed. The deadline
   * covers fetch and the complete response body, and caller cancellation is
   * classified separately from a provider timeout. The gateway must report the
   * exact requested artifact and a complete validated probability distribution.
   *
   * @param input - state, typed questions, optional tier, and caller signal.
   * @returns validated gateway answers with its engine/model identity and the
   *   provider's wall-clock latency for the complete ask.
   * @throws JudgmentError with `UNAVAILABLE` for transport, HTTP, timeout, or
   *   response-body failures, `INPUT_TOO_LARGE` for a request over the
   *   configured request cap, `INVALID_ANSWER` for malformed JSON or answers,
   *   and `ABORTED` when the caller cancels the ask.
   */
  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    return this.wire.ask(input)
  }

  /** Consult the optional deployment redactor exactly once. */
  private redactState(state: string): string | Promise<string> {
    const redactor = this.ctx.get('judgmentRedactor')
    return redactor === undefined ? state : redactor.redactState(state)
  }
}

export default ShieldJudgmentEngine
