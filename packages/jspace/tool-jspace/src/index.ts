/**
 * Model-facing J-Space tools. Registrations remount from
 * `ctx.jspace.watch()` so the catalog is empty while the seat is inactive, and
 * a session the seat has not engaged yet neither sees the four schemas in its
 * assembled request nor gets a call through the executor.
 * @module @shres-code/shres-code-tool-jspace
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { defineTool } from '@shres-code/shres-code-tools'
import type { GenericCallView, ToolRunContext } from '@shres-code/shres-code-tools'
import { JspaceError } from '@shres-code/shres-code-jspace'
import type { JspaceStatus } from '@shres-code/shres-code-jspace'
// Type-only: resolves the `system-prompt/assemble` waterfall the engagement
// roster gate joins, and the `agent` field `shres-agent` merges into its context.
import type {} from '@shres-code/shres-code-system-prompt'
import type {} from '@shres-code/shres-code-agent'
import {
  DEFAULT_MAX_NOTES_PER_TURN,
  JSPACE_TOOL_NAMES,
  noteCapDeny,
  notEngagedDeny,
  REPEAT_DENY,
  shouldRefuseNoteCap,
  shouldRefuseRepeat,
} from './retry.ts'
import { openRefusal } from './open.ts'
import { shipRefusal } from './ship.ts'

export { DEFAULT_MAX_NOTES_PER_TURN, JSPACE_TOOL_NAMES } from './retry.ts'

/** Cordis plugin name. */
export const name = 'tool-jspace'
/** Requires the tool registry and the J-Space seat. */
export const inject = ['tools', 'jspace']

/** Per-turn `jspace_note` budget and the opt-in constraint-capture pressure. */
export interface Config {
  /**
   * Maximum `jspace_note` calls accepted in one user turn. Defaults to 8.
   * Zero and negative are rejected.
   */
  maxNotesPerTurn?: number
  /**
   * When true, a `jspace_open` that would create the card is refused unless it
   * carries at least one `core` item. Default false.
   */
  requireCoreOnOpen?: boolean
  /** When true, `jspace_ship` is refused while the card's Core is empty. Default false. */
  requireCoreForShip?: boolean
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxNotesPerTurn: z.number().step(1).min(1).default(DEFAULT_MAX_NOTES_PER_TURN),
  requireCoreOnOpen: z.boolean().default(false),
  requireCoreForShip: z.boolean().default(false),
})

/** Fully materialized note-cap and constraint-capture requirements. */
interface ResolvedConfig {
  readonly maxNotesPerTurn: number
  readonly requireCoreOnOpen: boolean
  readonly requireCoreForShip: boolean
}

/**
 * Validate config even when apply is called directly outside Loader normalization.
 * @param config - raw plugin config.
 * @returns a positive per-turn note cap and both constraint-capture requirements.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const maxNotesPerTurn = config.maxNotesPerTurn ?? DEFAULT_MAX_NOTES_PER_TURN
  if (!Number.isSafeInteger(maxNotesPerTurn) || maxNotesPerTurn < 1) {
    throw new TypeError('tool-jspace: maxNotesPerTurn must be a positive safe integer')
  }
  return {
    maxNotesPerTurn,
    requireCoreOnOpen: config.requireCoreOnOpen ?? false,
    requireCoreForShip: config.requireCoreForShip ?? false,
  }
}

const OPEN_DESCRIPTION =
  'Open a J-Space card for multi-stage or multi-file work, or replace Goal and Next '
  + 'on an open card. Put the task\'s once-stated constraints on `core` so they survive '
  + 'compaction. A changed Goal starts a new epoch: Core and Checked are cleared '
  + 'and ship needs a fresh checkpoint; open questions carry over.'

const NOTE_DESCRIPTION =
  'Update the open J-Space card. Goal changes are rejected; use jspace_open to start '
  + 'a new Goal epoch. Rejects a no-op that leaves the card unchanged, and rejects if '
  + 'no card is open.'

const CHECKPOINT_DESCRIPTION =
  'Record a Checked line on the open card. `by` names the verifier and what it covered. '
  + 'Prefer citing `evidence`, a completed non-error tool-call id from this session, over '
  + 'prose; a configured verifier tool makes the line evidence-grade. Citing does not '
  + 'prove coverage. Rejects if no card is open.'

const SHIP_DESCRIPTION =
  'Check that the open card is ready to ship: Goal and Next are set, and a checkpoint '
  + 'exists for the current Goal. Writes no files and does not close the card.'

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
 * @param config - resolved note cap and constraint-capture requirements.
 * @returns disposer for every registration.
 */
function registerTools(ctx: Context, config: ResolvedConfig): () => void {
  const disposeOpen = ctx.tools.register(defineTool({
    name: 'jspace_open',
    description: OPEN_DESCRIPTION,
    parameters: {
      goal: { type: 'string', required: true, description: 'What done means, one sentence.' },
      next: { type: 'string', required: true, description: 'The single next action.' },
      core: {
        type: 'array',
        description: 'Standing rules and invariants this work must honor, stated once in the '
          + 'task and easy to lose: at most two lines, applied only on the first open.',
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
        const cardOpen = ctx.jspace.card(agent.session) !== null
        const refusal = openRefusal(cardOpen, args.core, config.requireCoreOnOpen)
        if (refusal !== undefined) throw new Error(refusal)
        if (cardOpen) {
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
      core: {
        type: 'string',
        description: 'Core item entering — a constraint the work must honor. '
          + 'Required when `departing` is set.',
      },
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
        const refusal = shipRefusal(ctx.jspace.card(session), session.events, {
          requireVerifiedEvidence: ctx.jspace.config.requireVerifiedEvidence === true,
          requireCore: config.requireCoreForShip,
        })
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
 * Remount the four tools while the seat is active, withhold their schemas from
 * a session the seat has not engaged, and refuse a call that arrives anyway.
 * @param ctx - context with tools and jspace.
 * @param config - per-turn note cap (defaults to 8) and constraint-capture requirements (default off).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  let disposeTools: (() => void) | undefined
  const remount = (status: JspaceStatus): void => {
    disposeTools?.()
    disposeTools = undefined
    if (!status.active) return
    disposeTools = registerTools(ctx, resolved)
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
  // The registrations stay mounted so an engaged session can execute them, so
  // the per-session roster decision lands on the assembly that carries the
  // session. Filtering after `next()` keeps the removal authoritative over a
  // listener that re-added the schemas earlier in the chain.
  ctx.effect(() => ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (ctx.jspace.engaged(context.agent?.session)) return assembled
    return {
      ...assembled,
      tools: assembled.tools.filter(schema => !JSPACE_TOOL_NAMES.has(schema.name)),
    }
  }), 'tool-jspace: engagement roster')
  ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
    if (!ctx.jspace.status.active) return next()
    const session = exec.agent?.session
    if (JSPACE_TOOL_NAMES.has(exec.name) && !ctx.jspace.engaged(session)) {
      return Promise.resolve({
        kind: 'deny' as const,
        reason: notEngagedDeny(ctx.jspace.engageAfterSteps),
      })
    }
    if (session === undefined || ctx.jspace.card(session) === null) return next()
    if (shouldRefuseNoteCap(session.events, exec.name, resolved.maxNotesPerTurn, exec.callId)) {
      return Promise.resolve({ kind: 'deny' as const, reason: noteCapDeny(resolved.maxNotesPerTurn) })
    }
    if (shouldRefuseRepeat(session.events, exec.name, exec.arguments, exec.callId)) {
      return Promise.resolve({ kind: 'deny' as const, reason: REPEAT_DENY })
    }
    return next()
  }), 'tool-jspace: diagnosed retry')
}
