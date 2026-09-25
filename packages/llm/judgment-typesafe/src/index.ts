/**
 * TypeSafe AI "System One" judgment engine, registered in
 * `ctx.judgmentEngines` as `typesafe` for `judgment-dispatch` to route asks to.
 *
 * One ask sends the state and the typed questions to
 * `POST {endpoint}/v1/systemone` over raw `fetch` and maps the vendor's answer
 * vocabulary back onto the seam's, validating every field an answer depends on
 * before a consumer can see it. The API key is resolved through the optional
 * credentials seam on every ask and cached nowhere; the optional
 * `ctx.judgmentRedactor` hook is consulted exactly once per ask, before the
 * state is serialized — the provider is that hook's one home, so the state a
 * consumer passes arrives unredacted; and `timeoutMs` bounds the request, so a request that outlives its
 * deadline fails with `UNAVAILABLE` naming that figure while the caller's own
 * `AbortSignal` fails with `ABORTED`. The engine honours that signal at every
 * await, as the judgment engine contract requires: it is checked before each
 * step, and the credential lookup and the redaction hook, which cannot be
 * cancelled, are raced against it so a hanging one never holds a cancelled ask.
 *
 * A refused response is repeated only when its status is one of the configured
 * `retry.statuses` — the vendor's documented transient 429 and 529 by default —
 * up to `retry.maxRetries` times, after one fixed `retry.delayMs` wait that
 * ends at once when the ask is cancelled. A deterministic refusal such as 401 or
 * 422, an exhausted budget, a transport failure with no status at all, and every
 * other status still arrive as `UNAVAILABLE` on their first response. There is
 * no streaming.
 *
 * @module @shres-code/shres-code-judgment-typesafe
 */

import { Service } from '@shres-code/cordis'
import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import {
  abortableJudgmentStep,
  JudgmentError,
  judgmentEngineId,
  registerJudgmentEngine,
  throwIfJudgmentAborted,
} from '@shres-code/shres-code-judgment'
import type {
  JudgmentEngine,
  JudgmentEngineDescriptor,
  JudgmentEngineId,
  JudgmentEngineStatus,
  JudgmentErrorCode,
  JudgmentInput,
  JudgmentResult,
} from '@shres-code/shres-code-judgment'
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MODELS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RETRY_STATUSES,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
  resolveTierModel,
} from './config.ts'
import type { ResolvedTypesafeJudgmentConfig } from './config.ts'
import { readWireResponse, toWireRequest } from './wire.ts'
import type { WireRequest } from './wire.ts'
import type { TypesafeJudgmentConfig } from './types.ts'

export {
  DEFAULT_ENDPOINT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MODELS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RETRY_STATUSES,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
  resolveTierModel,
} from './config.ts'
export type { ResolvedTypesafeJudgmentConfig, ResolvedTypesafeJudgmentRetry } from './config.ts'
export { readWireResponse, toWireRequest } from './wire.ts'
export type { ReadWireResponse, WireNoulCriteria, WireQuestion, WireRequest } from './wire.ts'
export type { TypesafeJudgmentConfig, TypesafeJudgmentModels, TypesafeJudgmentRetry } from './types.ts'

/** Value the seam reports as the engine that produced an answer. */
const ENGINE = 'typesafe'

/** Registry id this provider registers its engine under. */
export const TYPESAFE_ENGINE_ID: JudgmentEngineId = judgmentEngineId(ENGINE)

/**
 * Registry facts for the TypeSafe engine: a remote, retained-input service
 * with calibrated classifier probabilities and no tokenizer fitting, governed
 * by the vendor's site terms.
 */
export const TYPESAFE_ENGINE_DESCRIPTOR: JudgmentEngineDescriptor = Object.freeze({
  id: TYPESAFE_ENGINE_ID,
  label: 'Jev (TypeSafe)',
  egress: 'remote',
  calibration: 'calibrated',
  supportsFitting: false,
  terms: 'https://typesafe.ai/legal/terms',
})

/** Status once the credential reference resolved to a value. */
const READY: JudgmentEngineStatus = Object.freeze({ state: 'ready' })

/** Diagnostic of every caller cancellation this engine reports. */
const CANCELLED = 'TypeSafe judgment ask was cancelled by the caller'

/** Vendor path one ask posts to, below the configured endpoint. */
const SYSTEMONE_PATH = '/v1/systemone'

/**
 * Composition entry a row that names no config resolves to. Which reference
 * holds the API key is the deployment's decision, so there is no usable default
 * key: this empty reference reaches {@link resolveConfig}, which fails plugin
 * load with a message naming `apiKeyRef`.
 */
const NO_CONFIG: TypesafeJudgmentConfig = { apiKeyRef: '' }

/** Signals one ask runs under, kept apart so a fired deadline is distinguishable from cancellation. */
interface AskCancellation {
  /** Signal handed to `fetch`: the caller's signal when supplied, fused with the ask deadline. */
  readonly signal: AbortSignal
  /** The ask deadline alone. */
  readonly deadline: AbortSignal
  /** The caller's signal, absent when the ask supplied none. */
  readonly caller: AbortSignal | undefined
  /** The configured deadline in milliseconds, named by the timeout diagnostic. */
  readonly timeoutMs: number
}

/**
 * TypeSafe AI judgment engine: one HTTP request per attempt, one validated
 * answer per question, no session event and no prompt text of its own.
 *
 * Registered in `ctx.judgmentEngines` as {@link TYPESAFE_ENGINE_ID}. Its status
 * reports whether the credential reference currently resolves: `starting` until
 * the first check settles, `unconfigured` while no credentials service is
 * mounted or the reference holds no value, `unavailable` when the credentials
 * service fails, and `ready` otherwise. The check runs at registration, on
 * every `credentials/updated` for the reference, whenever the status is read
 * while not `ready`, and after each ask's own resolution, so a stored key
 * reaches the status without a restart. The plugin finishes loading only once
 * the first check settles, so a Loader composition never routes an ask while
 * the status is still `starting`. The status says nothing about the
 * vendor endpoint, whose failures still surface per ask. Nothing is cached
 * across asks — the credential reference is re-resolved and the deadline is
 * restarted on every call — so a rotated key reaches the next ask without a
 * restart. A refused attempt adds nothing to that list: the same ask is sent
 * again after the configured wait, and the credential and deadline of the ask
 * are the ones the first attempt used.
 */
export class TypesafeJudgmentEngine implements JudgmentEngine {
  /** The engine registry provided by `judgment-dispatch`. */
  static inject = ['judgmentEngines']

  /**
   * Composition config schema. Unrecognized keys and wrong types fail plugin
   * load by name; a row that names no config fails on the missing `apiKeyRef`.
   */
  static Config: z<TypesafeJudgmentConfig> = z.object({
    apiKeyRef: z.string().role('credential-ref').required(),
    endpoint: z.string().default(DEFAULT_ENDPOINT),
    models: z.object({
      fast: z.string().required(),
      accurate: z.string().required(),
    }).default(DEFAULT_MODELS),
    timeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
    retry: z.object({
      maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
      delayMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RETRY_DELAY_MS),
      statuses: z.array(z.number().step(1).min(100).max(599)).default([...DEFAULT_RETRY_STATUSES]),
    }),
  })

  /** Resolved and validated ask facts. */
  readonly config: ResolvedTypesafeJudgmentConfig
  /** The provider's context, read for the credentials service and the redaction hook on each ask. */
  private readonly ctx: Context
  /** The last credential readiness observed. */
  private readiness: JudgmentEngineStatus
  /** The readiness check in flight, and whether another must follow it. */
  private inFlight: Promise<void> | undefined
  private recheck = false
  /** Announce a status change to the registry. */
  private readonly announce: () => void

  /**
   * @param ctx - the provider context whose fiber owns the registration.
   * @param config - composition config; a row that names none fails load on
   *   the missing `apiKeyRef`.
   */
  constructor(ctx: Context, config: TypesafeJudgmentConfig = NO_CONFIG) {
    this.ctx = ctx
    this.config = resolveConfig(config)
    this.readiness = Object.freeze({ state: 'starting', detail: `checking ${this.config.apiKeyRef}` })
    this.announce = registerJudgmentEngine(ctx, {
      engine: this,
      descriptor: Object.freeze({
        ...TYPESAFE_ENGINE_DESCRIPTOR,
        models: Object.freeze({ fast: this.config.models.fast, accurate: this.config.models.accurate }),
        destination: new URL(this.config.endpoint).host,
      }),
      status: () => this.status(),
    })
    ctx.effect(() => ctx.on('credentials/updated', (ref) => {
      if (ref === this.config.apiKeyRef) void this.checkReadiness()
    }), 'judgment-typesafe: re-check the credential on change')
    void this.checkReadiness()
  }

  /**
   * The registry's status reader. A read while not `ready` also starts a
   * re-check, so a credential stored without an event still reaches the status.
   * @returns the last observed readiness.
   */
  private status(): JudgmentEngineStatus {
    if (this.readiness.state !== 'ready') void this.checkReadiness()
    return this.readiness
  }

  /** Finish loading once the first readiness check settles. */
  protected async [Service.init](): Promise<void> {
    await this.inFlight
  }

  /**
   * Resolve the reference once and record the outcome; requests made while a
   * check is in flight coalesce into one follow-up check.
   * @returns the check in flight, settled once it and any follow-up recorded their outcome.
   */
  private checkReadiness(): Promise<void> {
    if (this.inFlight !== undefined) {
      this.recheck = true
      return this.inFlight
    }
    const check = this.resolveApiKey().then(
      () => READY,
      (error: unknown): JudgmentEngineStatus => error instanceof JudgmentError
        ? { state: 'unconfigured', detail: error.message }
        : { state: 'unavailable', detail: `judgment-typesafe: ${this.config.apiKeyRef} could not be read: ${error instanceof Error ? error.message : String(error)}` },
    ).then((next): Promise<void> | undefined => {
      this.inFlight = undefined
      this.observe(next)
      if (!this.recheck) return undefined
      this.recheck = false
      return this.checkReadiness()
    })
    this.inFlight = check
    return check
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

  /**
   * Answer one set of typed questions about one state.
   * @param input - the state, the questions, the optional tier, and the cancellation signal.
   * @returns the answers in ask order with `engine: 'typesafe'`, the model id the
   *   response reported, and the ask's duration in whole milliseconds, which
   *   covers every attempt and wait the ask spent.
   * @throws JudgmentError code `UNCONFIGURED` when the credentials seam is absent
   *   or the reference resolves to nothing, code `UNAVAILABLE` when the request
   *   fails, is refused — including a transient refusal that outlasts
   *   `retry.maxRetries` — or outlives `timeoutMs`, code `INVALID_ANSWER` when
   *   the response cannot answer the questions asked, or code `ABORTED` when the
   *   caller cancelled the ask: before it started, during the credential lookup
   *   or the redaction hook (without waiting for either to finish), or during
   *   the request, the body read, or a retry wait.
   */
  async ask(input: JudgmentInput): Promise<JudgmentResult> {
    const startedAt = performance.now()
    const config = this.config
    const signal = input.signal
    throwIfJudgmentAborted(signal, CANCELLED)
    const apiKey = await abortableJudgmentStep(() => this.resolveApiKey(), signal, CANCELLED).then((key) => {
      this.observe(READY)
      return key
    }, (error: unknown) => {
      if (error instanceof JudgmentError && error.code === 'UNCONFIGURED') this.observe({ state: 'unconfigured', detail: error.message })
      throw error
    })
    throwIfJudgmentAborted(signal, CANCELLED)
    const state = await abortableJudgmentStep(() => this.redactState(input.state), signal, CANCELLED)
    throwIfJudgmentAborted(signal, CANCELLED)
    const model = resolveTierModel(config.models, input.tier)
    const cancellation = askCancellation(input.signal, config.timeoutMs)
    const response = await this.post(toWireRequest(state, model, input.questions), apiKey, cancellation)
    const body = await this.readBody(response, cancellation)
    const read = readWireResponse(body, input.questions)
    return {
      answers: read.answers,
      engine: ENGINE,
      model: read.model,
      latencyMs: Math.round(performance.now() - startedAt),
    }
  }

  /**
   * Resolve this ask's API key through the optional credentials service. The
   * reference is resolved on every ask and nothing is cached, which is what lets
   * a rotated key reach the next ask without a restart.
   * @returns the key to send as the bearer token.
   * @throws JudgmentError code `UNCONFIGURED` when no credentials service is
   *   mounted or the reference currently holds no value.
   */
  private async resolveApiKey(): Promise<string> {
    const ref = this.config.apiKeyRef
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new JudgmentError(
        'UNCONFIGURED',
        `judgment-typesafe: ${ref} cannot be resolved because no credentials service is mounted; `
        + `mount the credentials seam (ctx.credentials) and store ${ref} through it`,
      )
    }
    const resolved = await credentials.resolve(ref)
    if (resolved === undefined || resolved.value.length === 0) {
      throw new JudgmentError(
        'UNCONFIGURED',
        `judgment-typesafe: ${ref} holds no value; store ${ref} through the credentials service`,
      )
    }
    return resolved.value
  }

  /**
   * Consult the deployment's egress hook once, or send the state unchanged.
   * This is the hook's one consult per ask: the seam obliges every provider to
   * make it and no consumer to.
   * @param state - the state the consumer supplied, unredacted.
   * @returns the text to send; a mounted hook's own return value, awaited.
   */
  private redactState(state: string): string | Promise<string> {
    const redactor = this.ctx.get('judgmentRedactor')
    return redactor === undefined ? state : redactor.redactState(state)
  }

  /**
   * Send one ask and return its accepted response, retrying a transient
   * refusal. A non-2xx status fails here, so no caller ever reads an error body
   * as an answer.
   *
   * The retry decision reads the refused status and the remaining budget on the
   * response itself: a status the policy does not name, and a budget already
   * spent, both surface that response's own `UNAVAILABLE` failure, so an
   * exhausted retry is indistinguishable from the single attempt this engine
   * made before retry existed.
   * @param request - the mapped request body.
   * @param apiKey - the bearer token resolved for this ask.
   * @param cancellation - the ask's signals and deadline.
   * @returns the accepted response.
   * @throws JudgmentError classified by {@link stepFailure}.
   */
  private async post(request: WireRequest, apiKey: string, cancellation: AskCancellation): Promise<Response> {
    const endpoint = this.config.endpoint
    const retry = this.config.retry
    for (let attempt = 0; ; attempt += 1) {
      let response: Response
      try {
        response = await fetch(`${endpoint}${SYSTEMONE_PATH}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(request),
          signal: cancellation.signal,
        })
      } catch (error: unknown) {
        throw stepFailure(error, cancellation, 'UNAVAILABLE', `TypeSafe request to ${endpoint} failed`)
      }
      if (response.ok) return response
      const failure = await httpFailure(response, endpoint, cancellation)
      if (attempt >= retry.maxRetries || !retry.statuses.includes(response.status)) throw failure
      await this.backOff(retry.delayMs, cancellation)
    }
  }

  /**
   * Wait the configured fixed delay before the next attempt. The wait is the
   * ask's own cancellation point: a caller that cancels during it stops the ask
   * rather than spending the delay on a request that is already doomed, and a
   * deadline that passes during it reports the timeout the request would.
   * @param delayMs - the configured fixed delay in milliseconds.
   * @param cancellation - the ask's signals and deadline.
   * @throws JudgmentError code `ABORTED` when the caller cancelled, or code
   *   `UNAVAILABLE` naming `timeoutMs` when the deadline passed, both classified
   *   by {@link stepFailure}.
   */
  private async backOff(delayMs: number, cancellation: AskCancellation): Promise<void> {
    try {
      await retryWait(delayMs, cancellation.signal)
    } catch (error: unknown) {
      throw stepFailure(
        error,
        cancellation,
        'UNAVAILABLE',
        `TypeSafe judgment ask did not finish retrying within timeoutMs ${cancellation.timeoutMs}`,
      )
    }
  }

  /**
   * Read one accepted response body.
   * @param response - the accepted response.
   * @param cancellation - the ask's signals and deadline, which classify a body
   *   that cannot be read.
   * @returns the parsed JSON body.
   * @throws JudgmentError code `ABORTED` or `UNAVAILABLE` when the ask was
   *   cancelled or timed out while the body was outstanding, otherwise code
   *   `INVALID_ANSWER` for a body that is not JSON.
   */
  private async readBody(response: Response, cancellation: AskCancellation): Promise<unknown> {
    try {
      return await response.json()
    } catch (error: unknown) {
      throw stepFailure(error, cancellation, 'INVALID_ANSWER', 'TypeSafe response body is not JSON')
    }
  }
}

/**
 * Wait one fixed retry delay, ending as soon as the ask is cancelled.
 *
 * The signal is read once up front and then observed by listener, because an
 * `AbortSignal` fires no event for an abort that already happened: a wait
 * entered with a cancelled ask ends immediately instead of sleeping the delay
 * out. A wait entered with no cancellation resolves on the timer alone.
 *
 * @param delayMs - the delay to wait in milliseconds; `0` waits one timer turn.
 * @param signal - the ask's cancellation signal, which ends the wait when it aborts.
 * @returns a promise that resolves once the delay has elapsed.
 * @throws Error carrying the signal's own abort reason when the ask is cancelled first.
 */
export function retryWait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * One cancellation reason as a thrown error, so a wait never rejects with a
 * non-error value. An `AbortSignal` without an explicit reason aborts with a
 * `DOMException`, which this wraps and keeps as the cause.
 * @param signal - the signal that aborted.
 * @returns the signal's reason when it is an Error, otherwise a wrapping error.
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('TypeSafe judgment retry wait was cancelled by the caller', { cause: signal.reason })
}

/**
 * Fuse the caller's cancellation with this request's deadline. The deadline
 * starts here, so it bounds the vendor request rather than credential
 * resolution or redaction, which run before it.
 * @param caller - the ask's own signal, absent when it supplied none.
 * @param timeoutMs - the configured request deadline.
 * @returns the signal to hand to `fetch` and the deadline facts that classify a failure.
 */
function askCancellation(caller: AbortSignal | undefined, timeoutMs: number): AskCancellation {
  const deadline = AbortSignal.timeout(timeoutMs)
  return {
    signal: caller === undefined ? deadline : AbortSignal.any([caller, deadline]),
    deadline,
    caller,
    timeoutMs,
  }
}

/**
 * Classify one failed transport step. Caller cancellation wins over the
 * deadline, which wins over the step's own failure: a caller that cancelled the
 * ask asked for it to stop whatever the provider was doing.
 * @param failure - what the step threw.
 * @param cancellation - the ask's signals and deadline.
 * @param code - failure class when neither the caller nor the deadline explains the step.
 * @param message - diagnostic when neither the caller nor the deadline explains the step.
 * @returns the classified failure to throw.
 */
function stepFailure(
  failure: unknown,
  cancellation: AskCancellation,
  code: JudgmentErrorCode,
  message: string,
): JudgmentError {
  if (cancellation.caller?.aborted === true) {
    return new JudgmentError('ABORTED', CANCELLED, { cause: failure })
  }
  if (cancellation.deadline.aborted) {
    return new JudgmentError(
      'UNAVAILABLE',
      `TypeSafe judgment ask did not answer within timeoutMs ${cancellation.timeoutMs}`,
      { cause: failure },
    )
  }
  return new JudgmentError(code, message, { cause: failure })
}

/**
 * Build the failure for one non-2xx response: the HTTP status, plus the
 * provider's own message when the error body carries one. A body that cannot be
 * read, or does not parse to an object with a message, leaves the status
 * authoritative and never changes the failure class.
 * @param response - the refused response.
 * @param endpoint - the endpoint the request went to.
 * @param cancellation - the ask's signals and deadline.
 * @returns the `UNAVAILABLE` failure naming the status.
 * @throws JudgmentError classified by {@link stepFailure} when the error body
 *   cannot be read at all.
 */
async function httpFailure(
  response: Response,
  endpoint: string,
  cancellation: AskCancellation,
): Promise<JudgmentError> {
  const status = `TypeSafe returned HTTP ${response.status} from ${endpoint}`
  let detail: string | undefined
  try {
    detail = wireErrorMessage(await response.text())
  } catch (error: unknown) {
    throw stepFailure(error, cancellation, 'UNAVAILABLE', status)
  }
  return new JudgmentError('UNAVAILABLE', detail === undefined ? status : `${status}: ${detail}`)
}

/**
 * Provider message carried by one error body, at the top level or under
 * `error`.
 * @param body - the error body as received.
 * @returns the provider's message, or `undefined` when the body is not JSON, is
 *   not an object, or carries no string message.
 */
function wireErrorMessage(body: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // A gateway can answer with HTML or nothing at all; the HTTP status stays authoritative.
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const nested = parsed.error
  const message = isRecord(nested) ? nested.message : parsed.message
  return typeof message === 'string' ? message : undefined
}

/** Whether a parsed JSON value is a plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default TypesafeJudgmentEngine
