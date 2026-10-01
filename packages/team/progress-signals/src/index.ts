/**
 * Pure progress signals over a session's committed events: five stuck-trigger
 * verdicts, the numbers-first progress facts that measure the same runs, the
 * trailing tool window, and the identical-call chain key.
 *
 * A library, not a service or plugin: no `ctx`, no registration, no state,
 * no events. Every fold reads only the log it is given, so resume, fork,
 * compaction, and bench replay reach the same answers from the same events.
 *
 * @module @shres-code/shres-code-progress-signals
 */

export type * from './types.ts'
export {
  ESCALATION_TRIGGERS,
  callChainKey,
  canonicalizeArguments,
  foldEscalationTriggers,
  foldProgressFacts,
  foldToolWindow,
  isSandboxDenial,
  probeInFlight,
  triggerSatisfiedAt,
} from './fold.ts'
