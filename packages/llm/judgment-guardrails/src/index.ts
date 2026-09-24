/**
 * Guardrails observer over the typed-judgment seam: Stage 0 of the judgment
 * guardrails, an observer and nothing more.
 *
 * Every committed `tool/result` is one checked call. The observer assembles one
 * capped state from the call and the text its result brought into the session,
 * asks one judgment consult with two questions — a binary on whether the input
 * attempts to override instructions or act against the user's interest, and a
 * score on how severe it would be if hostile — and appends one log-only
 * `guard/decision` recording the answers, their confidence, and the state hash.
 *
 * Nothing here blocks, rewrites, or surfaces anything: the check writes one
 * session event and changes no call, no message, and no request, and there is no
 * enforcement path in this package at all. No threshold ships either — the
 * operating points of any acting rung wait on the labeled set this observer
 * produces. The observer ships off, and a composed-but-off deployment's log is
 * byte-identical to one without this package.
 *
 * @module @shres-code/shres-code-judgment-guardrails
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { declareJudgmentConsumer, judgmentConsumerId, judgmentEnabled, judgmentQuestionId } from '@shres-code/shres-code-judgment'
import type {
  JudgmentBinaryAnswer,
  JudgmentBinaryQuestion,
  JudgmentResult,
  JudgmentScoreAnswer,
  JudgmentScoreQuestion,
} from '@shres-code/shres-code-judgment'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { installSettingsSection } from '@shres-code/shres-code-settings'
import {
  DEFAULT_STATE_MAX_ARG_CHARS,
  DEFAULT_STATE_MAX_CHARS,
  DEFAULT_TIER,
  GUARDRAILS_SETTINGS_NAMESPACE,
  resolveConfig,
} from './config.ts'
import type { GuardrailsConfig, ResolvedGuardrailsConfig } from './config.ts'
import { foldGuardState } from './state.ts'
import type { GuardDecision, GuardReason } from './types.ts'

export {
  DEFAULT_STATE_MAX_ARG_CHARS,
  DEFAULT_STATE_MAX_CHARS,
  DEFAULT_TIER,
  GUARDRAILS_SETTINGS_NAMESPACE,
  resolveConfig,
} from './config.ts'
export type {
  GuardInjectionCriteria,
  GuardrailsConfig,
  GuardStateCaps,
  ResolvedGuardrailsConfig,
} from './config.ts'
export { foldGuardState, guardStateHash } from './state.ts'
export type { GuardStateFacts } from './state.ts'
// The `guard/decision` session-event declaration lives in src/types.ts (its one
// home); this re-export keeps the module edge in the emitted declarations so
// aggregate programs receive the merge.
export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'judgment-guardrails'

/** The id the injection question is asked under, echoed by its answer. */
export const INJECTION_QUESTION_ID = judgmentQuestionId('guard-injection')

/** The id the severity question is asked under, echoed by its answer. */
export const SEVERITY_QUESTION_ID = judgmentQuestionId('guard-severity')

/**
 * The consumer id every guard ask carries, declared in `ctx.judgmentEngines`
 * while the plugin is mounted; a `judgment.overrides` entry under this key
 * routes the asks to another engine.
 */
export const GUARDRAILS_JUDGMENT_CONSUMER = judgmentConsumerId('judgment-guardrails')

/**
 * Composition config schema, which is also the `judgment-guardrails` settings
 * section schema. Unknown keys and wrong types fail plugin load by name, and
 * `resolveConfig` re-judges every bound and the required question texts.
 */
export const Config: z<GuardrailsConfig> = z.object({
  enabled: z.boolean().default(false),
  injectionInstructions: z.string().required(),
  injectionCriteria: z.object({
    yes: z.string().required(),
    no: z.string().required(),
  }),
  severityInstructions: z.string().required(),
  severityLevels: z.array(z.string()).required(),
  state: z.object({
    maxChars: z.number().step(1).min(1).default(DEFAULT_STATE_MAX_CHARS),
    maxArgChars: z.number().step(1).min(1).default(DEFAULT_STATE_MAX_ARG_CHARS),
  }),
  tier: z.union(['fast', 'accurate']).default(DEFAULT_TIER),
})

/** The binary question one check asks about one call's input. */
function injectionQuestion(config: ResolvedGuardrailsConfig): JudgmentBinaryQuestion {
  return {
    kind: 'binary',
    id: INJECTION_QUESTION_ID,
    instructions: config.injectionInstructions,
    criteria: { yes: config.injectionCriteria.yes, no: config.injectionCriteria.no },
  }
}

/** The score question one check asks about the same state. */
function severityQuestion(config: ResolvedGuardrailsConfig): JudgmentScoreQuestion {
  return {
    kind: 'score',
    id: SEVERITY_QUESTION_ID,
    instructions: config.severityInstructions,
    levels: [...config.severityLevels],
  }
}

/**
 * Install the observer: the settings namespace, the committed-result watch, and
 * the lifetime that ends an outstanding ask.
 *
 * Every registration here is an effect, so Cordis disposes it with the fiber that
 * mounted this plugin; a `ctx.plugin()` mount never receives this return value
 * and never needs it. The disposer is for a caller that invoked `apply` directly
 * and must remove the registrations itself.
 *
 * A check runs from a microtask scheduled by the committed result that triggered
 * it, never inside that event's publication window: `Session.append` refuses to
 * reenter while another append is being published. One check runs per session at
 * a time — the schedule entry is held until the ask it may await has settled, so
 * a second committed result cannot start an overlapping check on the same log.
 *
 * @param ctx - plugin context; every registration is scoped to it.
 * @param config - composition config, re-judged fail-loud here.
 * @returns a disposer that removes every registration this call made, for a
 *   caller that invoked `apply` directly.
 */
export function apply(ctx: Context, config: GuardrailsConfig): () => void {
  declareJudgmentConsumer(ctx, GUARDRAILS_JUDGMENT_CONSUMER)
  let source: () => GuardrailsConfig = () => config
  let raw: GuardrailsConfig = config
  let resolved: ResolvedGuardrailsConfig = resolveConfig(config)

  /** The resolved configuration in force, re-resolved when the settings layer replaces it. */
  const configuration = (): ResolvedGuardrailsConfig => {
    const next = source()
    if (next !== raw) {
      raw = next
      resolved = resolveConfig(next)
    }
    return resolved
  }

  installSettingsSection(ctx, GUARDRAILS_SETTINGS_NAMESPACE, Config, config, {
    validate: (next) => {
      resolveConfig(next)
    },
    setSource: (next) => {
      source = next
    },
    onChange: () => {
      // Nothing is derived at registration: every check re-resolves the
      // configuration it reads, so a committed change reaches the next one.
    },
  })

  const lifetime = new AbortController()
  // One check per session at a time: a result committed while another check is in
  // flight is queued behind it rather than dropped, because every committed call
  // is one check and a skipped call would be a silent hole in the record.
  const queued = new WeakMap<Session, SessionEvent<'tool/result'>[]>()
  const checking = new WeakSet<Session>()

  /**
   * Ask the judgment engine about one committed call and build the decision to
   * log. The state goes to `ctx.judgment.ask()` unredacted: consulting
   * `ctx.judgmentRedactor` is the provider's obligation, so this observer never
   * reads the hook.
   *
   * Every failure resolves to the degraded class that caused it: no engine
   * composed, a disabled engine, an engine that threw, and an answer this check
   * cannot read. The check executes nothing — its only product is the decision —
   * and it carries no threshold, so an answer is recorded whatever it says.
   * @param session - the session whose call is being checked.
   * @param result - the committed result that triggered the check.
   * @param current - resolved observer configuration.
   * @returns the decision to append.
   */
  const check = async (
    session: Session,
    result: SessionEvent<'tool/result'>,
    current: ResolvedGuardrailsConfig,
  ): Promise<GuardDecision> => {
    const facts = foldGuardState(session, result, current.state)
    /** One degradation: the evidence the state was built from, plus the class that stopped the ask. */
    const degraded = (reason: GuardReason): GuardDecision => ({
      outcome: 'degraded',
      reason,
      stateHash: facts.hash,
      stateSeqs: facts.seqs,
    })
    const engine = ctx.get('judgment')
    if (engine === undefined) return degraded('engine-absent')
    if (!judgmentEnabled(engine.settings)) return degraded('engine-disabled')
    let answered: JudgmentResult
    try {
      answered = await engine.ask({
        state: facts.text,
        questions: [injectionQuestion(current), severityQuestion(current)],
        tier: current.tier,
        signal: lifetime.signal,
        consumer: GUARDRAILS_JUDGMENT_CONSUMER,
      })
    } catch (error: unknown) {
      // A provider that refused an unusable response classified it itself; every
      // other failure is a transport class the seam reports as UNAVAILABLE.
      const code = (error as { code?: unknown } | null)?.code
      return degraded(code === 'INVALID_ANSWER' ? 'invalid-answer' : 'engine-unavailable')
    }
    const injection = answered.answers.find(
      (answer): answer is JudgmentBinaryAnswer => answer.kind === 'binary' && answer.id === INJECTION_QUESTION_ID,
    )
    const severity = answered.answers.find(
      (answer): answer is JudgmentScoreAnswer => answer.kind === 'score' && answer.id === SEVERITY_QUESTION_ID,
    )
    if (injection === undefined || severity === undefined) return degraded('invalid-answer')
    return {
      outcome: 'observed',
      reason: 'answered',
      stateHash: facts.hash,
      stateSeqs: facts.seqs,
      injection: { probability: injection.probability },
      severity: { score: severity.score, confidence: severity.confidence },
      engine: answered.engine,
      model: answered.model,
      latencyMs: answered.latencyMs,
    }
  }

  /**
   * Resolve one committed result into a logged decision. The check runs before
   * the append, so the decision records what the engine answered; the append
   * reads the log's own newest seq at that point, which is the decision's own seq
   * minus one.
   */
  const evaluate = async (session: Session, result: SessionEvent<'tool/result'>): Promise<void> => {
    const current = configuration()
    if (!current.enabled) return
    const decision = await check(session, result, current)
    session.append('guard/decision', decision, { ignorable: true })
  }

  /**
   * Run the queued checks of one session in order, one at a time. The queue is
   * drained to empty, so a result committed while an earlier check is awaiting an
   * engine is checked when that ask settles rather than skipped.
   */
  const drain = async (session: Session): Promise<void> => {
    for (;;) {
      const queue = queued.get(session)
      const next = queue?.shift()
      if (next === undefined) return
      if (queue?.length === 0) queued.delete(session)
      await evaluate(session, next)
    }
  }

  const watch = ctx.effect(() => ctx.on('session/event', (session: Session, event) => {
    if (event.type !== 'tool/result') return
    const queue = queued.get(session)
    if (queue === undefined) queued.set(session, [event])
    else queue.push(event)
    if (checking.has(session)) return
    checking.add(session)
    queueMicrotask(() => {
      void drain(session).finally(() => {
        checking.delete(session)
      })
    })
  }, { global: true }), 'judgment-guardrails: committed-result watch')

  const teardown = ctx.effect(() => () => {
    lifetime.abort(new Error('judgment-guardrails disposed'))
  }, 'judgment-guardrails: lifetime')

  return () => {
    void watch()
    void teardown()
  }
}
