/**
 * Operational J-Space prompt copy. The card is durable external state, not an
 * activation lens or a claim about the model's internal representations.
 */

import type { JspacePass } from './gate.ts'

/** Prompt section that tells the model how to use the current card state. */
export const JSPACE_PROTOCOL_SECTION = 'jspace:protocol'

/** Order immediately after `jspace:card` (45). */
export const JSPACE_PROTOCOL_ORDER = 46

/** How to open the durable card when the current task needs later reuse. */
export const JSPACE_DRIVER_CLOSED =
  'For work whose intermediate or constraint must survive another tool, file, or compaction, '
  + 'call jspace_open with Goal, Next, and up to two Core items. Skip the card for one-step work.'

/** How to maintain an already-open durable card. */
export const JSPACE_DRIVER_OPEN = [
  'The J-Space card is durable external state. Keep Core to the current intermediate and at most one pinned constraint.',
  'Before a later operation depends on changed state, update Core or Next with jspace_note.',
  'After a check completes, call jspace_checkpoint with what it checked and the successful tool-call id as evidence.',
  'A repeated failed tool call is refused until Core or Next changes. Call jspace_ship after the current Goal has an evidence-backed checkpoint; a successful ship closes the card.',
].join('\n')

/**
 * Operational copy for this assembly. `fast` with no card carries only the
 * short open driver; full/loop use the same rules so pass labels and protocol
 * modules never become model-facing ceremony.
 * @param pass - selected pass.
 * @param cardOpen - true when a native card is already printed.
 * @returns the protocol section text.
 */
export function formatJspaceProtocol(pass: JspacePass, cardOpen: boolean): string {
  if (cardOpen) return JSPACE_DRIVER_OPEN
  return pass === 'fast'
    ? JSPACE_DRIVER_CLOSED
    : `${JSPACE_DRIVER_CLOSED}\nOpen the card before the first operation that needs this state.`
}
