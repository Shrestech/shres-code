/**
 * Model-facing J-Space tools. Registrations remount from
 * `ctx.jspace.watch()` so the catalog is empty while the seat is inactive, and
 * a session the seat has not engaged yet neither sees the five schemas in its
 * assembled request nor gets a call through the executor.
 * @module @shres-code/shres-code-tool-jspace
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import type { PreStepDecision } from '@shres-code/shres-code-agent'
import { defineTool } from '@shres-code/shres-code-tools'
import type { GenericCallView, ToolRunContext } from '@shres-code/shres-code-tools'
import { extractCharterProposal, JspaceError } from '@shres-code/shres-code-jspace'
import type { JspaceCharterEntry, JspaceStatus } from '@shres-code/shres-code-jspace'
import type { Session, UserMessage } from '@shres-code/shres-code-session'
// Type-only: resolves the `system-prompt/assemble` waterfall the engagement
// roster gate joins, and the `agent` field `shres-agent` merges into its context.
import type {} from '@shres-code/shres-code-system-prompt'
import type {} from '@shres-code/shres-code-agent'
import type {} from '@shres-code/shres-code-fs'
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
import {
  assignCharterIds,
  CHARTER_ALREADY_REGISTERED,
  charterOpenRefusal,
  CHECKPOINT_REQUIRES_CHARTER,
  expandCharterItems,
  foldCharterEntries,
  hasExecutableCharter,
  latestCharterProposal,
  OPEN_REQUIRES_EXECUTABLE_CHARTER,
  planCharterAmend,
  refuseCharterCap,
  type CharterResolveConfig,
  type CharterToolItem,
} from './charter-resolve.ts'
import {
  runCharter,
  synthesizedCharterBy,
  synthesizedCharterCheck,
} from './charter-run.ts'
import { AMEND_CHARTER_ITEMS, OPEN_CHARTER_PARAM } from './charter-schema.ts'
import type { CharterDiscriminationMode } from './charter-probe.ts'

export { DEFAULT_MAX_NOTES_PER_TURN, JSPACE_TOOL_NAMES } from './retry.ts'

/** Cordis plugin name. */
export const name = 'tool-jspace'
/** Requires the tool registry, the J-Space seat, and the prompt assembler. */
export const inject = ['tools', 'jspace', 'systemPrompt']

/** Per-turn `jspace_note` budget, constraint-capture pressure, and charter gates. */
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
  /**
   * When true, first charter registration is refused unless the resolved charter
   * has length ≥ 1, and `jspace_checkpoint` / `jspace_ship` refuse an empty charter.
   * Default false.
   */
  requireCharter?: boolean
  /**
   * When true, the charter must contain at least one `kind: 'check'`.
   * Implies `requireCharter`. Default false.
   */
  requireExecutableCharter?: boolean
  /** When true, extract a charter proposal from the first human user message during prompt assembly. Default false. */
  charterSeed?: boolean
  /**
   * Discrimination bar at registration. `'required'` implies `requireExecutableCharter`.
   * Default `'off'`.
   */
  charterDiscrimination?: CharterDiscriminationMode
  /** Nested bash `timeoutMs` for each charter check. Default 30000. */
  charterCheckTimeoutMs?: number
  /** Cap on seeded proposal entries and on the registered charter list. Default 12. */
  maxCharterEntries?: number
  /** When true, refuse write-token charter commands. Default true. */
  charterChecksMustBeReadOnly?: boolean
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxNotesPerTurn: z.number().step(1).min(1).default(DEFAULT_MAX_NOTES_PER_TURN),
  requireCoreOnOpen: z.boolean().default(false),
  requireCoreForShip: z.boolean().default(false),
  requireCharter: z.boolean().default(false),
  requireExecutableCharter: z.boolean().default(false),
  charterSeed: z.boolean().default(false),
  charterDiscrimination: z.union(['off', 'best-effort', 'required'] as const).default('off'),
  charterCheckTimeoutMs: z.number().step(1).min(1).default(30_000),
  maxCharterEntries: z.number().step(1).min(1).max(32).default(12),
  charterChecksMustBeReadOnly: z.boolean().default(true),
})

/** Fully materialized note-cap, constraint-capture, and charter requirements. */
interface ResolvedConfig extends CharterResolveConfig {
  readonly maxNotesPerTurn: number
  readonly requireCoreOnOpen: boolean
  readonly requireCoreForShip: boolean
  readonly charterSeed: boolean
  readonly maxCharterEntries: number
}

/**
 * Validate config even when apply is called directly outside Loader normalization.
 * @param config - raw plugin config.
 * @returns a positive per-turn note cap and charter requirements.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const maxNotesPerTurn = config.maxNotesPerTurn ?? DEFAULT_MAX_NOTES_PER_TURN
  if (!Number.isSafeInteger(maxNotesPerTurn) || maxNotesPerTurn < 1) {
    throw new TypeError('tool-jspace: maxNotesPerTurn must be a positive safe integer')
  }
  const charterCheckTimeoutMs = config.charterCheckTimeoutMs ?? 30_000
  if (!Number.isSafeInteger(charterCheckTimeoutMs) || charterCheckTimeoutMs < 1) {
    throw new TypeError('tool-jspace: charterCheckTimeoutMs must be a positive safe integer')
  }
  const requireExecutableCharter = config.requireExecutableCharter ?? false
  const requireCharter = config.requireCharter ?? false
  if (requireExecutableCharter && !requireCharter) {
    throw new TypeError('tool-jspace: requireExecutableCharter implies requireCharter')
  }
  const charterDiscrimination = config.charterDiscrimination ?? 'off'
  if (charterDiscrimination === 'required' && !requireExecutableCharter) {
    throw new TypeError('tool-jspace: charterDiscrimination \'required\' implies requireExecutableCharter')
  }
  const maxCharterEntries = config.maxCharterEntries ?? 12
  if (!Number.isSafeInteger(maxCharterEntries) || maxCharterEntries < 1 || maxCharterEntries > 32) {
    throw new TypeError('tool-jspace: maxCharterEntries must be a safe integer from 1 to 32')
  }
  return {
    maxNotesPerTurn,
    requireCoreOnOpen: config.requireCoreOnOpen ?? false,
    requireCoreForShip: config.requireCoreForShip ?? false,
    requireCharter,
    requireExecutableCharter,
    charterSeed: config.charterSeed ?? false,
    charterDiscrimination,
    charterCheckTimeoutMs,
    maxCharterEntries,
    charterChecksMustBeReadOnly: config.charterChecksMustBeReadOnly ?? true,
  }
}

const OPEN_DESCRIPTION =
  'Open a J-Space card for multi-stage or multi-file work, or replace Goal and Next '
  + 'on an open card. Put once-stated constraints on `charter` (prefer kind=check) so the '
  + 'harness re-runs them at every checkpoint and at ship. First charter registration is '
  + 'the first `jspace_open` that carries `charter` while the card charter is empty, including '
  + 'after loop auto-open. A later `jspace_open` that carries `charter` onto a non-empty charter '
  + 'is refused; use `jspace_charter_amend`. `core` still holds at most two live working-memory '
  + 'items. A changed Goal starts a new epoch: Core and Checked are cleared and ship needs a '
  + 'fresh checkpoint; the charter and open questions carry over.'

const NOTE_DESCRIPTION =
  'Update the open J-Space card. Goal changes are rejected; use jspace_open to start '
  + 'a new Goal epoch. Rejects a no-op that leaves the card unchanged, and rejects if '
  + 'no card is open. Charter changes use jspace_charter_amend, not this tool.'

const CHECKPOINT_DESCRIPTION =
  'Record a Checked line on the open card. When a charter is registered, the harness '
  + 'runs every kind=check first and refuses on the first failure. `check` and `by` are '
  + 'optional then (the harness synthesizes them); if you send them they are appended '
  + 'after a passing charter run. Prefer citing `evidence` over prose. Rejects if no card is open.'

const SHIP_DESCRIPTION =
  'Check that the open card is ready to ship: Goal and Next are set, and a checkpoint '
  + 'exists for the current Goal. Re-runs every charter check against the current workspace. '
  + 'Writes no files and does not close the card.'

const AMEND_DESCRIPTION =
  'Replace charter entries on the open card. Drop by id, replace an id with a new check or '
  + 'prose entry, or add entries. The harness re-runs floor and discrimination on added and '
  + 'replaced checks. There is no skip-checks argument.'

const ACK = {
  opened: 'Opened J-Space.',
  updated: 'Updated J-Space.',
  checked: 'Recorded checkpoint.',
  shipped: 'Ship check passed.',
  amended: 'Amended charter.',
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

/**
 * Expand, cap, assign ids, then floor + discriminate.
 * @param ctx - context with tools and fs.
 * @param exec - parent jspace_open execution.
 * @param items - raw charter argument.
 * @param config - resolved charter config.
 * @returns folded entries.
 */
async function resolveIncomingCharter(
  ctx: Context,
  exec: ToolRunContext,
  items: readonly CharterToolItem[] | undefined,
  config: ResolvedConfig,
): Promise<JspaceCharterEntry[]> {
  const expanded = expandCharterItems(items, latestCharterProposal(exec))
  const cap = refuseCharterCap(expanded.length, config.maxCharterEntries)
  if (cap !== undefined) throw new Error(cap)
  return foldCharterEntries(ctx, exec, assignCharterIds(expanded), config)
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

const AMENDED = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    amended: { type: 'boolean' as const, required: true as const },
  },
}

/**
 * Register the five tools on one fiber so remount can dispose them together.
 * @param ctx - context with tools and jspace.
 * @param config - resolved note cap, constraint-capture, and charter requirements.
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
        description: 'At most two live working-memory items, applied only on the first open.',
        items: { type: 'string' },
      },
      charter: OPEN_CHARTER_PARAM,
    },
    output: {
      schema: OPENED,
      render: (_args, value) => [{
        type: 'text',
        text: value.replaced === true ? ACK.updated : ACK.opened,
      }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec, 'jspace_open')
      const card = ctx.jspace.card(agent.session)
      const cardOpen = card !== null
      const coreRefusal = openRefusal(cardOpen, args.core, config.requireCoreOnOpen)
      if (coreRefusal !== undefined) throw new Error(coreRefusal)
      const charterArg = args.charter as readonly CharterToolItem[] | undefined
      const registering = charterArg !== undefined
      if (cardOpen && registering && card.charter.length > 0) {
        throw new Error(CHARTER_ALREADY_REGISTERED)
      }
      if (cardOpen && !registering) {
        return runJspace(() => {
          ctx.jspace.openGoal(agent.session, { goal: args.goal, next: args.next })
          return { opened: true, replaced: true }
        })
      }
      const folded = await resolveIncomingCharter(ctx, exec, charterArg, config)
      const charterRefusal = charterOpenRefusal(folded, config)
      if (charterRefusal !== undefined) throw new Error(charterRefusal)
      if (cardOpen) {
        return runJspace(() => {
          ctx.jspace.openGoal(agent.session, { goal: args.goal, next: args.next })
          if (folded.length > 0) ctx.jspace.amendCharter(agent.session, folded)
          return { opened: true, replaced: true }
        })
      }
      return runJspace(() => {
        ctx.jspace.open(agent.session, {
          goal: args.goal,
          next: args.next,
          ...args.core === undefined ? {} : { core: args.core },
          ...folded.length === 0 ? {} : { charter: folded },
        })
        return { opened: true }
      })
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
        description: 'Core item entering — a live working-memory item. '
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
      check: { type: 'string', description: 'What was claimed checked. Optional when a charter is registered.' },
      by: {
        type: 'string',
        description: 'Verifier and coverage claim. Optional when a charter is registered.',
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
    async execute(args, exec) {
      const agent = requireAgent(exec, 'jspace_checkpoint')
      const card = ctx.jspace.card(agent.session)
      if (card === null) throw new Error('jspace card is not open')
      if (config.requireCharter && card.charter.length === 0) {
        throw new Error(CHECKPOINT_REQUIRES_CHARTER)
      }
      if (card.charter.length > 0) {
        const last = await runCharter(ctx, exec, card.charter, 'checkpoint', config)
        const checkCount = card.charter.filter(entry => entry.kind === 'check').length
        if (args.check === undefined || args.by === undefined) {
          return runJspace(() => {
            ctx.jspace.checkpoint(agent.session, {
              check: synthesizedCharterCheck(card.charter),
              by: synthesizedCharterBy(checkCount),
              ...last === undefined ? {} : { evidence: last.callId },
            })
            return { checked: true }
          })
        }
        runJspace(() => {
          ctx.jspace.checkpoint(agent.session, {
            check: synthesizedCharterCheck(card.charter),
            by: synthesizedCharterBy(checkCount),
            ...last === undefined ? {} : { evidence: last.callId },
          })
        })
      } else if (args.check === undefined || args.by === undefined) {
        throw new Error('jspace_checkpoint requires `check` and `by` when no charter is registered.')
      }
      return runJspace(() => {
        ctx.jspace.checkpoint(agent.session, {
          check: args.check as string,
          by: args.by as string,
          ...args.evidence === undefined ? {} : { evidence: args.evidence },
        })
        return { checked: true }
      })
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
    async execute(args, exec) {
      const agent = requireAgent(exec, 'jspace_ship')
      const session = agent.session
      const card = ctx.jspace.card(session)
      const refusal = shipRefusal(card, session.events, {
        requireVerifiedEvidence: ctx.jspace.config.requireVerifiedEvidence === true,
        requireCore: config.requireCoreForShip,
        requireCharter: config.requireCharter,
      })
      if (refusal !== undefined) throw new Error(refusal)
      if (card !== null && card.charter.length > 0) {
        await runCharter(ctx, exec, card.charter, 'ship', config)
      }
      return args.path === undefined ? { shipped: true } : { shipped: true, path: args.path }
    },
    presentCall: args => present('Ship J-Space', args.path),
  }))

  const disposeAmend = ctx.tools.register(defineTool({
    name: 'jspace_charter_amend',
    description: AMEND_DESCRIPTION,
    parameters: {
      drop: { type: 'array', items: { type: 'string' }, description: 'Entry ids to remove.' },
      add: { type: 'array', items: AMEND_CHARTER_ITEMS, description: 'Entries to append after drops and replaces.' },
      replace: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Existing entry id to replace.' },
            entry: { required: true, ...AMEND_CHARTER_ITEMS },
          },
        },
        description: 'Replace an existing id with a new check or prose entry.',
      },
    },
    output: {
      schema: AMENDED,
      render: () => [{ type: 'text', text: ACK.amended }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec, 'jspace_charter_amend')
      const current = ctx.jspace.card(agent.session)
      if (current === null) throw new Error('jspace card is not open')
      const plan = planCharterAmend(
        current.charter,
        args.drop,
        args.replace as Parameters<typeof planCharterAmend>[2],
        args.add as readonly CharterToolItem[] | undefined,
      )
      const cap = refuseCharterCap(plan.kept.length + plan.added.length, config.maxCharterEntries)
      if (cap !== undefined) throw new Error(cap)
      const foldedNew = await foldCharterEntries(ctx, exec, plan.added, config)
      const next: JspaceCharterEntry[] = [...plan.kept, ...foldedNew]
      if (config.requireExecutableCharter && !hasExecutableCharter(next, config.charterDiscrimination)) {
        throw new Error(OPEN_REQUIRES_EXECUTABLE_CHARTER)
      }
      runJspace(() => {
        ctx.jspace.amendCharter(agent.session, next)
      })
      agent.session.append('jspace/charter-amend', {
        dropped: plan.dropped,
        added: foldedNew.map(entry => entry.id),
        replaced: plan.replaced,
      }, { ignorable: true })
      return { amended: true }
    },
    presentCall: () => present('Amend charter'),
  }))

  return () => {
    disposeOpen()
    disposeNote()
    disposeCheckpoint()
    disposeShip()
    disposeAmend()
  }
}

/**
 * Write a `jspace/charter-proposal` from claimed human user text, once per session.
 * @param session - live session.
 * @param messages - claimed step messages (the loop has not appended them yet).
 * @param maxCharterEntries - seed cap.
 */
function seedCharterProposal(
  session: Session,
  messages: readonly UserMessage[] | undefined,
  maxCharterEntries: number,
): void {
  if (session.events.some(event => event.type === 'jspace/charter-proposal')) return
  const texts = (messages ?? [])
    .filter(message => message.source.kind === 'user')
    .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text))
  if (texts.length === 0) return
  const extracted = extractCharterProposal(texts.join('\n'), maxCharterEntries)
  if (extracted.entries.length === 0) return
  let sourceSeq = session.seq
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'user/message' && event.data.source.kind === 'user') {
      sourceSeq = event.seq
      break
    }
  }
  session.append('jspace/charter-proposal', {
    entries: extracted.entries,
    sourceSeq,
    truncated: extracted.truncated,
  }, { ignorable: true })
}

/**
 * Remount the five tools while the seat is active, withhold their schemas from
 * a session the seat has not engaged, and refuse a call that arrives anyway.
 * @param ctx - context with tools and jspace.
 * @param config - per-turn note cap, constraint-capture, and charter requirements (default off).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (resolved.requireCharter && ctx.jspace.config.mode === 'always-open') {
    throw new Error('tool-jspace: requireCharter is incompatible with jspace mode always-open')
  }
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
  ctx.systemPrompt.section({
    name: 'jspace:charter-seed-hook',
    order: 43,
    text: (context) => {
      if (!resolved.charterSeed) return ''
      const agent = context.agent
      if (agent === undefined || !ctx.jspace.engaged(agent.session)) return ''
      const card = ctx.jspace.card(agent.session)
      if (card !== null && card.charter.length > 0) return ''
      seedCharterProposal(agent.session, context.messages, resolved.maxCharterEntries)
      return ''
    },
  })
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
  ctx.effect(() => ctx.on('agent/pre-step', async (
    { agent, messages },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (!resolved.charterSeed) return decision
    if (!ctx.jspace.engaged(agent.session)) return decision
    const card = ctx.jspace.card(agent.session)
    if (card !== null && card.charter.length > 0) return decision
    seedCharterProposal(agent.session, messages, resolved.maxCharterEntries)
    return decision
  }, { prepend: true }), 'tool-jspace: charter seed')
}
