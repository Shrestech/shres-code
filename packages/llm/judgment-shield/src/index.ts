/**
 * Owned local Shield provider for the typed-judgment seam.
 *
 * The provider sends one redacted typed ask to a loopback-only `/v1/judgments`
 * gateway. The gateway owns model execution and artifact provenance; this
 * package owns tier resolution, cancellation, response-size bounds, and strict
 * validation before an answer reaches a consumer. It has no Shield host-seat
 * or binary-injection-model semantics of its own.
 *
 * @module @shres-code/shres-code-judgment-shield
 */

import { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import {
  JudgmentError,
  JudgmentService,
} from '@shres-code/shres-code-judgment'
import type {
  JudgmentErrorCode,
  JudgmentFittingEngine,
  JudgmentFittingInput,
  JudgmentFittingResult,
  JudgmentInput,
  JudgmentResult,
} from '@shres-code/shres-code-judgment'
import {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  resolveConfig,
  resolveTierModel,
} from './config.ts'
import type { ResolvedShieldJudgmentConfig } from './config.ts'
import {
  readFittedWireResponse,
  readWireResponse,
  toFittedWireRequest,
  toWireRequest,
} from './wire.ts'
import type { ShieldFittedWireRequest, ShieldWireRequest } from './wire.ts'
import type { ShieldJudgmentConfig } from './types.ts'

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

/** Gateway path for one typed judgment ask. */
const JUDGMENT_PATH = '/v1/judgments'

/** Gateway path for one atomic fit-and-ask. */
const FITTED_JUDGMENT_PATH = '/v1/judgments/fitted'

/** Config omitted by a direct `ctx.plugin(ShieldJudgmentEngine)` call. */
const NO_CONFIG = {} as ShieldJudgmentConfig

/** Signals and facts used to classify one ask's cancellation. */
interface AskCancellation {
  /** Fused signal handed to fetch and response-body reads. */
  readonly signal: AbortSignal
  /** Provider deadline signal, distinguished from caller cancellation. */
  readonly deadline: AbortSignal
  /** Caller signal, when one was supplied. */
  readonly caller: AbortSignal | undefined
  /** Configured timeout, included in deadline diagnostics. */
  readonly timeoutMs: number
}

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

  /**
   * @param ctx - context receiving `ctx.judgment`.
   * @param config - explicit loopback endpoint and fast/accurate artifact ids.
   * @throws Error when the endpoint is not loopback-only or any config field is invalid.
   */
  constructor(ctx: Context, config: ShieldJudgmentConfig = NO_CONFIG) {
    super(ctx)
    this.config = resolveConfig(config)
    this.fitting = { ask: input => this.askFitted(input) }
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
  override async ask(input: JudgmentInput): Promise<JudgmentResult> {
    throwIfCallerAborted(input.signal)
    const startedAt = performance.now()
    const state = await abortable(() => this.redactState(input.state), input.signal)
    const model = resolveTierModel(this.config.models, input.tier)
    const cancellation = askCancellation(input.signal, this.config.timeoutMs)
    const request = toWireRequest(state, model, input.questions)
    const body = await postWireBody(
      this.config.endpoint,
      JUDGMENT_PATH,
      request,
      this.config.maxRequestBytes,
      this.config.maxResponseBytes,
      cancellation,
    )
    throwIfCallerAborted(input.signal)
    const result = readWireResponse(body, input.questions, model)
    throwIfCallerAborted(input.signal)
    return { ...result, latencyMs: Math.round(performance.now() - startedAt) }
  }

  /** Fit each redacted candidate and judge the selected one atomically. */
  private async askFitted(input: JudgmentFittingInput): Promise<JudgmentFittingResult> {
    const startedAt = performance.now()
    throwIfCallerAborted(input.signal)
    const model = resolveTierModel(this.config.models, input.tier)
    const states: string[] = []
    try {
      for (const state of input.states) {
        throwIfCallerAborted(input.signal)
        states.push(await abortable(() => this.redactState(state), input.signal))
        throwIfCallerAborted(input.signal)
      }
    } catch (error: unknown) {
      if (input.signal?.aborted === true) {
        throw new JudgmentError('ABORTED', 'judgment-shield ask was cancelled by the caller', { cause: error })
      }
      throw error
    }
    const cancellation = askCancellation(input.signal, this.config.timeoutMs)
    const request = toFittedWireRequest(states, model, input.questions)
    const body = await postWireBody(
      this.config.endpoint,
      FITTED_JUDGMENT_PATH,
      request,
      this.config.maxRequestBytes,
      this.config.maxResponseBytes,
      cancellation,
    )
    throwIfCallerAborted(input.signal)
    const result = readFittedWireResponse(body, states, input.questions, model)
    throwIfCallerAborted(input.signal)
    if (result.kind === 'unfit') return result
    return {
      kind: 'answered',
      fit: result.fit,
      result: {
        ...result.result,
        latencyMs: Math.round(performance.now() - startedAt),
      },
    }
  }

  /** Consult the optional deployment redactor exactly once. */
  private redactState(state: string): string | Promise<string> {
    const redactor = this.ctx.get('judgmentRedactor')
    return redactor === undefined ? state : redactor.redactState(state)
  }
}

/** POST one bounded JSON request and parse its complete JSON response. */
async function postWireBody(
  endpoint: string,
  path: string,
  request: ShieldWireRequest | ShieldFittedWireRequest,
  maxRequestBytes: number,
  maxResponseBytes: number,
  cancellation: AskCancellation,
): Promise<unknown> {
  throwIfCallerAborted(cancellation.caller)
  const serialized = JSON.stringify(request)
  const requestBytes = new TextEncoder().encode(serialized).byteLength
  if (requestBytes > maxRequestBytes) {
    throw new JudgmentError(
      'INPUT_TOO_LARGE',
      `judgment-shield request exceeds maxRequestBytes ${maxRequestBytes}`,
    )
  }
  let response: Response
  try {
    response = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: serialized,
      signal: cancellation.signal,
      redirect: 'error',
    })
  } catch (error: unknown) {
    throw stepFailure(
      error,
      cancellation,
      'UNAVAILABLE',
      `judgment-shield request to ${endpoint} failed`,
    )
  }
  throwIfCallerAborted(cancellation.caller)
  if (!response.ok) {
    /* v8 ignore next -- native fetch exposes a body stream for HTTP responses; cancellation is cleanup. */
    await response.body?.cancel().catch(() => {
      // The status is authoritative; cancellation only releases a refused body.
    })
    throw new JudgmentError(
      'UNAVAILABLE',
      `judgment-shield gateway returned HTTP ${response.status} from ${endpoint}`,
    )
  }
  const text = await readBoundedBody(response, maxResponseBytes, cancellation)
  try {
    return JSON.parse(text)
  } catch (error: unknown) {
    throw new JudgmentError('INVALID_ANSWER', 'judgment-shield response is not valid JSON', { cause: error })
  }
}

/**
 * Race same-process redaction against caller cancellation without cancelling
 * the redactor's underlying work. Settlement handlers remain attached so an
 * uncooperative redactor cannot later produce an unhandled rejection.
 *
 * @param operation - thunk producing a synchronous or asynchronous redaction result.
 * @param signal - caller cancellation, when supplied.
 * @returns the redaction result or an `ABORTED` judgment failure.
 */
function abortable<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return Promise.resolve().then(() => operation())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new JudgmentError('ABORTED', 'judgment-shield ask was cancelled by the caller'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve().then(() => {
      throwIfCallerAborted(signal)
      return operation()
    }).then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      },
    )
  })
}

/** Convert caller cancellation into the seam's stable error class. */
function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new JudgmentError('ABORTED', 'judgment-shield ask was cancelled by the caller')
  }
}

/**
 * Read one complete response body without retaining more than the configured
 * byte cap. A declared content length is only an early refusal; streamed bytes
 * are counted too because the endpoint can lie about that header.
 *
 * @param response - successful fetch response.
 * @param maxResponseBytes - maximum UTF-8 response size.
 * @param cancellation - caller/deadline classification facts.
 * @returns decoded response text.
 * @throws JudgmentError with `UNAVAILABLE` for a body-read failure or
 *   `INVALID_ANSWER` when the byte cap is exceeded.
 */
async function readBoundedBody(
  response: Response,
  maxResponseBytes: number,
  cancellation: AskCancellation,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    /* v8 ignore next -- native fetch exposes a body stream for successful responses; cancellation is cleanup. */
    await response.body?.cancel().catch(() => {
      // The size failure is authoritative; cancellation only releases the body.
    })
    throw new JudgmentError('INVALID_ANSWER', `judgment-shield response exceeds maxResponseBytes ${maxResponseBytes}`)
  }
  if (response.body === null) {
    try {
      const text = await response.text()
      if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
        throw new JudgmentError('INVALID_ANSWER', `judgment-shield response exceeds maxResponseBytes ${maxResponseBytes}`)
      }
      return text
    } catch (error: unknown) {
      if (error instanceof JudgmentError) throw error
      throw stepFailure(error, cancellation, 'UNAVAILABLE', 'judgment-shield response body could not be read')
    }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxResponseBytes) {
        await reader.cancel()
        throw new JudgmentError('INVALID_ANSWER', `judgment-shield response exceeds maxResponseBytes ${maxResponseBytes}`)
      }
      chunks.push(next.value)
    }
  } catch (error: unknown) {
    if (error instanceof JudgmentError) throw error
    throw stepFailure(error, cancellation, 'UNAVAILABLE', 'judgment-shield response body could not be read')
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new JudgmentError('INVALID_ANSWER', 'judgment-shield response is not valid UTF-8', { cause: error })
  }
}

/** Fuse caller cancellation with the provider deadline. */
function askCancellation(caller: AbortSignal | undefined, timeoutMs: number): AskCancellation {
  const deadline = AbortSignal.timeout(timeoutMs)
  return {
    signal: caller === undefined ? deadline : AbortSignal.any([caller, deadline]),
    deadline,
    caller,
    timeoutMs,
  }
}

/** Classify a failed fetch or body read with caller cancellation precedence. */
function stepFailure(
  failure: unknown,
  cancellation: AskCancellation,
  code: JudgmentErrorCode,
  message: string,
): JudgmentError {
  if (cancellation.caller?.aborted === true) {
    return new JudgmentError('ABORTED', 'judgment-shield ask was cancelled by the caller', { cause: failure })
  }
  if (cancellation.deadline.aborted) {
    return new JudgmentError(
      'UNAVAILABLE',
      `judgment-shield ask did not answer within timeoutMs ${cancellation.timeoutMs}`,
      { cause: failure },
    )
  }
  return new JudgmentError(code, message, { cause: failure })
}

export default ShieldJudgmentEngine
