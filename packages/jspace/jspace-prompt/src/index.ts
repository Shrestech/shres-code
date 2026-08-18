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
  JSPACE_BROADCAST_ORDER,
  JSPACE_BROADCAST_SECTION,
  JSPACE_BROADCAST_TEXT,
  JSPACE_CAPACITY_ORDER,
  JSPACE_CAPACITY_SECTION,
  JSPACE_CAPACITY_TEXT,
  JSPACE_FIRST_EXTRA_MODULE_ORDER,
  JSPACE_MODULE_SECTIONS,
  JSPACE_MODULE_TEXT,
  JSPACE_PROTOCOL_ORDER,
  JSPACE_PROTOCOL_SECTION,
  selectJspaceModules,
  type JspaceModuleName,
} from './protocol.ts'

export { classifyJspacePass, type JspacePass, type JspacePassInput } from './gate.ts'
export {
  formatJspaceProtocol,
  JSPACE_BROADCAST_SECTION,
  JSPACE_CAPACITY_SECTION,
  JSPACE_DRIVER_CLOSED,
  JSPACE_DRIVER_OPEN,
  JSPACE_MODULE_SECTIONS,
  JSPACE_PROTOCOL_SECTION,
  selectJspaceModules,
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
 * True when the latest event is a tool result or the last human text is untrusted.
 * @param session - live session, when any.
 * @returns whether introspection must load.
 */
function isUntrusted(
  session: Session | undefined,
  claimed?: readonly UserMessage[],
): boolean {
  if (session?.events.at(-1)?.type === 'tool/result') return true
  return /\b(untrusted|retrieved|search result|tool output)\b/iu.test(turnText(session, claimed))
}

/**
 * Extra modules this assembly mounts.
 * @param ctx - seat owner.
 * @param session - live session, when any.
 * @returns selected extra module names.
 */
export function modulesFor(
  ctx: Context,
  session: Session | undefined,
  claimed?: readonly UserMessage[],
): readonly JspaceModuleName[] {
  if (!ctx.jspace.status.active) return []
  const text = turnText(session, claimed)
  return selectJspaceModules({
    pass: passFor(ctx, session, claimed),
    untrusted: isUntrusted(session, claimed),
    longChain: text.length > 400,
  })
}

/**
 * Register the card section, protocol sections, and loop/always-open pre-step.
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

  ctx.systemPrompt.section({
    name: JSPACE_CAPACITY_SECTION,
    order: JSPACE_CAPACITY_ORDER,
    text: (context) => {
      if (!ctx.jspace.status.active) return ''
      const pass = passFor(ctx, context.agent?.session, context.messages)
      return pass === 'fast' ? '' : JSPACE_CAPACITY_TEXT
    },
  })

  ctx.systemPrompt.section({
    name: JSPACE_BROADCAST_SECTION,
    order: JSPACE_BROADCAST_ORDER,
    text: (context) => {
      if (!ctx.jspace.status.active) return ''
      return passFor(ctx, context.agent?.session, context.messages) === 'loop'
        ? JSPACE_BROADCAST_TEXT
        : ''
    },
  })

  const extraNames = Object.keys(JSPACE_MODULE_SECTIONS) as JspaceModuleName[]
  extraNames.forEach((moduleName, index) => {
    ctx.systemPrompt.section({
      name: JSPACE_MODULE_SECTIONS[moduleName],
      order: JSPACE_FIRST_EXTRA_MODULE_ORDER + index,
      text: (context) => {
        if (!ctx.jspace.status.active) return ''
        return modulesFor(ctx, context.agent?.session, context.messages).includes(moduleName)
          ? JSPACE_MODULE_TEXT[moduleName]
          : ''
      },
    })
  })
}

/**
 * Open a card when this assemble's pass is loop and none exists, so the same
 * request reprints the stock card instead of inviting a doomed `jspace_open`.
 * An explicit close this session (`/j-space off`) stays closed: the automatic
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
    goal: JSPACE_ALWAYS_OPEN_GOAL,
    next: JSPACE_ALWAYS_OPEN_NEXT,
  })
}
