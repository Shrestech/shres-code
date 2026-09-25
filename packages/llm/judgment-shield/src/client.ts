/**
 * The one client for the Shield judgment wire: `/v1/judgments` and
 * `/v1/judgments/fitted` on an explicitly configured loopback gateway.
 *
 * Every provider that speaks this wire uses this implementation, so request
 * serialization, the request byte cap, redaction ordering, deadline and caller
 * cancellation classification, the bounded response read, and strict answer
 * validation have one home. The client owns no configuration resolution and no
 * process lifecycle: callers pass an already resolved configuration and own
 * whatever runs the gateway.
 *
 * @module @shres-code/shres-code-judgment-shield/client
 */

import { abortableJudgmentStep, JudgmentError, throwIfJudgmentAborted } from '@shres-code/shres-code-judgment'
import type {
  JudgmentEngine,
  JudgmentErrorCode,
  JudgmentFittingEngine,
  JudgmentFittingInput,
  JudgmentFittingResult,
  JudgmentInput,
  JudgmentResult,
} from '@shres-code/shres-code-judgment'
import { resolveTierModel } from './config.ts'
import type { ResolvedShieldJudgmentConfig } from './config.ts'
import {
  readFittedWireResponse,
  readWireResponse,
  toFittedWireRequest,
  toWireRequest,
} from './wire.ts'
import type { ShieldFittedWireRequest, ShieldWireRequest } from './wire.ts'

/** Gateway path for one typed judgment ask. */
const JUDGMENT_PATH = '/v1/judgments'

/** Gateway path for one atomic fit-and-ask. */
const FITTED_JUDGMENT_PATH = '/v1/judgments/fitted'

/**
 * Resolved wire facts (every resolved field but the provider's readiness
 * interval) plus the caller-owned redaction hook and diagnostic label.
 */
export interface ShieldWireEngineOptions extends Omit<ResolvedShieldJudgmentConfig, 'readinessIntervalMs'> {
  /**
   * Replace one state before it is serialized. The client calls it exactly once
   * per state (once per candidate for a fitted ask) before arming the deadline.
   */
  readonly redact: (state: string) => string | Promise<string>
  /** Package name that prefixes transport and cancellation diagnostics. */
  readonly label: string
}

/** A judgment engine speaking the Shield wire, with atomic tokenizer fitting. */
export interface ShieldWireEngine extends JudgmentEngine {
  /** Atomic fit-and-ask over `/v1/judgments/fitted`. */
  readonly fitting: JudgmentFittingEngine
}

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
 * Create a Shield wire client for one resolved gateway configuration.
 *
 * A plain ask redacts its state once, then arms the deadline, which covers
 * fetch and the complete response body. Caller cancellation is classified
 * separately from the deadline. The gateway must report the exact requested
 * artifact and a complete validated probability distribution. A fitted ask
 * redacts every candidate once and restores the selected redacted state.
 *
 * @param options - resolved endpoint, tier models, deadline, byte caps, redaction hook, and label.
 * @returns an engine whose `ask` and `fitting.ask` throw `JudgmentError` with
 *   `UNAVAILABLE` for transport, HTTP, timeout, or body-read failures,
 *   `INPUT_TOO_LARGE` for a request over the byte cap, `INVALID_ANSWER` for
 *   malformed JSON or answers, and `ABORTED` when the caller cancels.
 */
export function createShieldWireEngine(options: ShieldWireEngineOptions): ShieldWireEngine {
  const { label } = options

  /** Diagnostic of every caller cancellation this client reports. */
  const cancelled = `${label} ask was cancelled by the caller`

  /** Convert caller cancellation into the seam's stable error class. */
  const throwIfCallerAborted = (signal: AbortSignal | undefined): void => {
    throwIfJudgmentAborted(signal, cancelled)
  }

  /** Race same-process redaction against caller cancellation; see {@link abortableJudgmentStep}. */
  const abortable = <T>(operation: () => T | PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> =>
    abortableJudgmentStep(operation, signal, cancelled)

  /** Classify a failed fetch or body read with caller cancellation precedence. */
  const stepFailure = (
    failure: unknown,
    cancellation: AskCancellation,
    code: JudgmentErrorCode,
    message: string,
  ): JudgmentError => {
    if (cancellation.caller?.aborted === true) {
      return new JudgmentError('ABORTED', cancelled, { cause: failure })
    }
    if (cancellation.deadline.aborted) {
      return new JudgmentError(
        'UNAVAILABLE',
        `${label} ask did not answer within timeoutMs ${cancellation.timeoutMs}`,
        { cause: failure },
      )
    }
    return new JudgmentError(code, message, { cause: failure })
  }

  /**
   * Read one complete response body without retaining more than the configured
   * byte cap. A declared content length is only an early refusal; streamed bytes
   * are counted too because the endpoint can lie about that header.
   */
  const readBoundedBody = async (response: Response, cancellation: AskCancellation): Promise<string> => {
    const { maxResponseBytes } = options
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      /* v8 ignore next -- native fetch exposes a body stream for successful responses; cancellation is cleanup. */
      await response.body?.cancel().catch(() => {
        // The size failure is authoritative; cancellation only releases the body.
      })
      throw new JudgmentError('INVALID_ANSWER', `${label} response exceeds maxResponseBytes ${maxResponseBytes}`)
    }
    if (response.body === null) {
      try {
        const text = await response.text()
        if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
          throw new JudgmentError('INVALID_ANSWER', `${label} response exceeds maxResponseBytes ${maxResponseBytes}`)
        }
        return text
      } catch (error: unknown) {
        if (error instanceof JudgmentError) throw error
        throw stepFailure(error, cancellation, 'UNAVAILABLE', `${label} response body could not be read`)
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
          throw new JudgmentError('INVALID_ANSWER', `${label} response exceeds maxResponseBytes ${maxResponseBytes}`)
        }
        chunks.push(next.value)
      }
    } catch (error: unknown) {
      if (error instanceof JudgmentError) throw error
      throw stepFailure(error, cancellation, 'UNAVAILABLE', `${label} response body could not be read`)
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
      throw new JudgmentError('INVALID_ANSWER', `${label} response is not valid UTF-8`, { cause: error })
    }
  }

  /** POST one bounded JSON request and parse its complete JSON response. */
  const postWireBody = async (
    path: string,
    request: ShieldWireRequest | ShieldFittedWireRequest,
    cancellation: AskCancellation,
  ): Promise<unknown> => {
    const { endpoint, maxRequestBytes } = options
    throwIfCallerAborted(cancellation.caller)
    const serialized = JSON.stringify(request)
    const requestBytes = new TextEncoder().encode(serialized).byteLength
    if (requestBytes > maxRequestBytes) {
      throw new JudgmentError(
        'INPUT_TOO_LARGE',
        `${label} request exceeds maxRequestBytes ${maxRequestBytes}`,
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
        `${label} request to ${endpoint} failed`,
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
        `${label} gateway returned HTTP ${response.status} from ${endpoint}`,
      )
    }
    const text = await readBoundedBody(response, cancellation)
    try {
      return JSON.parse(text)
    } catch (error: unknown) {
      throw new JudgmentError('INVALID_ANSWER', `${label} response is not valid JSON`, { cause: error })
    }
  }

  const ask = async (input: JudgmentInput): Promise<JudgmentResult> => {
    throwIfCallerAborted(input.signal)
    const startedAt = performance.now()
    const state = await abortable(() => options.redact(input.state), input.signal)
    const model = resolveTierModel(options.models, input.tier)
    const cancellation = askCancellation(input.signal, options.timeoutMs)
    const request = toWireRequest(state, model, input.questions)
    const body = await postWireBody(JUDGMENT_PATH, request, cancellation)
    throwIfCallerAborted(input.signal)
    const result = readWireResponse(body, input.questions, model)
    throwIfCallerAborted(input.signal)
    return { ...result, latencyMs: Math.round(performance.now() - startedAt) }
  }

  const askFitted = async (input: JudgmentFittingInput): Promise<JudgmentFittingResult> => {
    const startedAt = performance.now()
    throwIfCallerAborted(input.signal)
    const model = resolveTierModel(options.models, input.tier)
    const states: string[] = []
    try {
      for (const state of input.states) {
        throwIfCallerAborted(input.signal)
        states.push(await abortable(() => options.redact(state), input.signal))
        throwIfCallerAborted(input.signal)
      }
    } catch (error: unknown) {
      if (input.signal?.aborted === true) {
        throw new JudgmentError('ABORTED', cancelled, { cause: error })
      }
      throw error
    }
    const cancellation = askCancellation(input.signal, options.timeoutMs)
    const request = toFittedWireRequest(states, model, input.questions)
    const body = await postWireBody(FITTED_JUDGMENT_PATH, request, cancellation)
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

  return { ask, fitting: { ask: askFitted } }
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
