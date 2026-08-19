/**
 * Reprints the J-Space card as `jspace:card` and mounts the protocol
 * sections the current pass earns. Compaction and resume reread the log.
 *
 * @module @shres-code/shres-code-jspace-prompt
 */

import type { Context } from '@shres-code/cordis'
import type { Session, UserMessage } from '@shres-code/shres-code-session'
import type { AssembleContext } from '@shres-code/shres-code-system-prompt'
// Merge AssembleContext.agent and .messages.
import type {} from '@shres-code/shres-code-agent'
import {
  formatJspaceCard,
  JSPACE_ALWAYS_OPEN_GOAL,
  JSPACE_ALWAYS_OPEN_NEXT,
  JSPACE_AVAILABLE_LINE,
} from '@shres-code/shres-code-jspace'
import type {} from '@shres-code/shres-code-system-prompt'
import { classifyJspacePass, type JspacePass } from './gate.ts'
import {
  formatJspaceProtocol,
  JSPACE_PROTOCOL_ORDER,
  JSPACE_PROTOCOL_SECTION,
} from './protocol.ts'

export { classifyJspacePass, type JspacePass, type JspacePassInput } from './gate.ts'
export {
  formatJspaceProtocol,
  JSPACE_DRIVER_CLOSED,
  JSPACE_DRIVER_OPEN,
  JSPACE_PROTOCOL_SECTION,
} from './protocol.ts'

/** Cordis plugin name. */
export const name = 'jspace-prompt'

/** Requires the seat and the prompt assembler. */
export const inject = ['jspace', 'systemPrompt']

/** Section name the Settings page and tests look for. */
export const JSPACE_SECTION = 'jspace:card'

/** Prompt order: before plan policy (50). */
export const JSPACE_SECTION_ORDER = 45

/**
 * Latest human user text from the session log.
 * @param session - session whose events to scan.
 * @returns joined text parts, or empty.
 */
function messageText(message: UserMessage): string {
  const parts: string[] = []
  for (const part of message.content) {
    if (part.type === 'text') parts.push(part.text)
  }
  return parts.join('\n')
}

/** Maximum length of a Goal seeded from the triggering human text. */
export const JSPACE_SEED_GOAL_MAX = 200

/**
 * Goal seeded from the triggering human text: the first non-empty line,
 * trimmed and cut within `JSPACE_SEED_GOAL_MAX` at a sentence, then word,
 * boundary, with an ellipsis when cut. Blank text keeps the stock placeholder
 * so the card never opens goal-less.
 * @param text - triggering human text for this assemble.
 * @returns the Goal line to open with.
 */
export function seedGoal(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part.length > 0)
  if (line === undefined) return JSPACE_ALWAYS_OPEN_GOAL
  if (line.length <= JSPACE_SEED_GOAL_MAX) return line
  const head = line.slice(0, JSPACE_SEED_GOAL_MAX)
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  if (sentence > 0) return `${head.slice(0, sentence).replace(/[.!?]+$/u, '')}…`
  const word = head.lastIndexOf(' ')
  if (word > 0) return `${head.slice(0, word).trimEnd()}…`
  return `${head}…`
}

/**
 * Latest human user text from claimed step messages, else the session log.
 * @param session - session whose events to scan.
 * @param claimed - messages the loop already claimed for this assemble.
 * @returns joined text parts, or empty.
 */
function turnText(session: Session | undefined, claimed: readonly UserMessage[] | undefined): string {
  const fromClaimed = (claimed ?? [])
    .filter(message => message.source.kind === 'user')
    .map(messageText)
    .join('\n')
    .trim()
  if (fromClaimed.length > 0) return fromClaimed
  if (session === undefined) return ''
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event === undefined || event.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    return messageText(event.data)
  }
  return ''
}

/**
 * Pass for this assembly: reconstructable from claimed text, the log, and seat config.
 * @param ctx - seat owner.
 * @param session - live session, when any.
 * @param claimed - claimed step messages, when assemble runs in the loop.
 * @returns the selected pass, or `fast` when the seat is off.
 */
export function passFor(
  ctx: Context,
  session: Session | undefined,
  claimed?: readonly UserMessage[],
): JspacePass {
  if (!ctx.jspace.status.active) return 'fast'
  const cardOpen = session !== undefined && ctx.jspace.card(session) !== null
  const alwaysOpen = ctx.jspace.config.mode === 'always-open'
  return classifyJspacePass({ text: turnText(session, claimed), cardOpen, alwaysOpen })
}

/**
 * Register the card section, operational protocol, and loop/always-open open.
 * @param ctx - Cordis context with jspace and systemPrompt.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: JSPACE_SECTION,
    order: JSPACE_SECTION_ORDER,
    text: (context) => {
      if (!ctx.jspace.status.active) return ''
      openIfLoop(ctx, context)
      const session = context.agent?.session
      if (session === undefined) return JSPACE_AVAILABLE_LINE
      const folded = ctx.jspace.fold(session)
      if (folded.card === null) return JSPACE_AVAILABLE_LINE
      return formatJspaceCard(folded.card)
    },
  })

  ctx.systemPrompt.section({
    name: JSPACE_PROTOCOL_SECTION,
    order: JSPACE_PROTOCOL_ORDER,
    text: (context) => {
      if (!ctx.jspace.status.active) return ''
      const session = context.agent?.session
      const cardOpen = session !== undefined && ctx.jspace.card(session) !== null
      return formatJspaceProtocol(passFor(ctx, session, context.messages), cardOpen)
    },
  })

}

/**
 * Open a card when this assemble's pass is loop and none exists, so the same
 * request reprints the card instead of inviting a doomed `jspace_open`. Goal is
 * seeded from the triggering human text (`seedGoal`, stock placeholder when
 * that text is blank) and Next stays the stock line; the open lands in the log
 * as `jspace/card`, so compaction and resume rebuild the seeded card. An
 * explicit close this session (`/j-space off`) stays closed: the automatic
 * path must never undo the user's off.
 * @param ctx - seat owner.
 * @param context - current assemble context.
 */
function openIfLoop(ctx: Context, context: AssembleContext): void {
  const agent = context.agent
  if (agent === undefined) return
  /* v8 ignore next -- section text returns before this when the seat is off */
  if (!ctx.jspace.status.active) return
  const folded = ctx.jspace.fold(agent.session)
  if (folded.card !== null) return
  if (folded.closed) return
  if (passFor(ctx, agent.session, context.messages) !== 'loop') return
  ctx.jspace.open(agent.session, {
    goal: seedGoal(turnText(agent.session, context.messages)),
    next: JSPACE_ALWAYS_OPEN_NEXT,
  })
}
