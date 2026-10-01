/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @shres-code/shres-code-agent/types
 */

import type { GenerateOptions, UserMessage } from '@shres-code/shres-code-llm/types'

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * Explicit session model selection for subsequent prompt assembly. The
     * latest selection remains authoritative across routed requests, resume,
     * and fork; an absent effort selects the provider's default behavior.
     * This non-surface event records intent even when the chosen route matches
     * the last request header.
     */
    'agent/model-selection': Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'>

    /**
     * The manual route beneath a routed request. The model-selection hook
     * appends it before the request's `request/header` when a composed
     * `ctx.modelRouting` ran a route that differs from the manual route in
     * provider, model, or effort, so a reader without the router recovers the
     * route the agent returns to (`manualBaseOfLastHeader`). Required on read:
     * a build that skipped it would resume on the routed candidate. The two
     * routes differ, and each has a nonempty provider and model.
     */
    'agent/route-base': {
      /** The manual route the request was routed from. */
      manual: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'>
      /** The route the request ran. */
      routed: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'>
    }

    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * Live dispatch precedes projection mutation, so synchronous observers may
     * read the pre-splice inbox to recover the removed messages.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
    }
  }
}
