/**
 * Service Definition for the typed-judgment capability seam (`ctx.judgment`).
 *
 * A consumer asks typed questions about one state — a choice between named
 * options, a score along an ordered rubric, or a yes/no binary — and reads back
 * probabilities with a confidence figure. Consumers own every
 * question string, every threshold, and every decision taken from an answer;
 * providers own transport, credential resolution, and wire validation, so a
 * distilled on-box engine is a composition swap behind the same contract.
 *
 * One service registers per context as `ctx.judgment`. In a deployment that
 * is `judgment-dispatch`, which provides the {@link JudgmentEngineRegistry} as
 * `ctx.judgmentEngines`: each engine provider registers one engine there, and
 * the dispatcher routes every ask to the engine the `judgment` settings select,
 * never to another one. The optional `ctx.judgmentRedactor` egress hook has
 * one home, the engine: every engine consults it exactly once per state
 * candidate, before serialization, and sends what it returns; a consumer passes
 * its composed state unredacted and does not consult the hook. A regular ask
 * has one candidate, while an atomic fitting ask applies the same hook once to
 * each offered candidate. The service mounted as `ctx.judgment` also installs
 * the Definition-owned `judgment` settings section: the deployment's on/off
 * switch, which consumers read live and treat as an absent engine when it is
 * off, and the engine selection.
 *
 * @module @shres-code/shres-code-judgment
 */

import { Context, Service } from '@shres-code/cordis'
import type { JudgmentEngineRegistry } from './registry.ts'
import { installJudgmentSettings } from './settings.ts'
import type { JudgmentSettingsInstall } from './settings.ts'
import type {
  JudgmentConsumerId, JudgmentEngine, JudgmentEngineEntry, JudgmentEngineId, JudgmentEngineRegistration,
  JudgmentErrorCode, JudgmentFittingEngine, JudgmentInput, JudgmentQuestionId, JudgmentRedactor,
  JudgmentResult, JudgmentSettings,
} from './types.ts'

export { JudgmentEngineRegistry } from './registry.ts'
export {
  assertJudgmentSettingsShape,
  JUDGMENT_SETTINGS_DEFAULT,
  JUDGMENT_SETTINGS_NAMESPACE,
  JUDGMENT_SETTINGS_SCHEMA,
  judgmentEnabled,
} from './settings.ts'
export type { JudgmentSettingsInstall } from './settings.ts'
export type {
  JudgmentAnswer,
  JudgmentBinaryAnswer,
  JudgmentBinaryCriteria,
  JudgmentBinaryQuestion,
  JudgmentChoiceAnswer,
  JudgmentChoiceOption,
  JudgmentChoiceQuestion,
  JudgmentConsumerId,
  JudgmentEngine,
  JudgmentEngineCalibration,
  JudgmentEngineDescriptor,
  JudgmentEngineEgress,
  JudgmentEngineEntry,
  JudgmentEngineHost,
  JudgmentEngineId,
  JudgmentEngineRegistration,
  JudgmentEngineState,
  JudgmentEngineStatus,
  JudgmentErrorCode,
  JudgmentFittingEngine,
  JudgmentFittingInput,
  JudgmentFittingResult,
  JudgmentInput,
  JudgmentQuestion,
  JudgmentQuestionId,
  JudgmentRedactor,
  JudgmentResult,
  JudgmentScoreAnswer,
  JudgmentScoreQuestion,
  JudgmentSettings,
  JudgmentTier,
  JudgmentTokenFit,
  JudgmentTokenLimitReason,
  JudgmentTokenLimits,
} from './types.ts'

/**
 * Brand a raw string as a {@link JudgmentQuestionId}.
 * @param value - candidate id; non-empty, and unique among the questions of one ask.
 * @returns the branded id.
 */
export function judgmentQuestionId(value: string): JudgmentQuestionId {
  if (value.length === 0) throw new TypeError('judgment question id must be non-empty')
  return value as JudgmentQuestionId
}

/**
 * Brand a raw string as a {@link JudgmentEngineId}.
 * @param value - candidate registry id; non-empty.
 * @returns the branded id.
 */
export function judgmentEngineId(value: string): JudgmentEngineId {
  if (value.length === 0) throw new TypeError('judgment engine id must be non-empty')
  return value as JudgmentEngineId
}

/**
 * Register one engine with `ctx.judgmentEngines` for the lifetime of the fiber
 * that owns `ctx`. A provider calls it from its constructor once its engine is
 * fully constructed, and lists `judgmentEngines` in its `inject` so the
 * registry exists before the call. The registration is released when that
 * fiber unloads, and made again if the effect is restarted.
 * @param ctx - the provider's context.
 * @param entry - the engine, its descriptor (whose `id` is the registry id), and its status read.
 * @returns the status-change announcement: call it whenever `entry.status()`
 *   changes; it does nothing while the engine is not registered.
 * @throws Error when the registry rejects the entry; see {@link JudgmentEngineRegistry.register}.
 */
export function registerJudgmentEngine(ctx: Context, entry: JudgmentEngineEntry): () => void {
  let registration: JudgmentEngineRegistration | undefined
  ctx.effect(() => {
    const current = ctx.judgmentEngines.register(entry.descriptor.id, entry)
    registration = current
    return () => {
      current()
      registration = undefined
    }
  }, `judgment engine ${entry.descriptor.id}`)
  return () => registration?.statusChanged()
}

/**
 * Declare, for the lifetime of the fiber that owns `ctx`, that this consumer
 * names itself with `id` on every judgment ask, so a `judgment.overrides`
 * entry for it takes effect. The declaration is made whenever
 * `ctx.judgmentEngines` is available and released with the consumer's fiber or
 * the registry's; a composition without the registry makes none, because it
 * has no dispatcher to route by consumer.
 * @param ctx - the consumer's context.
 * @param id - the consumer id the consumer's asks carry.
 */
export function declareJudgmentConsumer(ctx: Context, id: JudgmentConsumerId): void {
  ctx.inject(['judgmentEngines'], (registryCtx) => {
    registryCtx.effect(() => registryCtx.judgmentEngines.declareConsumer(id), `judgment consumer ${id}`)
  })
}

/**
 * Brand a raw string as a {@link JudgmentConsumerId}.
 * @param value - candidate consumer id; non-empty.
 * @returns the branded id.
 */
export function judgmentConsumerId(value: string): JudgmentConsumerId {
  if (value.length === 0) throw new TypeError('judgment consumer id must be non-empty')
  return value as JudgmentConsumerId
}

/**
 * Classified failure of one judgment ask. Consumers branch on {@link code}
 * instead of matching provider text; a provider sets `cause` to whatever it
 * caught, so the underlying transport failure stays available for a log.
 */
export class JudgmentError extends Error {
  override readonly name = 'JudgmentError'

  /**
   * Create one classified judgment failure.
   * @param code - stable failure class.
   * @param message - diagnostic naming the engine and what could not be done.
   * @param options - optional original failure.
   */
  constructor(
    readonly code: JudgmentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * Fail an ask whose caller has already cancelled it. Engines honour
 * `input.signal` at every await; this is the check before each step.
 * @param signal - the ask's signal; absence means the ask cannot be cancelled.
 * @param message - the diagnostic naming the engine.
 * @throws JudgmentError code `ABORTED` when the signal has aborted.
 */
export function throwIfJudgmentAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted === true) throw new JudgmentError('ABORTED', message)
}

/**
 * Run one step of an ask so that it settles as soon as the caller cancels,
 * which is how an engine honours `input.signal` while it awaits same-process
 * work that cannot itself be cancelled, such as a credential lookup or the
 * deployment's redaction hook. The step does not start when the signal has
 * already aborted. A step running when the signal aborts keeps running, but the
 * returned promise rejects at once, and the step's later settlement stays
 * handled so it cannot surface as an unhandled rejection.
 * @param operation - the step; its return value or promise is awaited.
 * @param signal - the ask's signal; absence runs the step unchanged.
 * @param message - the diagnostic naming the engine, used for `ABORTED`.
 * @returns the step's result.
 * @throws JudgmentError code `ABORTED` when the signal aborts before the step
 *   settles, and whatever the step itself throws otherwise.
 */
export function abortableJudgmentStep<T>(
  operation: () => T | PromiseLike<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (signal === undefined) return Promise.resolve().then(() => operation())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new JudgmentError('ABORTED', message))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve().then(() => {
      throwIfJudgmentAborted(signal, message)
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

declare module '@shres-code/cordis' {
  interface Context {
    judgment: JudgmentService
    judgmentEngines: JudgmentEngineRegistry
    judgmentRedactor?: JudgmentRedactor
  }
}

/**
 * Abstract judgment service. Load one implementation per context as
 * `ctx.judgment`. A deployment loads `judgment-dispatch`, which routes each
 * ask to a registered engine; a test can load a single-engine implementation
 * directly. The service registers no session event, prompt, or tool of its own.
 *
 * The service installs the Definition-owned {@link JUDGMENT_SETTINGS_NAMESPACE}
 * section, because the toggle and the engine selection exist only where
 * `ctx.judgment` does. {@link settings} reads it live.
 */
export abstract class JudgmentService extends Service implements JudgmentEngine {
  /**
   * Atomic tokenizer fitting and judgment, when supported. Declared without an
   * emitted field so a subclass can supply it as an assignment or as an
   * accessor defined on the instance.
   */
  declare readonly fitting?: JudgmentFittingEngine
  /**
   * Live read of the resolved judgment settings. Consumers call it at the
   * decision the toggle gates and treat `enabled: false` exactly as an absent
   * engine — never as a third behavior mode.
   */
  readonly settings: () => JudgmentSettings

  /**
   * @param ctx - the context receiving `ctx.judgment`.
   * @param settings - the section's composition layer and selection check;
   *   omission installs the single-engine default.
   */
  constructor(ctx: Context, settings: JudgmentSettingsInstall = {}) {
    super(ctx, 'judgment')
    this.settings = installJudgmentSettings(this.ctx, settings)
  }

  /**
   * Answer one set of typed questions about one state. Answers come back in
   * the order the questions were asked, each carrying its question's id.
   * @param input - the state, the questions, the optional tier, and the cancellation signal.
   * @returns the answers with the engine and model identity and the ask's duration.
   * @throws {@link JudgmentError} for an unconfigured credential
   *   (`UNCONFIGURED`), an unreachable or refusing provider (`UNAVAILABLE`),
   *   oversized serialized input (`INPUT_TOO_LARGE`),
   *   an unusable provider response (`INVALID_ANSWER`), or a cancelled ask
   *   (`ABORTED`).
   */
  abstract ask(input: JudgmentInput): Promise<JudgmentResult>
}

export default JudgmentService
