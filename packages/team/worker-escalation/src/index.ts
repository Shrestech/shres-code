/**
 * Worker difficulty ladder: Stage 0 deterministic, Stage 1 an observer.
 *
 * A delegated worker session has no structured response to mid-turn
 * difficulty — it cannot ask the human, the step budget bounds only one turn,
 * and the jspace advisor engages root sessions only. This package folds the
 * worker's own log for five stuck signals, logs one log-only
 * `escalation/decision` per firing trigger, and after `maxContinues`
 * continue resolutions on a goal epoch reports the worker blocked to the Lead
 * through the Team mailbox the worker already owns.
 *
 * Stage 1 consults an optional judgment engine through the structural
 * `ctx.get('judgment')` read — no declared injection, so the ladder composes
 * with or without an engine. One two-option choice ask is made per continue
 * resolution — the deterministic terminal consults nothing — gated on the
 * answer's confidence and its top-two probability margin, and the decision logs
 * the engine class and the gate outcome. Nothing
 * executes on that answer: a `needs-help` choice is a record, and the
 * report-blocked terminal stays the ladder's one action.
 *
 * The ask-to-escalate is anchored on the Stage 0 triggers alone: while
 * `askToEscalate` is on, every non-terminal decision also asks the human, through
 * the structural `ctx.get('userQuestions')` read, whether to escalate this worker
 * to the Lead now or let it keep working, and logs the chosen option on the
 * decision. Nothing executes on that answer either, and no judgment threshold
 * gates it. The ask rides a session the human can answer in: a worker session
 * that is a runtime root is asked directly, and one owned by another live agent
 * is asked through the Team root that supervises it, which is where the human
 * already reads that team.
 *
 * The ladder ships off and appears in no default bundle row: `enabled: false`
 * writes no session event, sends no mail, and makes no ask, so a
 * composed-but-off deployment is byte-identical to one without this package.
 *
 * @module @shres-code/shres-code-worker-escalation
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { judgmentEnabled, judgmentQuestionId } from '@shres-code/shres-code-judgment'
import type {
  JudgmentChoiceAnswer,
  JudgmentChoiceQuestion,
  JudgmentResult,
} from '@shres-code/shres-code-judgment'
import type { Session } from '@shres-code/shres-code-session'
import { installSettingsSection } from '@shres-code/shres-code-settings'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@shres-code/shres-code-user-questions'
import type { Agent, AgentRegistry } from '@shres-code/shres-code-agent'
// Type-only edges: resolve `ctx.jspace` and `ctx.agentTeams`.
import type {} from '@shres-code/shres-code-agent-team'
import type {} from '@shres-code/shres-code-jspace'
import {
  DEFAULT_JUDGMENT_CONFIDENCE,
  DEFAULT_JUDGMENT_MARGIN,
  DEFAULT_JUDGMENT_TIER,
  DEFAULT_MAX_ARG_CHARS,
  DEFAULT_MAX_CONTINUES,
  DEFAULT_MAX_DIGEST_CHARS,
  DEFAULT_MAX_DIGEST_TOOLS,
  DEFAULT_MAX_EXCERPT_CHARS,
  DEFAULT_MAX_ARBITER_DEPTH,
  DEFAULT_MIN_STEPS_BETWEEN,
  DEFAULT_TRIGGER_THRESHOLDS,
  WORKER_ESCALATION_SETTINGS_NAMESPACE,
  resolveConfig,
} from './config.ts'
import type { ResolvedWorkerEscalationConfig, WorkerEscalationConfig } from './config.ts'
import { foldWorkerDigest, renderWorkerDigest } from './digest.ts'
import { foldEscalationAging, foldEscalationCooldown, foldEscalationTriggers, probeInFlight } from './fold.ts'
import type { EscalationAgingState } from './fold.ts'
import { composeProgressState } from './progress.ts'
import type {
  EscalationAskOption,
  EscalationAskOutcome,
  EscalationChoice,
  EscalationConsultReason,
  EscalationEngineClass,
  EscalationTrigger,
  EscalationTriggerOutcome,
  WorkerEscalationDigest,
} from './types.ts'

// The `escalation/decision` session-event declaration lives in src/types.ts
// (its one home); this re-export keeps the module edge in the emitted
// declarations so aggregate programs receive the merge.
export type * from './types.ts'
export {
  DEFAULT_JUDGMENT_CONFIDENCE,
  DEFAULT_JUDGMENT_MARGIN,
  DEFAULT_JUDGMENT_TIER,
  DEFAULT_MAX_ARG_CHARS,
  DEFAULT_MAX_ARBITER_DEPTH,
  DEFAULT_MAX_CONTINUES,
  DEFAULT_MAX_DIGEST_CHARS,
  DEFAULT_MAX_DIGEST_TOOLS,
  DEFAULT_MAX_EXCERPT_CHARS,
  DEFAULT_MIN_STEPS_BETWEEN,
  DEFAULT_TRIGGER_THRESHOLDS,
  ESCALATION_TRIGGERS,
  WORKER_ESCALATION_SETTINGS_NAMESPACE,
  resolveConfig,
} from './config.ts'
export { foldEscalationAging, foldEscalationCooldown, foldEscalationTriggers, foldProgressFacts, triggerSatisfiedAt } from './fold.ts'
export { canonicalizeArguments, callChainKey, foldToolWindow, isSandboxDenial } from './fold.ts'
export type { EscalationAgingState, EscalationCooldownState, WorkerToolWindowEntry } from './fold.ts'
export { foldTeamMessages, foldWorkerDigest, foldWorkerCharter, renderWorkerDigest } from './digest.ts'
export type { WorkerAssignmentFold, WorkerDigestCaps } from './digest.ts'
export { composeProgressState } from './progress.ts'

/** Cordis plugin name. */
export const name = 'worker-escalation'

/**
 * Composition config schema, which is also the `worker-escalation` settings
 * section schema. Unknown keys and wrong types fail plugin load by name, and
 * `resolveConfig` re-judges every bound and the cross-field requirements;
 * `progressInstructions` is required because the judgment engine owns no
 * prose of its own.
 */
export const Config: z<WorkerEscalationConfig> = z.object({
  enabled: z.boolean().default(false),
  triggers: z.object({
    errorBurst: z.object({
      enabled: z.boolean().default(true),
      burst: z.number().step(1).min(1).default(DEFAULT_TRIGGER_THRESHOLDS.errorBurst),
    }),
    attemptCount: z.object({
      enabled: z.boolean().default(true),
      attempts: z.number().step(1).min(1).default(DEFAULT_TRIGGER_THRESHOLDS.attemptCount),
    }),
    repeatRunLength: z.object({
      enabled: z.boolean().default(true),
      runLength: z.number().step(1).min(1).default(DEFAULT_TRIGGER_THRESHOLDS.repeatRunLength),
    }),
    stepBudgetExhausted: z.object({
      enabled: z.boolean().default(true),
      exhaustions: z.number().step(1).min(1).default(DEFAULT_TRIGGER_THRESHOLDS.stepBudgetExhausted),
    }),
    turnFailureStreak: z.object({
      enabled: z.boolean().default(true),
      streak: z.number().step(1).min(1).default(DEFAULT_TRIGGER_THRESHOLDS.turnFailureStreak),
    }),
  }),
  maxContinues: z.number().step(1).min(0).default(DEFAULT_MAX_CONTINUES),
  maxArbiterDepth: z.number().step(1).min(1).default(DEFAULT_MAX_ARBITER_DEPTH),
  minStepsBetween: z.number().step(1).min(0).default(DEFAULT_MIN_STEPS_BETWEEN),
  maxDigestTools: z.number().step(1).min(1).default(DEFAULT_MAX_DIGEST_TOOLS),
  maxDigestChars: z.number().step(1).min(1).default(DEFAULT_MAX_DIGEST_CHARS),
  maxExcerptChars: z.number().step(1).min(1).default(DEFAULT_MAX_EXCERPT_CHARS),
  maxArgChars: z.number().step(1).min(1).default(DEFAULT_MAX_ARG_CHARS),
  progressInstructions: z.string().required(),
  confidence: z.number().min(0).max(1).default(DEFAULT_JUDGMENT_CONFIDENCE),
  margin: z.number().min(0).max(1).default(DEFAULT_JUDGMENT_MARGIN),
  judgmentTier: z.union(['fast', 'accurate']).default(DEFAULT_JUDGMENT_TIER),
  askToEscalate: z.boolean().default(false),
})

/** The `agentTeams` target name the Team Lead answers to. */
const LEAD_TARGET = 'lead'

/**
 * Committed event types that can change a trigger verdict, the aging counter,
 * or the cooldown. Every other event is invisible to the ladder.
 */
const LADDER_EVENTS: ReadonlySet<string> = new Set([
  'tool/call',
  'tool/result',
  'turn/end',
  'step/end',
  'user/message',
  'jspace/card',
  'jspace/charter-run',
  'step-budget/exhausted',
])

/** The Stage 1 ask's question id, echoed by the answer this ladder reads. */
const PROGRESS_QUESTION_ID = judgmentQuestionId('worker-progress')

/**
 * The two options the Stage 1 ask offers, which are exactly the choices a
 * passed gate logs. Stage 1 executes neither: `needs-help` is a record, and
 * only the ladder's own `report-blocked` terminal acts.
 */
const PROGRESS_OPTIONS = ['continue', 'needs-help'] as const

/** The figures one answered ask reports, present whenever an engine answered. */
interface ProgressAnswer {
  /** Confidence the answer reported, 0 through 1. */
  readonly confidence: number
  /** Top-two probability margin of the answer's distribution. */
  readonly margin: number
}

/** What one Stage 1 consult resolved for a firing trigger. */
interface ProgressConsult {
  /** Engine class that answered, or the class of the consult that could not answer. */
  readonly engine: EscalationEngineClass
  /** Why the consult resolved this way. */
  readonly reason: EscalationConsultReason
  /** The choice to log: the ask's own option where the gate passed, `continue` otherwise. */
  readonly choice: EscalationChoice
  /** The answer's figures, present only where an engine answered. */
  readonly answer?: ProgressAnswer
}

/** The choice question one ask asks: whether the worker should keep going. */
function progressQuestion(config: ResolvedWorkerEscalationConfig): JudgmentChoiceQuestion {
  return {
    kind: 'choice',
    id: PROGRESS_QUESTION_ID,
    instructions: config.progressInstructions,
    options: PROGRESS_OPTIONS.map(option => ({ option })),
  }
}

/**
 * Top-two probability margin of the ask's answer. The question offers exactly
 * two options, so the margin is their difference. A provider validates one
 * probability per option before an answer reaches a consumer, so an option the
 * distribution omits reads as zero here.
 * @param probabilities - the answer's per-option distribution.
 * @returns the absolute difference between the two options' probabilities.
 */
function progressMargin(probabilities: Readonly<Record<string, number>>): number {
  const [first, second] = PROGRESS_OPTIONS
  return Math.abs((probabilities[first] ?? 0) - (probabilities[second] ?? 0))
}

/** The ask-to-escalate's question id, echoed by the answer this ladder reads. */
const ESCALATE_QUESTION_ID = 'worker-escalation'

/** The heading the ask-to-escalate is shown under. */
const ESCALATE_HEADER = 'Worker escalation'

/**
 * The label the human sees for each ask-to-escalate option. The answer carries
 * the label, so the ladder maps it back to the option it logs.
 */
const ESCALATE_LABELS: Readonly<Record<EscalationAskOption, string>> = {
  escalate: 'Escalate to the Lead now',
  'keep-working': 'Keep working',
}

/** What each option means, as the human reads it beside the label. */
const ESCALATE_DESCRIPTIONS: Readonly<Record<EscalationAskOption, string>> = {
  escalate: 'Record that this worker should be escalated to the Lead now. The choice is logged; nothing is sent.',
  'keep-working': 'Record that this worker should keep going. The ladder asks again after the next firing trigger.',
}

/** The two options in the order the human sees them. */
const ESCALATE_OPTIONS: readonly EscalationAskOption[] = ['escalate', 'keep-working']

/**
 * The option a chosen label names.
 * @param label - the selected label the answer carries.
 * @returns the option, or undefined for a label the question did not offer.
 */
function escalateOptionForLabel(label: string): EscalationAskOption | undefined {
  return ESCALATE_OPTIONS.find(option => ESCALATE_LABELS[option] === label)
}

/**
 * The question the ask-to-escalate puts to the human: which trigger fired on
 * which worker, the bounded digest of what the worker was doing as its detail,
 * and the two options.
 * @param trigger - the trigger that fired.
 * @param triggerSeq - session event seq it fired at.
 * @param digest - the bounded worker digest, shown as the question's detail.
 * @returns the one question item the ask carries.
 */
function escalateQuestion(trigger: EscalationTrigger, triggerSeq: number, digest: WorkerEscalationDigest): AskUserQuestionItem {
  return {
    id: ESCALATE_QUESTION_ID,
    header: ESCALATE_HEADER,
    question: 'Worker ' + digest.sessionId + ' looks stuck: its ' + trigger + ' trigger fired at event '
      + String(triggerSeq) + '. Escalate it to the Lead now?',
    detail: renderWorkerDigest(digest),
    options: ESCALATE_OPTIONS.map(option => ({ label: ESCALATE_LABELS[option], description: ESCALATE_DESCRIPTIONS[option] })),
  }
}

/**
 * Read the option one answer chose. A usable answer carries exactly this
 * question's id, exactly one selected label the question offered, and no
 * custom text; anything else is the provider's defect and reads as no option.
 * @param answer - the answer the seam returned.
 * @returns the chosen option, or undefined for an answer this ladder cannot use.
 */
function escalateAnswerOption(answer: AskUserQuestionAnswer): EscalationAskOption | undefined {
  const items = answer.answers.filter(item => item.id === ESCALATE_QUESTION_ID)
  const item = items.length === 1 ? items[0] : undefined
  if (item === undefined || item.custom !== undefined) return undefined
  const [label, ...rest] = item.selected
  if (label === undefined || rest.length > 0) return undefined
  return escalateOptionForLabel(label)
}

/**
 * Whether the ladder owns this session: a delegated child within the
 * delegation-depth cap. A root session carries no delegation depth and is
 * never engaged — it has a human, a jspace seat, and the advisor.
 * @param session - candidate session.
 * @param config - resolved ladder configuration.
 * @returns true when the ladder may decide for this session.
 */
function engaged(session: Session, config: ResolvedWorkerEscalationConfig): boolean {
  const depth = session.header.delegationDepth ?? 0
  return depth >= 1 && depth <= config.maxArbiterDepth
}

/**
 * The goal epoch's exclusive lower bound, read from the jspace card that owns
 * it. Without a card the ladder folds the whole log, because a worker
 * composition need not carry the jspace seat.
 * @param ctx - context that may carry `jspace`.
 * @param session - session whose open card defines the epoch.
 * @returns the card's `goalOpenedSeq`, or -1 for no card.
 */
function epochAnchorSeq(ctx: Context, session: Session): number {
  return ctx.get('jspace')?.card(session)?.goalOpenedSeq ?? -1
}

/**
 * The stuck report's fixed preamble; the bounded worker digest follows it.
 * @param trigger - the trigger that fired.
 * @param triggerSeq - session event seq it fired at.
 * @param continues - continue resolutions this goal epoch already took.
 * @returns the preamble text.
 */
function reportText(trigger: EscalationTrigger, triggerSeq: number, continues: number): string {
  return 'Worker report: blocked. This worker session cannot make further progress on its assignment:'
    + ' it took ' + String(continues) + ' escalation decisions on this goal epoch, and the latest '
    + trigger + ' trigger fired at event ' + String(triggerSeq) + '.'
    + ' Take the work over, restate the assignment, or reassign it.'
}

/** The aging facts one decision records, without the epoch's internal latch. */
function agingView(aging: EscalationAgingState): { continues: number; lastContinueSeq?: number } {
  return {
    continues: aging.continues,
    ...aging.lastContinueSeq === undefined ? {} : { lastContinueSeq: aging.lastContinueSeq },
  }
}

/**
 * Install the ladder: the settings namespace, the committed-event watch, and
 * the lifetime that ends the report.
 *
 * Every registration here is an effect, so Cordis disposes it with the fiber
 * that mounted this plugin; a `ctx.plugin()` mount never receives this
 * return value and never needs it. The disposer is for a caller that invoked
 * `apply` directly and must remove the registrations itself.
 *
 * The ladder decides after the append that scheduled it, never inside it:
 * `Session.append` refuses to reenter while another append is published, so a
 * scheduled evaluation runs from a microtask once that boundary has closed, and
 * no evaluation is taken while a charter discrimination probe is in flight
 * ({@link probeInFlight}), whose exclusion is complete only once its
 * registering call settles. One evaluation runs per session at a time — the
 * schedule entry is held until the consult and the human ask it may await have
 * settled, so a second committed event cannot start an overlapping pass over
 * the same log.
 * The engagement gates are the session's own delegation depth and the step
 * cooldown — never the presence of mail, because a worker that must wait for
 * the Lead to write before it can decide would deadlock on exactly the
 * situation the ladder exists for.
 * @param ctx - plugin context; every registration is scoped to it.
 * @param config - composition config, re-judged fail-loud here.
 * @returns a disposer that removes every registration this call made, for a
 *   caller that invoked `apply` directly.
 */
export function apply(ctx: Context, config: WorkerEscalationConfig): () => void {
  let source: () => WorkerEscalationConfig = () => config
  let raw: WorkerEscalationConfig = config
  let resolved: ResolvedWorkerEscalationConfig = resolveConfig(config)

  /** The resolved configuration in force, re-resolved when the settings layer replaces it. */
  const configuration = (): ResolvedWorkerEscalationConfig => {
    const next = source()
    if (next !== raw) {
      raw = next
      resolved = resolveConfig(next)
    }
    return resolved
  }

  installSettingsSection(ctx, WORKER_ESCALATION_SETTINGS_NAMESPACE, Config, config, {
    validate: (next) => {
      resolveConfig(next)
    },
    setSource: (next) => {
      source = next
    },
    onChange: () => {
      // Nothing is derived at registration: every decision re-resolves the
      // configuration it reads, so a committed change reaches the next one.
    },
  })

  const lifetime = new AbortController()
  // One evaluation per session at a time, held until the consult and the human
  // ask it may await have settled; it is also what keeps a second blocked
  // report from starting while the first is unresolved.
  const scheduled = new WeakSet<Session>()

  /**
   * Deliver the blocked report through the Team mailbox the worker already
   * owns, then record the terminal. A report the mailbox refuses records
   * nothing: the epoch stays open and a later firing trigger retries it, so a
   * logged terminal always means the Lead was actually told.
   */
  const reportBlocked = async (
    session: Session,
    current: ResolvedWorkerEscalationConfig,
    trigger: EscalationTrigger,
    triggerSeq: number,
    aging: EscalationAgingState,
  ): Promise<void> => {
    try {
      const agent = ctx.get('agents')?.get(session.id)
      const teams = ctx.get('agentTeams')
      if (agent === undefined || teams === undefined) {
        ctx.logger.warn('worker-escalation: a worker reached its terminal with no Team mailbox to report through')
        return
      }
      const digest = foldWorkerDigest(session, {
        maxTools: current.maxDigestTools,
        maxChars: current.maxDigestChars,
        maxExcerpt: current.maxExcerptChars,
        maxArgs: current.maxArgChars,
      })
      await teams.sendMessage(agent, {
        target: LEAD_TARGET,
        content: [{ type: 'text', text: reportText(trigger, triggerSeq, aging.continues) + '\n\n' + renderWorkerDigest(digest) }],
        signal: lifetime.signal,
      })
      // The terminal resolves on the epoch's own count before any consult runs,
      // so it carries the rule it resolved on and no engine class.
      session.append('escalation/decision', {
        trigger,
        triggerSeq,
        choice: 'report-blocked',
        reason: 'max-continues',
        aging: agingView(aging),
      }, { ignorable: true })
    } catch (error: unknown) {
      ctx.logger.warn('worker-escalation: the blocked report was not delivered: ' + String(error))
    }
  }

  /**
   * Consult the judgment engine for one firing trigger: compose the ask's
   * numbers-first state, ask the two-option progress question, and judge the
   * answer against both gates. The state goes to `ctx.judgment.ask()`
   * unredacted: consulting `ctx.judgmentRedactor` is the provider's obligation,
   * so this ladder never reads the hook.
   *
   * Every failure resolves to the Stage 0 continue carrying its own class: no
   * engine composed, a disabled engine, an engine that threw, an answer this
   * ladder could not use, and an answer below either gate. The consult executes
   * nothing — its only product is what the decision logs — and it is reached
   * only for a firing trigger that has not already resolved the terminal.
   * @param session - the worker session the trigger fired on.
   * @param current - resolved ladder configuration.
   * @param anchorSeq - the goal epoch's exclusive lower bound.
   * @returns the engine class, the reason, the choice to log, and the answer's figures where one answered.
   */
  const consultProgress = async (
    session: Session,
    current: ResolvedWorkerEscalationConfig,
    anchorSeq: number,
  ): Promise<ProgressConsult> => {
    /** One degradation: the Stage 0 continue, carrying the class that caused it. */
    const degraded = (engine: EscalationEngineClass, reason: EscalationConsultReason): ProgressConsult =>
      ({ engine, reason, choice: 'continue' })
    const engine = ctx.get('judgment')
    if (engine === undefined) return degraded('absent', 'engine-absent')
    if (!judgmentEnabled(engine.settings)) return degraded('disabled', 'engine-disabled')
    let result: JudgmentResult
    try {
      result = await engine.ask({
        state: composeProgressState(session, current, anchorSeq),
        questions: [progressQuestion(current)],
        tier: current.judgmentTier,
        signal: lifetime.signal,
      })
    } catch (error: unknown) {
      // A provider that refused an unusable response classified it itself; every
      // other failure is a transport class the seam reports as UNAVAILABLE.
      const code = (error as { code?: unknown } | null)?.code
      return code === 'INVALID_ANSWER'
        ? degraded('invalid-answer', 'invalid-answer')
        : degraded('unavailable', 'engine-unavailable')
    }
    const answer = result.answers.find((candidate): candidate is JudgmentChoiceAnswer => candidate.kind === 'choice')
    if (answer === undefined) return degraded('invalid-answer', 'invalid-answer')
    const option = PROGRESS_OPTIONS.find(candidate => candidate === answer.option)
    if (option === undefined) return degraded('invalid-answer', 'invalid-answer')
    const margin = progressMargin(answer.probabilities)
    const figures: ProgressAnswer = { confidence: answer.confidence, margin }
    if (answer.confidence < current.confidence) {
      return { engine: 'ok', reason: 'low-confidence', choice: 'continue', answer: figures }
    }
    if (margin < current.margin) {
      return { engine: 'ok', reason: 'thin-margin', choice: 'continue', answer: figures }
    }
    return { engine: 'ok', reason: 'gate-passed', choice: option, answer: figures }
  }

  /**
   * Resolve the live Agent whose session the human answers in. A worker the
   * registry lists as a runtime root answers for itself, because the seam admits
   * that root and the question belongs in its own session. A worker owned by
   * another live agent has no human answerer — asking as the child is exactly
   * what the seam refuses with `DELEGATED_CALLER` and why this package exists —
   * so the ask rides the Team root supervising it, which is the session the
   * human watching the team already reads. A worker with no live Team root falls
   * back to its own agent, and the seam's own refusal becomes the outcome.
   * @param agents - the live agent registry to read both identities from.
   * @param agent - the worker's own live Agent.
   * @returns the Agent to ask as.
   */
  const askAsAgent = (agents: AgentRegistry, agent: Agent): Agent =>
    agents.roots().includes(agent)
      ? agent
      : ctx.get('agentTeams')?.tryMembership(agent)?.root ?? agent

  /**
   * Ask the human, through the user-questions seam, whether to escalate this
   * worker to the Lead now or let it keep working. The ask is made on behalf of
   * the asker {@link askAsAgent} resolves, so a Team-spawned worker reaches the
   * human through the root that supervises it rather than being refused as a
   * delegated caller.
   *
   * Every failure resolves to its own class and no option: no seam composed, no
   * live Agent for the session, the seam's refusal, any other throw, and an
   * answer this ladder cannot use. The ask executes nothing — its only product
   * is what the decision logs — and it is reached only for a firing trigger
   * that has not already resolved the terminal.
   * @param session - the worker session the trigger fired on.
   * @param current - resolved ladder configuration.
   * @param trigger - the trigger that fired.
   * @param triggerSeq - session event seq it fired at.
   * @returns the reason, and the chosen option where the human answered.
   */
  const askToEscalate = async (
    session: Session,
    current: ResolvedWorkerEscalationConfig,
    trigger: EscalationTrigger,
    triggerSeq: number,
  ): Promise<EscalationAskOutcome> => {
    const questions = ctx.get('userQuestions')
    if (questions === undefined) return { reason: 'seam-absent' }
    const agents = ctx.get('agents')
    const agent = agents?.get(session.id)
    if (agents === undefined || agent === undefined) return { reason: 'agent-absent' }
    const digest = foldWorkerDigest(session, {
      maxTools: current.maxDigestTools,
      maxChars: current.maxDigestChars,
      maxExcerpt: current.maxExcerptChars,
      maxArgs: current.maxArgChars,
    })
    let answer: AskUserQuestionAnswer
    try {
      answer = await questions.ask({
        questions: [escalateQuestion(trigger, triggerSeq, digest)],
        agent: askAsAgent(agents, agent),
        signal: lifetime.signal,
      })
    } catch (error: unknown) {
      const code = (error as { code?: unknown } | null)?.code
      return { reason: code === 'DELEGATED_CALLER' ? 'delegated-caller' : 'seam-unavailable' }
    }
    const option = escalateAnswerOption(answer)
    return option === undefined ? { reason: 'invalid-answer' } : { reason: 'answered', option }
  }

  /**
   * Resolve one firing trigger into a decision, or into the report-blocked
   * terminal. The consult and the ask-to-escalate run before the append, so the
   * decision records what the engine answered, what the gate resolved, and what
   * the human chose; the append reads the log's own newest seq at that point,
   * which is the decision's own seq minus one.
   */
  const evaluate = async (session: Session): Promise<void> => {
    const current = configuration()
    if (!current.enabled) return
    if (!engaged(session, current)) return
    // A probe's nested check run is harness machinery, and its markers land after
    // that run: no verdict is taken while the registering call is open, so every
    // verdict reads a log in which the probe's exclusion is complete.
    if (probeInFlight(session.events)) return
    const anchorSeq = epochAnchorSeq(ctx, session)
    const outcomes: readonly EscalationTriggerOutcome[] = foldEscalationTriggers(session.events, current, anchorSeq)
    const firing = outcomes.find(outcome => outcome.fired)
    const triggerSeq = firing?.triggerSeq
    if (firing === undefined || triggerSeq === undefined) return
    // A standing trigger keeps its seq until new evidence arrives, and the
    // cooldown measures completed steps, so one stuck state cannot write a
    // decision per event.
    const cooldown = foldEscalationCooldown(session.events, anchorSeq)
    if (cooldown.lastDecisionSeq !== undefined && triggerSeq <= cooldown.lastDecisionSeq) return
    if (cooldown.stepsSinceLastDecision < current.minStepsBetween) return
    const aging = foldEscalationAging(session.events, anchorSeq)
    if (aging.reportBlocked) return
    if (aging.continues >= current.maxContinues) {
      await reportBlocked(session, current, firing.trigger, triggerSeq, aging)
      return
    }
    const consult = await consultProgress(session, current, anchorSeq)
    const ask = current.askToEscalate ? await askToEscalate(session, current, firing.trigger, triggerSeq) : undefined
    session.append('escalation/decision', {
      trigger: firing.trigger,
      triggerSeq,
      choice: consult.choice,
      engine: consult.engine,
      reason: consult.reason,
      ...consult.answer === undefined
        ? {}
        : { confidence: consult.answer.confidence, margin: consult.answer.margin },
      ...ask === undefined ? {} : { ask },
      aging: { continues: aging.continues + 1, lastContinueSeq: session.seq },
    }, { ignorable: true })
  }

  const ladder = ctx.effect(() => ctx.on('session/event', (session: Session, event) => {
    if (!LADDER_EVENTS.has(event.type)) return
    if (scheduled.has(session)) return
    scheduled.add(session)
    queueMicrotask(() => {
      void evaluate(session).finally(() => {
        scheduled.delete(session)
      })
    })
  }, { global: true }), 'worker-escalation: committed-event watch')

  const teardown = ctx.effect(() => () => {
    lifetime.abort(new Error('worker-escalation disposed'))
  }, 'worker-escalation: lifetime')

  return () => {
    void ladder()
    void teardown()
  }
}
