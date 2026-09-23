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
