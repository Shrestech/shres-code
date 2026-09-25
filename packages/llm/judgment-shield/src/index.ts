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

import { Service } from '@shres-code/cordis'
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
  DEFAULT_READINESS_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  resolveConfig,
} from './config.ts'
import type { ResolvedShieldJudgmentConfig } from './config.ts'
import { probeGateway, probeTarget } from './readiness.ts'
import type { ShieldJudgmentConfig } from './types.ts'

export { createShieldWireEngine } from './client.ts'
export type { ShieldWireEngine, ShieldWireEngineOptions } from './client.ts'
export { probeGateway, probeTarget } from './readiness.ts'
export type { ShieldProbeTarget } from './readiness.ts'
export {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_READINESS_INTERVAL_MS,
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

/** Status once the gateway accepted a connection or answered an ask. */
const READY: JudgmentEngineStatus = Object.freeze({ state: 'ready' })

/**
 * Local Shield judgment engine. One instance registers in
 * `ctx.judgmentEngines` as {@link SHIELD_ENGINE_ID} and sends no judgment
 * request unless its explicit loopback endpoint is configured.
 *
 * Its status reports whether the deployment-run gateway is reachable:
 * `starting` until the first probe settles, then `ready` or `unavailable` with
 * the connection failure. A probe opens one TCP connection to the endpoint at
 * registration, every `readinessIntervalMs`, and whenever the status is read
 * while not `ready`; an answered ask also reports `ready`. A failed ask leaves
 * the status to the next probe, because an HTTP or answer failure comes from a
 * gateway that is reachable. The plugin finishes loading only once the first
 * probe settles, so a Loader composition never routes an ask while the status
 * is still `starting`.
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
    readinessIntervalMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_READINESS_INTERVAL_MS),
  })

  /** Resolved endpoint, artifact pins, deadline, and request/response body caps. */
  readonly config: ResolvedShieldJudgmentConfig
  /** Atomic tokenizer fitting and judgment supplied by this provider. */
  readonly fitting: JudgmentFittingEngine
  /** The shared Shield wire client bound to this provider's configuration. */
  private readonly wire: ShieldWireEngine
  /** The provider's context, read for the redaction hook on each ask. */
  private readonly ctx: Context
  /** The last gateway readiness observed. */
  private readiness: JudgmentEngineStatus
  /** The readiness probe in flight. */
  private inFlight: Promise<void> | undefined
  /** Announce a status change to the registry. */
  private readonly announce: () => void

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
    this.fitting = { ask: input => this.observeAnswered(this.wire.fitting.ask(input)) }
    const destination = new URL(this.config.endpoint).host
    this.readiness = Object.freeze({ state: 'starting', detail: `connecting to ${destination}` })
    this.announce = registerJudgmentEngine(ctx, {
      engine: this,
      descriptor: Object.freeze({
        ...SHIELD_ENGINE_DESCRIPTOR,
        models: Object.freeze({ fast: this.config.models.fast, accurate: this.config.models.accurate }),
        destination,
      }),
      status: () => this.status(),
    })
    ctx.effect(() => {
      const timer = setInterval(() => {
        void this.probe()
      }, this.config.readinessIntervalMs)
      timer.unref()
      return () => {
        clearInterval(timer)
      }
    }, 'judgment-shield: periodic readiness probe')
    void this.probe()
  }

  /** Finish loading once the first readiness probe settles. */
  protected async [Service.init](): Promise<void> {
    await this.inFlight
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
    return this.observeAnswered(this.wire.ask(input))
  }

  /**
   * The registry's status reader. A read while not `ready` also starts a
   * probe, so a gateway that came up is seen without waiting for the interval.
   * @returns the last observed readiness.
   */
  private status(): JudgmentEngineStatus {
    if (this.readiness.state !== 'ready') void this.probe()
    return this.readiness
  }

  /**
   * Probe the gateway once; a probe already in flight covers the request.
   * @returns the probe in flight, settled once it recorded its outcome.
   */
  private probe(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    const probe = probeGateway(probeTarget(this.config.endpoint), this.config.timeoutMs).then((failure) => {
      this.inFlight = undefined
      this.observe(failure === undefined
        ? READY
        : { state: 'unavailable', detail: `judgment-shield: the gateway at ${new URL(this.config.endpoint).host} is not accepting connections: ${failure}` })
    })
    this.inFlight = probe
    return probe
  }

  /**
   * Report `ready` once an ask or fitted ask answered; a failure passes through unchanged.
   * @param answer - the pending answer.
   * @returns the same answer.
   */
  private async observeAnswered<T>(answer: Promise<T>): Promise<T> {
    const value = await answer
    this.observe(READY)
    return value
  }

  /**
   * Record one readiness observation, announcing it when it differs.
   * @param next - the observed status.
   */
  private observe(next: JudgmentEngineStatus): void {
    if (next.state === this.readiness.state && next.detail === this.readiness.detail) return
    this.readiness = Object.freeze({ ...next })
    this.announce()
  }

  /** Consult the optional deployment redactor exactly once. */
  private redactState(state: string): string | Promise<string> {
    const redactor = this.ctx.get('judgmentRedactor')
    return redactor === undefined ? state : redactor.redactState(state)
  }
}

export default ShieldJudgmentEngine
