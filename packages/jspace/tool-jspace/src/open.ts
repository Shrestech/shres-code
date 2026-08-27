/**
 * Constraint-capture check for `jspace_open` under `requireCoreOnOpen`.
 * @module @shres-code/shres-code-tool-jspace/open
 */

/** Model-visible refusal when `requireCoreOnOpen` finds no Core line on a new card. */
export const OPEN_REQUIRES_CORE
  = 'jspace_open requires at least one core item. Core carries the once-stated constraints, '
  + 'standing rules, and invariants this work must honor through context compaction, and it is '
  + 'the only card field reprinted whole. Re-read the task statement for them and pack related '
  + 'rules into one line; Core holds at most two.'

/**
 * Why `jspace_open` must refuse, or `undefined` when the call may proceed.
 * Only a first open carries `core` into the card — the seat ignores it when the
 * call replaces Goal and Next on an open card — so only that call is gated.
 * @param cardOpen - true when the session already has an open card.
 * @param core - `core` argument as the model supplied it.
 * @param requireCore - `requireCoreOnOpen` from plugin config.
 * @returns the refusal message.
 */
export function openRefusal(
  cardOpen: boolean,
  core: readonly string[] | undefined,
  requireCore: boolean,
): string | undefined {
  if (!requireCore || cardOpen) return undefined
  return core === undefined || core.length === 0 ? OPEN_REQUIRES_CORE : undefined
}
