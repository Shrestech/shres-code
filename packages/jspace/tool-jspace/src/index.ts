/**
 * Model-facing J-Space tools. Registrations remount from
 * `ctx.jspace.watch()` so the catalog is empty while the seat is inactive.
 * @module @shres-code/shres-code-tool-jspace
 */

import type { Context } from '@shres-code/cordis'
import { defineTool } from '@shres-code/shres-code-tools'
import type { GenericCallView, ToolRunContext } from '@shres-code/shres-code-tools'
import { JspaceError } from '@shres-code/shres-code-jspace'
import type { JspaceStatus } from '@shres-code/shres-code-jspace'
import { REPEAT_DENY, shouldRefuseRepeat } from './retry.ts'
import { shipRefusal } from './ship.ts'

/** Cordis plugin name. */
export const name = 'tool-jspace'
/** Requires the tool registry and the J-Space seat. */
export const inject = ['tools', 'jspace']

const OPEN_DESCRIPTION =
  'Open a J-Space card for this session, or replace Goal and Next when a card is '
  + 'already open. Use it for multi-stage or multi-file work. Requires a Goal '
  + '(what done means) and Next (the single next action). Optional Core holds at '
  + 'most two live items and applies only on the first open.'

const NOTE_DESCRIPTION =
  'Update the open J-Space card. Changing Core requires both departing (the item '
  + 'leaving) and core (the item entering). Rejects if no card is open.'

const CHECKPOINT_DESCRIPTION =
  'Record a Checked line on the open card. `by` must name a verifier and what it covered. '
  + 'Optional `evidence` is a prior tool-call id that must have completed without error in '
  + 'this session; naming it does not prove coverage. Rejects if no card is open.'

const SHIP_DESCRIPTION =
  'Check that the open card is ready to ship: Goal and Next are set, and a checkpoint '
  + 'exists for the current Goal. Does not write files and does not close the card. '
  + 'Optional `path` is recorded in the result only.'

const ACK = {
  opened: 'Opened J-Space.',
  updated: 'Updated J-Space.',
  checked: 'Recorded checkpoint.',
  shipped: 'Ship check passed.',
} as const

/** Generic pending card from args only. */
function present(title: string, rawInput?: unknown): GenericCallView {
  return {
    card: 'generic',
    title,
    kind: 'other',
    ...rawInput === undefined ? {} : { rawInput },
  }
}

/**
 * Require the calling agent so mutations have a session log.
 * @param exec - tool execution identity.
 * @param toolName - model-visible tool name for the error.
 * @returns the owning agent.
 */
function requireAgent(exec: ToolRunContext, toolName: string): NonNullable<ToolRunContext['agent']> {
  if (exec.agent === undefined) {
    throw new Error(`${toolName} requires an owning agent session`)
  }
  return exec.agent
}

/**
 * Map seat refusals to a plain Error so the model sees the same message.
 * @param fn - seat mutation.
 * @returns the mutation result.
 */
function runJspace<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof JspaceError) throw new Error(error.message)
    throw error
  }
}

const OPENED = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    opened: { type: 'boolean' as const, required: true as const },
    replaced: { type: 'boolean' as const },
  },
}

const UPDATED = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    updated: { type: 'boolean' as const, required: true as const },
  },
}

const CHECKED = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    checked: { type: 'boolean' as const, required: true as const },
  },
}

const SHIPPED = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    shipped: { type: 'boolean' as const, required: true as const },
    path: { type: 'string' as const },
  },
}

/**
 * Register the four tools on one fiber so remount can dispose them together.
 * @param ctx - context with tools and jspace.
 * @returns disposer for every registration.
 */
function registerTools(ctx: Context): () => void {
  const disposeOpen = ctx.tools.register(defineTool({
    name: 'jspace_open',
    description: OPEN_DESCRIPTION,
    parameters: {
      goal: { type: 'string', required: true, description: 'What done means, one sentence.' },
      next: { type: 'string', required: true, description: 'The single next action.' },
      core: {
        type: 'array',
        description: 'Optional live items, at most two.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: OPENED,
      render: (_args, value) => [{
        type: 'text',
        text: value.replaced === true ? ACK.updated : ACK.opened,
      }],
    },
    execute(args, exec) {
      const agent = requireAgent(exec, 'jspace_open')
      return Promise.resolve(runJspace(() => {
        if (ctx.jspace.card(agent.session) !== null) {
          ctx.jspace.openGoal(agent.session, { goal: args.goal, next: args.next })
          return { opened: true, replaced: true }
        }
        ctx.jspace.open(agent.session, {
          goal: args.goal,
          next: args.next,
          ...args.core === undefined ? {} : { core: args.core },
        })
        return { opened: true }
      }))
    },
    presentCall: args => present('Open J-Space', args.goal),
  }))

  const disposeNote = ctx.tools.register(defineTool({
    name: 'jspace_note',
    description: NOTE_DESCRIPTION,
    parameters: {
      goal: { type: 'string', description: 'Replacement Goal line.' },
      departing: { type: 'string', description: 'Core item leaving; required when `core` is set.' },
      core: { type: 'string', description: 'Core item entering; required when `departing` is set.' },
      open: {
        type: 'array',
        description: 'Replacement unsettled questions.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            question: { type: 'string', required: true, description: 'The question still open.' },
            settles: { type: 'string', description: 'What would settle it.' },
          },
        },
      },
      next: { type: 'string', description: 'Replacement Next line.' },
    },
    output: {
      schema: UPDATED,
      render: () => [{ type: 'text', text: ACK.updated }],
    },
    execute(args, exec) {
      const agent = requireAgent(exec, 'jspace_note')
      return Promise.resolve(runJspace(() => {
        ctx.jspace.note(agent.session, {
          ...args.goal === undefined ? {} : { goal: args.goal },
          ...args.departing === undefined ? {} : { departing: args.departing },
          ...args.core === undefined ? {} : { core: args.core },
          ...args.open === undefined ? {} : { open: args.open },
          ...args.next === undefined ? {} : { next: args.next },
        })
        return { updated: true }
      }))
    },
    presentCall: args => present('Update J-Space', args),
  }))

  const disposeCheckpoint = ctx.tools.register(defineTool({
    name: 'jspace_checkpoint',
    description: CHECKPOINT_DESCRIPTION,
    parameters: {
      check: { type: 'string', required: true, description: 'What was claimed checked.' },
      by: {
        type: 'string',
        required: true,
        description: 'Verifier and coverage claim. Must name both.',
      },
      evidence: {
        type: 'string',
        description: 'Completed non-error tool-call id. Naming it does not prove coverage.',
      },
    },
    output: {
      schema: CHECKED,
      render: () => [{ type: 'text', text: ACK.checked }],
    },
    execute(args, exec) {
      const agent = requireAgent(exec, 'jspace_checkpoint')
      return Promise.resolve(runJspace(() => {
        ctx.jspace.checkpoint(agent.session, {
          check: args.check,
          by: args.by,
          ...args.evidence === undefined ? {} : { evidence: args.evidence },
        })
        return { checked: true }
      }))
    },
    presentCall: args => present('Record checkpoint', args.check),
  }))

  const disposeShip = ctx.tools.register(defineTool({
    name: 'jspace_ship',
    description: SHIP_DESCRIPTION,
    parameters: {
      path: { type: 'string', description: 'Optional outgoing path recorded in the result only.' },
    },
    output: {
      schema: SHIPPED,
      render: () => [{ type: 'text', text: ACK.shipped }],
    },
    execute(args, exec) {
      const agent = requireAgent(exec, 'jspace_ship')
      return Promise.resolve(runJspace(() => {
        const session = agent.session
        const refusal = shipRefusal(ctx.jspace.card(session), session.events)
        if (refusal !== undefined) throw new Error(refusal)
        return args.path === undefined ? { shipped: true } : { shipped: true, path: args.path }
      }))
    },
    presentCall: args => present('Ship J-Space', args.path),
  }))

  return () => {
    disposeOpen()
    disposeNote()
    disposeCheckpoint()
    disposeShip()
  }
}

/**
 * Remount the four tools while the seat is active.
 * @param ctx - context with tools and jspace.
 */
export function apply(ctx: Context): void {
  let disposeTools: (() => void) | undefined
  const remount = (status: JspaceStatus): void => {
    disposeTools?.()
    disposeTools = undefined
    if (!status.active) return
    disposeTools = registerTools(ctx)
  }
  remount(ctx.jspace.status)
  ctx.effect(() => {
    const stop = ctx.jspace.watch(remount)
    return () => {
      stop()
      disposeTools?.()
      disposeTools = undefined
    }
  })
  ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
    if (!ctx.jspace.status.active) return next()
    const session = exec.agent?.session
    if (session === undefined || ctx.jspace.card(session) === null) return next()
    if (shouldRefuseRepeat(session.events, exec.name, exec.arguments, exec.callId)) {
      return Promise.resolve({ kind: 'deny' as const, reason: REPEAT_DENY })
    }
    return next()
  }), 'tool-jspace: diagnosed retry')
}
