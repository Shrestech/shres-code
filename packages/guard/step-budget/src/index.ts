/**
 * Per-turn model-step budget. It counts nothing of its own: the loop numbers
 * every proposed step, and this guard refuses the first proposal past the
 * budget so the turn closes `blocked` through the existing `agent/pre-step`
 * rejection path. Configuration, the stop record, and the delivered notice
 * live in the package README; rationale lives in the harness-hardening Agent
 * Note.
 * @module @shres-code/shres-code-step-budget
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import type { Agent, PreStepDecision } from '@shres-code/shres-code-agent'
import { createUserMessage } from '@shres-code/shres-code-llm'
import type { MessageSource } from '@shres-code/shres-code-llm'
import type { UserMessage } from '@shres-code/shres-code-session'
import './types.ts'

export type { StepBudgetExhausted } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'step-budget'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time check in `apply` (misconfiguration fails loud: a non-integer or
 * negative `maxStepsPerTurn` throws at plugin load, never a silent fall-back).
 */
export interface Config {
  /**
   * Most model steps one turn may enter. `0` — the default — means unlimited
   * and registers no listener, so an unconfigured deployment behaves exactly
   * as it did before this guard existed. A step is one model request plus the
   * tool calls it makes, so the budget bounds a runaway tool loop; it does not
   * bound tokens, wall time, or how many turns a session runs.
   */
  maxStepsPerTurn?: number
}

export const Config: z<Config> = z.object({
  maxStepsPerTurn: z.number().default(0),
})

/**
 * The `{kind:'plugin'}` source stamped on the stop notice — the label is
 * load-bearing (an unlabeled context would render as a user prompt in derived
 * history).
 */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'step-budget' }

/**
 * The model-facing explanation queued when the budget fires. It names the
 * limit, states that the work is unfinished, and asks for a stocktake before
 * more work, because the next turn resumes from a truncated middle.
 * @param limit - the budget that was reached.
 * @returns the notice text.
 */
function noticeText(limit: number): string {
  return `Your previous turn stopped after ${limit} model steps, the most this session allows in one turn. `
    + 'The work is unfinished and nothing was cancelled. '
    + 'Before continuing, state in one or two sentences what is already done and what remains, '
    + 'then take the single most valuable next action instead of redoing earlier steps.'
}

/**
 * Validate `maxStepsPerTurn` per the fail-loud contract and resolve the
 * unlimited sentinel away.
 * @param value - the schema-defaulted config value.
 * @returns the positive budget, or `undefined` when the guard is unlimited.
 * @throws when the value is not a non-negative integer.
 */
function resolveBudget(value: number): number | undefined {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`step-budget: invalid maxStepsPerTurn ${value} — must be an integer >= 0 (0 means unlimited)`)
  }
  return value === 0 ? undefined : value
}

/**
 * Return the batch this pre-step already claimed to the inbox, so ending the
 * turn drops no queued context. Claiming precedes the waterfall, so a plain
 * rejection would discard tool-result contexts and injected notices that no
 * step ever consumed.
 * @param agent - the agent whose turn is ending.
 * @param messages - the batch claimed for the refused step.
 */
function restoreClaimed(agent: Agent, messages: UserMessage[]): void {
  for (const message of messages.toReversed()) {
    agent.inbox.prepend('next-step', message)
  }
}

/**
 * Install the guard's listener. An unlimited budget registers nothing.
 * @param ctx - plugin context; the listener is scoped to it and disposed with it.
 * @param config - validated {@link Config}; `maxStepsPerTurn` is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the field is set after validation.
  const limit = resolveBudget(config.maxStepsPerTurn as number)
  if (limit === undefined) return

  // Veto, never delegate: a later listener cannot un-exhaust the budget, and
  // delegating would let it enter the step this guard exists to refuse.
  ctx.on('agent/pre-step', ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    if (step <= limit) return next()
    agent.session.append('step-budget/exhausted', { turn, step, limit }, { ignorable: true })
    restoreClaimed(agent, messages)
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: noticeText(limit) }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: `step budget ${limit} reached` },
    }))
    return Promise.resolve({ kind: 'reject' })
  })
}
