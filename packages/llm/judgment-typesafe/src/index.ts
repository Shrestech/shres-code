/**
 * TypeSafe AI "System One" judgment provider for `ctx.judgment`.
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
 * `AbortSignal` fails with `ABORTED`.
 *
 * There is no retry, no backoff, and no streaming: the documented 401, 422,
 * 429, and 529 responses all arrive as `UNAVAILABLE`, and the caller owns any
 * retry.
 *
 * @module @shres-code/shres-code-judgment-typesafe
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import { JudgmentError, JudgmentService } from '@shres-code/shres-code-judgment'
import type {
  JudgmentErrorCode,
  JudgmentInput,
  JudgmentResult,
} from '@shres-code/shres-code-judgment'
import { DEFAULT_ENDPOINT, DEFAULT_MODELS, DEFAULT_TIMEOUT_MS, resolveConfig, resolveTierModel } from './config.ts'
import type { ResolvedTypesafeJudgmentConfig } from './config.ts'
import { readWireResponse, toWireRequest } from './wire.ts'
import type { WireRequest } from './wire.ts'
import type { TypesafeJudgmentConfig } from './types.ts'

export {
  DEFAULT_ENDPOINT,
  DEFAULT_MODELS,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
  resolveTierModel,
} from './config.ts'
export type { ResolvedTypesafeJudgmentConfig } from './config.ts'
export { readWireResponse, toWireRequest } from './wire.ts'
export type { ReadWireResponse, WireNoulCriteria, WireQuestion, WireRequest } from './wire.ts'
export type { TypesafeJudgmentConfig, TypesafeJudgmentModels } from './types.ts'

/** Value the seam reports as the engine that produced an answer. */
const ENGINE = 'typesafe'

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
 * TypeSafe AI judgment engine: one HTTP request per ask, one validated answer
 * per question, no session event and no prompt text of its own.
 *
 * Registered by {@link JudgmentService} as `ctx.judgment`. Nothing is cached
 * across asks — the credential reference is re-resolved and the deadline is
 * restarted on every call — so a rotated key reaches the next ask without a
 * restart.
 */
export class TypesafeJudgmentEngine extends JudgmentService {
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
  })

  /** Resolved and validated ask facts. */
  readonly config: ResolvedTypesafeJudgmentConfig

  /**
   * @param ctx - the context the engine registers `ctx.judgment` on.
   * @param config - composition config; a row that names none fails load on
   *   the missing `apiKeyRef`.
   */
  constructor(ctx: Context, config: TypesafeJudgmentConfig = NO_CONFIG) {
    super(ctx)
    this.config = resolveConfig(config)
  }

  /**
   * Answer one set of typed questions about one state.
   * @param input - the state, the questions, the optional tier, and the cancellation signal.
   * @returns the answers in ask order with `engine: 'typesafe'`, the model id the
   *   response reported, and the ask's duration in whole milliseconds.
   * @throws JudgmentError code `UNCONFIGURED` when the credentials seam is absent
   *   or the reference resolves to nothing, code `UNAVAILABLE` when the request
   *   fails, is refused, or outlives `timeoutMs`, code `INVALID_ANSWER` when the
   *   response cannot answer the questions asked, or code `ABORTED` when the
   *   caller cancelled the ask.
   */
  override async ask(input: JudgmentInput): Promise<JudgmentResult> {
    const startedAt = performance.now()
    const config = this.config
    const apiKey = await this.resolveApiKey()
    const state = await this.redactState(input.state)
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
   * Send one ask and return its response. A non-2xx status fails here, so no
   * caller ever reads an error body as an answer.
   * @param request - the mapped request body.
   * @param apiKey - the bearer token resolved for this ask.
   * @param cancellation - the ask's signals and deadline.
   * @returns the accepted response.
   * @throws JudgmentError classified by {@link stepFailure}.
   */
  private async post(request: WireRequest, apiKey: string, cancellation: AskCancellation): Promise<Response> {
    const endpoint = this.config.endpoint
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
    if (!response.ok) throw await httpFailure(response, endpoint, cancellation)
    return response
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
    return new JudgmentError('ABORTED', 'TypeSafe judgment ask was cancelled by the caller', { cause: failure })
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
