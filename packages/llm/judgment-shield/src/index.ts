/**
 * Owned local Shield provider for the typed-judgment seam, registered in
 * `ctx.judgmentEngines` as `shield` for `judgment-dispatch` to route asks to.
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

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import { judgmentEngineId, registerJudgmentEngine } from '@shres-code/shres-code-judgment'
import type {
  JudgmentEngine,
  JudgmentEngineDescriptor,
  JudgmentEngineId,
  JudgmentEngineStatus,
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

/** Registry id this provider registers its engine under. */
export const SHIELD_ENGINE_ID: JudgmentEngineId = judgmentEngineId('shield')

/**
 * Registry facts for the Shield engine: a calibrated classifier served by a
 * gateway process on the same host, with tokenizer-exact fitting.
 */
export const SHIELD_ENGINE_DESCRIPTOR: JudgmentEngineDescriptor = Object.freeze({
  id: SHIELD_ENGINE_ID,
  label: 'Shield (local gateway)',
  egress: 'local',
  calibration: 'calibrated',
  supportsFitting: true,
})

/**
 * Status of an engine whose gateway availability is owned by the deployment:
 * an unreachable gateway surfaces per ask as `UNAVAILABLE`.
 */
const READY: JudgmentEngineStatus = Object.freeze({ state: 'ready' })

/**
 * Local Shield judgment engine. One instance registers in
 * `ctx.judgmentEngines` as {@link SHIELD_ENGINE_ID} and sends no request unless
 * its explicit loopback endpoint is configured.
 */
export class ShieldJudgmentEngine implements JudgmentEngine {
  /** The engine registry provided by `judgment-dispatch`. */
  static inject = ['judgmentEngines']

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
  readonly fitting: JudgmentFittingEngine
  /** The shared Shield wire client bound to this provider's configuration. */
  private readonly wire: ShieldWireEngine
  /** The provider's context, read for the redaction hook on each ask. */
  private readonly ctx: Context

  /**
   * @param ctx - the provider context whose fiber owns the registration.
   * @param config - explicit loopback endpoint and fast/accurate artifact ids.
   * @throws Error when the endpoint is not loopback-only or any config field is invalid.
   */
  constructor(ctx: Context, config: ShieldJudgmentConfig = NO_CONFIG) {
    this.ctx = ctx
    this.config = resolveConfig(config)
    this.wire = createShieldWireEngine({
      ...this.config,
      redact: state => this.redactState(state),
      label: 'judgment-shield',
    })
    this.fitting = this.wire.fitting
    registerJudgmentEngine(ctx, { engine: this, descriptor: SHIELD_ENGINE_DESCRIPTOR, status: () => READY })
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
  ask(input: JudgmentInput): Promise<JudgmentResult> {
    return this.wire.ask(input)
  }

  /** Consult the optional deployment redactor exactly once. */
  private redactState(state: string): string | Promise<string> {
    const redactor = this.ctx.get('judgmentRedactor')
    return redactor === undefined ? state : redactor.redactState(state)
  }
}

export default ShieldJudgmentEngine
