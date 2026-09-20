/**
 * Service Definition for the typed-judgment capability seam (`ctx.judgment`).
 *
 * A consumer asks typed questions about one state — a choice between named
 * options, a score along an ordered rubric, or a yes/no binary — and reads back
 * calibrated probabilities with a confidence figure. Consumers own every
 * question string, every threshold, and every decision taken from an answer;
 * providers own transport, credential resolution, and wire validation, so a
 * distilled on-box engine is a composition swap behind the same contract.
 *
 * One provider registers per context as `ctx.judgment`. The optional
 * `ctx.judgmentRedactor` egress hook has one home, the provider: every
 * provider consults it exactly once per ask, before the state is serialized,
 * and sends what it returns; a consumer passes its composed state unredacted
 * and does not consult the hook, so a composed redactor runs exactly once per
 * ask regardless of how many consumers exist. Mounting an engine also installs
 * the Definition-owned `judgment` settings section: the deployment's on/off
 * switch, which consumers read live and treat as an absent engine when it is
 * off.
 *
 * @module @shres-code/shres-code-judgment
 */

import { Context, Service } from '@shres-code/cordis'
import { installJudgmentSettings } from './settings.ts'
import type { JudgmentEngine, JudgmentErrorCode, JudgmentInput, JudgmentQuestionId, JudgmentRedactor, JudgmentResult, JudgmentSettings } from './types.ts'

export {
  JUDGMENT_SETTINGS_DEFAULT,
  JUDGMENT_SETTINGS_NAMESPACE,
  JUDGMENT_SETTINGS_SCHEMA,
  judgmentEnabled,
} from './settings.ts'
export type {
  JudgmentAnswer,
  JudgmentBinaryAnswer,
  JudgmentBinaryCriteria,
  JudgmentBinaryQuestion,
  JudgmentChoiceAnswer,
  JudgmentChoiceOption,
  JudgmentChoiceQuestion,
  JudgmentEngine,
  JudgmentErrorCode,
  JudgmentInput,
  JudgmentQuestion,
  JudgmentQuestionId,
  JudgmentRedactor,
  JudgmentResult,
  JudgmentScoreAnswer,
  JudgmentScoreQuestion,
  JudgmentSettings,
  JudgmentTier,
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

declare module '@shres-code/cordis' {
  interface Context {
    judgment: JudgmentService
    judgmentRedactor?: JudgmentRedactor
  }
}

/**
 * Abstract judgment service. Load one implementation per context as
 * `ctx.judgment`; it owns tier selection, credentials, transport, and the
 * validation of every provider response it reads, and registers no session
 * event, prompt, or tool of its own.
 *
 * Mounting an engine installs the Definition-owned
 * {@link JUDGMENT_SETTINGS_NAMESPACE} section, because the toggle exists only
 * where an engine does. {@link settings} reads it live.
 */
export abstract class JudgmentService extends Service implements JudgmentEngine {
  /**
   * Live read of the resolved judgment settings. Consumers call it at the
   * decision the toggle gates and treat `enabled: false` exactly as an absent
   * engine — never as a third behavior mode.
   */
  readonly settings: () => JudgmentSettings

  constructor(ctx: Context) {
    super(ctx, 'judgment')
    this.settings = installJudgmentSettings(this.ctx)
  }

  /**
   * Answer one set of typed questions about one state. Answers come back in
   * the order the questions were asked, each carrying its question's id.
   * @param input - the state, the questions, the optional tier, and the cancellation signal.
   * @returns the answers with the engine and model identity and the ask's duration.
   * @throws {@link JudgmentError} for an unconfigured credential
   *   (`UNCONFIGURED`), an unreachable or refusing provider (`UNAVAILABLE`),
   *   an unusable provider response (`INVALID_ANSWER`), or a cancelled ask
   *   (`ABORTED`).
   */
  abstract ask(input: JudgmentInput): Promise<JudgmentResult>
}

export default JudgmentService
