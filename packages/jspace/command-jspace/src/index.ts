/**
 * Human-facing `/j-space on|off` over the session card. Session-local:
 * it never writes Settings `enabled`. Unregisters while the seat is inactive.
 * @module @shres-code/shres-code-command-jspace
 */

import type { Context } from '@shres-code/cordis'
import type { CommandInvocation, CommandResult } from '@shres-code/shres-code-commands'
import {
  JSPACE_ALWAYS_OPEN_GOAL,
  JSPACE_ALWAYS_OPEN_NEXT,
  JspaceError,
} from '@shres-code/shres-code-jspace'
import type { JspaceStatus } from '@shres-code/shres-code-jspace'

/** Cordis plugin name. */
export const name = 'command-jspace'
/** Requires the command registry and the J-Space seat. */
export const inject = ['commands', 'jspace']

const USAGE = 'open a card with jspace_open or: /j-space on <goal> | <next>'

type JspaceCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'on'; readonly goal?: string; readonly next?: string }
  | { readonly kind: 'off' }
  | { readonly kind: 'usage' }

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never, label: string): never {
  throw new TypeError(`unknown ${label}: ${String(value)}`)
}
/* v8 ignore stop */

/**
 * Parse `/j-space` input. `on` / `off` are case-insensitive control words.
 * @param rawInput - text after the command name.
 * @returns the parsed command.
 */
function parseJspaceCommand(rawInput: string): JspaceCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  const match = /^(on|off)(?:\s+|$)/iu.exec(input)
  if (match === null) return { kind: 'usage' }
  const verb = match[1]
  /* v8 ignore next -- the first capture is required whenever the regular expression matches */
  if (verb === undefined) return { kind: 'usage' }
  const rest = input.slice(match[0].length).trim()
  if (verb.toLowerCase() === 'off') return { kind: 'off' }
  if (rest.length === 0) return { kind: 'on' }
  const index = rest.indexOf('|')
  if (index < 0) return { kind: 'usage' }
  const goal = rest.slice(0, index).trim()
  const next = rest.slice(index + 1).trim()
  if (goal.length === 0 || next.length === 0) return { kind: 'usage' }
  return { kind: 'on', goal, next }
}

/**
 * Execute one parsed `/j-space` line against the calling session.
 * @param ctx - context carrying the J-Space seat.
 * @param invocation - dispatching agent and raw suffix.
 * @returns a direct UI result.
 */
function executeJspaceCommand(ctx: Context, invocation: CommandInvocation): CommandResult {
  const command = parseJspaceCommand(invocation.rawInput)
  const session = invocation.agent.session
  try {
    const card = ctx.jspace.card(session)
    switch (command.kind) {
      case 'show':
        return card === null
          ? { kind: 'success', text: 'No J-Space card is open.' }
          : {
            kind: 'success',
            text: `J-Space is open.\nGoal: ${card.goal}\nNext: ${card.next}`,
          }
      case 'usage':
        return { kind: 'error', text: USAGE }
      case 'on':
        if (card !== null) {
          return { kind: 'success', text: 'A J-Space card is already open.' }
        }
        ctx.jspace.open(session, {
          goal: command.goal ?? JSPACE_ALWAYS_OPEN_GOAL,
          next: command.next ?? JSPACE_ALWAYS_OPEN_NEXT,
        })
        return { kind: 'success', text: 'Opened J-Space.' }
      case 'off':
        if (card === null) return { kind: 'success', text: 'J-Space is already closed.' }
        ctx.jspace.close(session)
        return { kind: 'success', text: 'Closed J-Space.' }
      /* v8 ignore next 2 -- JspaceCommand is closed and every member is handled above */
      default: return assertNever(command, 'j-space command')
    }
  } catch (error: unknown) {
    if (error instanceof JspaceError) {
      return { kind: 'error', text: error.message }
    }
    throw error
  }
}

/**
 * Register `/j-space` while the seat is active.
 * @param ctx - context with commands and jspace.
 */
export function apply(ctx: Context): void {
  let disposeCommand: (() => void) | undefined
  const syncCommand = (status: JspaceStatus): void => {
    disposeCommand?.()
    disposeCommand = undefined
    if (!status.active) return
    disposeCommand = ctx.commands.register({
      name: 'j-space',
      description: "open or close this session's J-Space card",
      input: { hint: '[on [<goal> | <next>]|off]' },
      handler: invocation => executeJspaceCommand(ctx, invocation),
    })
  }
  syncCommand(ctx.jspace.status)
  ctx.effect(() => {
    const stop = ctx.jspace.watch(syncCommand)
    return () => {
      stop()
      disposeCommand?.()
      disposeCommand = undefined
    }
  })
}
