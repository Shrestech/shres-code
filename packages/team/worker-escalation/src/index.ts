/**
 * Worker difficulty ladder, Stage 0: deterministic and engine-free.
 *
 * A delegated worker session has no structured response to mid-turn
 * difficulty — it cannot ask the human, the step budget bounds only one turn,
 * and the jspace advisor engages root sessions only. This package folds the
 * worker's own log for five stuck signals, logs one log-only
 * `escalation/decision` per firing trigger, and after `maxContinues`
 * continue resolutions on a goal epoch reports the worker blocked to the Lead
 * through the Team mailbox the worker already owns.
 *
 * The ladder ships off and appears in no default bundle row: `enabled: false`
 * writes no session event and sends no mail, so a composed-but-off deployment
 * is byte-identical to one without this package.
 *
 * Nothing here consults a judgment engine: `engine` is `'absent'` on every
 * decision this stage writes.
 *
 * @module @shres-code/shres-code-worker-escalation
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import type { Session } from '@shres-code/shres-code-session'
import { installSettingsSection } from '@shres-code/shres-code-settings'
// Type-only edges: resolve `ctx.agents`, `ctx.jspace`, and `ctx.agentTeams`.
import type {} from '@shres-code/shres-code-agent'
import type {} from '@shres-code/shres-code-agent-team'
import type {} from '@shres-code/shres-code-jspace'
import {
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
import { foldEscalationAging, foldEscalationCooldown, foldEscalationTriggers } from './fold.ts'
import type { EscalationAgingState } from './fold.ts'
import type { EscalationTrigger, EscalationTriggerOutcome } from './types.ts'

// The `escalation/decision` session-event declaration lives in src/types.ts
// (its one home); this re-export keeps the module edge in the emitted
// declarations so aggregate programs receive the merge.
export type * from './types.ts'
export {
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
export { foldEscalationAging, foldEscalationCooldown, foldEscalationTriggers, triggerSatisfiedAt } from './fold.ts'
export { canonicalizeArguments, callChainKey, isSandboxDenial } from './fold.ts'
export type { EscalationAgingState, EscalationCooldownState } from './fold.ts'
export { foldTeamMessages, foldWorkerDigest, foldWorkerCharter, renderWorkerDigest } from './digest.ts'
export type { WorkerAssignmentFold, WorkerDigestCaps } from './digest.ts'

/** Cordis plugin name. */
export const name = 'worker-escalation'

/**
 * Composition config schema, which is also the `worker-escalation` settings
 * section schema. Unknown keys and wrong types fail plugin load by name, and
 * `resolveConfig` re-judges every bound and the cross-field requirements.
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
 * the disposer that stops both.
 *
 * The ladder decides after the append that scheduled it, never inside it:
 * `Session.append` refuses to reenter while another append is published, so a
 * scheduled evaluation runs from a microtask once that boundary has closed.
 * The engagement gates are the session's own delegation depth and the step
 * cooldown — never the presence of mail, because a worker that must wait for
 * the Lead to write before it can decide would deadlock on exactly the
 * situation the ladder exists for.
 * @param ctx - plugin context; every registration is scoped to it.
 * @param config - composition config, re-judged fail-loud here.
 * @returns a disposer that removes every registration this call made.
 */
export function apply(ctx: Context, config: WorkerEscalationConfig = {}): () => void {
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
  const scheduled = new WeakSet<Session>()
  const reporting = new WeakSet<Session>()

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
      session.append('escalation/decision', {
        trigger,
        triggerSeq,
        choice: 'report-blocked',
        engine: 'absent',
        aging: agingView(aging),
      }, { ignorable: true })
    } catch (error: unknown) {
      ctx.logger.warn('worker-escalation: the blocked report was not delivered: ' + String(error))
    } finally {
      reporting.delete(session)
    }
  }

  /** Resolve one firing trigger into a decision, or into the report-blocked terminal. */
  const evaluate = (session: Session): void => {
    const current = configuration()
    if (!current.enabled) return
    if (!engaged(session, current)) return
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
      if (reporting.has(session)) return
      reporting.add(session)
      void reportBlocked(session, current, firing.trigger, triggerSeq, aging)
      return
    }
    session.append('escalation/decision', {
      trigger: firing.trigger,
      triggerSeq,
      choice: 'continue',
      engine: 'absent',
      aging: { continues: aging.continues + 1, lastContinueSeq: session.seq },
    }, { ignorable: true })
  }

  const ladder = ctx.effect(() => ctx.on('session/event', (session: Session, event) => {
    if (!LADDER_EVENTS.has(event.type)) return
    if (scheduled.has(session)) return
    scheduled.add(session)
    queueMicrotask(() => {
      scheduled.delete(session)
      evaluate(session)
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
