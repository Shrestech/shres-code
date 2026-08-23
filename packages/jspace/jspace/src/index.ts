/**
 * Settings-toggled J-Space seat. Publishes `ctx.jspace`, remounts
 * from the `jspace` settings namespace, and writes logged card events.
 * Prompt and tool consumers remount from {@link JspaceService.status}.
 *
 * @module @shres-code/shres-code-jspace
 */

import { Context, Service } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import type {} from '@shres-code/shres-code-session-projection'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import {
  decodeJspaceCard,
  decodeJspaceClosed,
  foldJspace,
  matchesCoverageTerms,
} from './fold.ts'
import type { JspaceFold } from './fold.ts'
import type {
  JspaceCard,
  JspaceCheckedLine,
  JspaceOpenLine,
  JspaceProjection,
  JspaceSnapshot,
  JspaceStatus,
} from './types.ts'

export type * from './types.ts'
export {
  decodeJspaceCard,
  decodeJspaceClosed,
  foldJspace,
  formatJspaceCard,
  DEFAULT_COVERAGE_TERMS,
  matchesCoverageTerms,
  JSPACE_ALWAYS_OPEN_GOAL,
  JSPACE_ALWAYS_OPEN_NEXT,
  JSPACE_AVAILABLE_LINE,
} from './fold.ts'
export type { JspaceFold } from './fold.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'jspace'

/** Settings namespace the J-Space Settings page writes. */
export const JSPACE_SETTINGS_NAMESPACE = settingsNamespace('jspace')

/** Host-seat config. */
export interface Config {
  /** Master allow. Default false. */
  enabled?: boolean
  /** `available` waits for open; `always-open` is reserved for the prompt Consumer. */
  mode?: 'available' | 'always-open'
  /** Refuse a checkpoint whose `by` names no coverage term. Default true. */
  requireCoverage?: boolean
  /** Extra coverage terms, escaped as literals. */
  coverageTerms?: string[]
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  mode: z.union(['available', 'always-open'] as const).default('available'),
  requireCoverage: z.boolean().default(true),
  coverageTerms: z.array(z.string()).default([]),
})

declare module '@shres-code/cordis' {
  interface Context {
    jspace: JspaceService
  }
}

/** Open a new card. */
export interface OpenJspaceInput {
  /** Done-means line. */
  readonly goal: string
  /** First next action. */
  readonly next: string
  /** Optional live items, at most two. */
  readonly core?: readonly string[]
}

/** Patch an open card. */
export interface NoteJspaceInput {
  /** Replace the goal line. */
  readonly goal?: string
  /** Departing core item, required when `core` is set. */
  readonly departing?: string
  /** Incoming core item, required when `departing` is set. */
  readonly core?: string
  /** Replace the open-question list. */
  readonly open?: readonly JspaceOpenLine[]
  /** Replace Next. */
  readonly next?: string
}

/** Record a Checked line. */
export interface CheckpointJspaceInput {
  /** What was claimed checked. */
  readonly check: string
  /** Verifier and coverage claim. */
  readonly by: string
  /** Optional existing tool-call id. */
  readonly evidence?: string
}

/** Thrown when a mutation cannot be recorded. */
export class JspaceError extends Error {
  /**
   * @param message - human-readable reason.
   * @param code - stable machine code.
   */
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'JspaceError'
  }
}

/** Projection schema for the optional session-projection unit. */
const jspaceProjectionSchema: ZodType<JspaceProjection> = zod.object({
  card: zod.object({
    seq: zod.number().int().positive(),
    sessionId: zod.string().min(1),
    goal: zod.string().min(1),
    core: zod.array(zod.string()),
    checked: zod.array(zod.object({
      n: zod.number().int().positive(),
      check: zod.string().min(1),
      by: zod.string().min(1),
      evidence: zod.string().min(1).optional(),
    })),
    open: zod.array(zod.object({
      question: zod.string().min(1),
      settles: zod.string().min(1).optional(),
    })),
    next: zod.string().min(1),
    goalOpenedSeq: zod.number().int().nonnegative(),
  }).nullable(),
  closed: zod.boolean(),
  fault: zod.string().optional(),
}) as ZodType<JspaceProjection>

/**
 * Trim and reject a blank line.
 * @param value - raw string.
 * @param field - field name.
 * @returns trimmed value.
 */
function line(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new JspaceError(`jspace ${field} must be a non-empty string`, 'JSPACE_EMPTY')
  }
  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    throw new JspaceError(`jspace ${field} must be a single line`, 'JSPACE_EMPTY')
  }
  if (/^(Goal|Core|Checked|Open|Next|Pass):/iu.test(trimmed)) {
    throw new JspaceError(`jspace ${field} cannot start with a card label`, 'JSPACE_EMPTY')
  }
  return trimmed
}

/**
 * J-Space seat (`ctx.jspace`).
 */
export default class JspaceService extends Service {
  static inject = ['sessions']

  static Config = Config

  private readonly entry: Config
  private override: (() => Config) | undefined
  private current: JspaceStatus = { active: false, reason: 'disabled' }
  private readonly listeners = new Set<(status: JspaceStatus) => void>()

  /**
   * @param ctx - Cordis context.
   * @param entry - composition entry; settings overlay it when present.
   */
  constructor(ctx: Context, entry: Config = {}) {
    super(ctx, 'jspace')
    this.entry = entry
    installSettingsSection(ctx, JSPACE_SETTINGS_NAMESPACE, Config, entry, {
      setSource: (current) => { this.override = current },
      onChange: () => { this.sync() },
    })
    this.sync()
    ctx.on('session/created', (session) => { this.copyOnFork(session) }, { global: true })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'jspace', JspaceProjection>({
        key: 'jspace',
        schema: jspaceProjectionSchema,
        init: () => ({ card: null, closed: false }),
        apply: applyJspaceProjection,
        view: state => state,
        stateVersion: 1,
      })
    })
  }

  /**
   * Current seat status.
   * @returns whether consumers should be mounted.
   */
  get status(): JspaceStatus {
    return this.current
  }

  /**
   * Resolved seat config.
   * @returns the current settings-or-entry document.
   */
  get config(): Config {
    return this.override === undefined ? this.entry : this.override()
  }

  /**
   * Subscribe to remount status.
   * @param listener - called with the new status.
   * @returns disposer.
   */
  watch(listener: (status: JspaceStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Fold one session's J-Space events.
   * @param session - session whose log to fold.
   * @returns native projection plus inherited parent card.
   */
  fold(session: Session): JspaceFold {
    return foldJspace(session.events, session.id)
  }

  /**
   * Current native open card, or `null`.
   * @param session - owning session.
   * @returns the card.
   */
  card(session: Session): JspaceCard | null {
    return this.fold(session).card
  }

  /**
   * Settings-console snapshot for one session.
   * @param session - session whose log to fold.
   * @returns open/closed and checkpoint counts. Does not throw when inactive.
   */
  snapshot(session: Session): JspaceSnapshot {
    const folded = this.fold(session)
    return {
      cwd: session.header.cwd ?? null,
      open: folded.card !== null,
      closed: folded.closed,
      checkpoints: folded.card?.checked.length ?? 0,
      ...folded.fault === undefined ? {} : { fault: folded.fault },
    }
  }

  /**
   * Open a card.
   * @param session - owning session.
   * @param input - goal, next, optional core.
   * @returns the recorded card.
   */
  open(session: Session, input: OpenJspaceInput): JspaceCard {
    this.requireActive()
    if (this.card(session) !== null) {
      throw new JspaceError('jspace card is already open', 'JSPACE_ALREADY_OPEN')
    }
    const core = (input.core ?? []).map((item, index) => line(item, `core[${String(index)}]`))
    if (core.length > 2) {
      throw new JspaceError('jspace core may hold at most two items', 'JSPACE_CORE')
    }
    const nextSeq = this.nextSeq(session)
    const card: JspaceCard = {
      seq: nextSeq,
      sessionId: session.id,
      goal: line(input.goal, 'goal'),
      core,
      checked: [],
      open: [],
      next: line(input.next, 'next'),
      goalOpenedSeq: session.seq,
    }
    return this.writeCard(session, card)
  }

  /**
   * Patch an open card.
   * @param session - owning session.
   * @param input - fields to replace.
   * @returns the recorded card.
   */
  note(session: Session, input: NoteJspaceInput): JspaceCard {
    this.requireActive()
    const current = this.requireCard(session)
    let core = [...current.core]
    if (input.core !== undefined || input.departing !== undefined) {
      const incoming = input.core === undefined ? undefined : line(input.core, 'core')
      if (input.departing === undefined) {
        /* v8 ignore next -- unreachable: entering this branch requires core, which defines incoming */
        if (incoming === undefined) {
          throw new JspaceError(
            'jspace core swap requires departing and incoming lines',
            'JSPACE_SWAP',
          )
        }
        if (core.length >= 2) {
          throw new JspaceError(
            'jspace core swap requires departing and incoming lines',
            'JSPACE_SWAP',
          )
        }
        core = [...core, incoming]
      } else {
        if (incoming === undefined) {
          throw new JspaceError(
            'jspace core swap requires departing and incoming lines',
            'JSPACE_SWAP',
          )
        }
        const departing = line(input.departing, 'departing')
        const index = core.indexOf(departing)
        if (index < 0) {
          throw new JspaceError(
            `jspace core does not hold ${JSON.stringify(departing)}`,
            'JSPACE_SWAP',
          )
        }
        core = core.map((item, i) => i === index ? incoming : item)
      }
    }
    const goal = input.goal === undefined ? current.goal : line(input.goal, 'goal')
    const next = input.next === undefined ? current.next : line(input.next, 'next')
    const open = input.open === undefined
      ? current.open
      : input.open.map((item, i) => ({
        question: line(item.question, `open[${String(i)}].question`),
        ...item.settles === undefined ? {} : { settles: line(item.settles, `open[${String(i)}].settles`) },
      }))
    const eventSeq = session.seq
    return this.writeCard(session, {
      seq: this.nextSeq(session),
      sessionId: session.id,
      goal,
      core,
      checked: current.checked,
      open,
      next,
      goalOpenedSeq: goal === current.goal ? current.goalOpenedSeq : eventSeq,
    })
  }

  /**
   * Open a new Goal epoch on an open card, or update Goal and Next in place
   * when the Goal is unchanged. A Goal identity change resets Core and Checked
   * so ship cannot pass on the previous epoch's evidence, and moves the epoch
   * anchor so a fresh checkpoint is required. A same-Goal call is the
   * control-loop update path: Core, Checked, and Open are kept and the anchor
   * is unchanged. Open questions carry over untouched on a new epoch. The
   * optional `core` input applies only on the first open and is ignored here.
   * @param session - owning session.
   * @param input - goal, next, optional core.
   * @returns the recorded card.
   */
  openGoal(session: Session, input: OpenJspaceInput): JspaceCard {
    this.requireActive()
    const current = this.requireCard(session)
    const goal = line(input.goal, 'goal')
    const next = line(input.next, 'next')
    if (goal === current.goal) {
      return this.writeCard(session, {
        ...current,
        seq: this.nextSeq(session),
        sessionId: session.id,
        goal,
        next,
      })
    }
    return this.writeCard(session, {
      seq: this.nextSeq(session),
      sessionId: session.id,
      goal,
      core: [],
      checked: [],
      open: current.open,
      next,
      goalOpenedSeq: session.seq,
    })
  }

  /**
   * Append a Checked line.
   * @param session - owning session.
   * @param input - check, by, optional evidence.
   * @returns the recorded card.
   */
  checkpoint(session: Session, input: CheckpointJspaceInput): JspaceCard {
    this.requireActive()
    const current = this.requireCard(session)
    const check = line(input.check, 'check')
    const by = line(input.by, 'by')
    if (this.config.requireCoverage !== false && !matchesCoverageTerms(by, this.config.coverageTerms)) {
      throw new JspaceError(
        'jspace checkpoint requires a verifier and coverage claim: '
        + 'state in `by` who verified and what they covered, '
        + 'for example "vitest run of fold.spec.ts green; direct read of index.ts lines 360-392"',
        'JSPACE_COVERAGE',
      )
    }
    if (input.evidence !== undefined) {
      this.requireEvidence(session, input.evidence)
    }
    const n = current.checked.reduce((max, item) => Math.max(max, item.n), 0) + 1
    const checked: JspaceCheckedLine = input.evidence === undefined
      ? { n, check, by }
      : { n, check, by, evidence: line(input.evidence, 'evidence') }
    return this.writeCard(session, {
      ...current,
      seq: this.nextSeq(session),
      sessionId: session.id,
      checked: [...current.checked, checked],
    })
  }

  /**
   * Close the card.
   * @param session - owning session.
   */
  close(session: Session): void {
    this.requireActive()
    this.requireCard(session)
    session.append('jspace/closed', {
      seq: this.nextSeq(session),
      sessionId: session.id,
    }, { ignorable: true })
  }

  private sync(): void {
    const enabled = this.config.enabled === true
    const next: JspaceStatus = enabled
      ? { active: true, reason: 'active' }
      : { active: false, reason: 'disabled' }
    const becameActive = enabled && !this.current.active
    this.current = next
    if (becameActive) {
      for (const session of this.ctx.sessions.list()) this.copyOnFork(session)
    }
    for (const listener of this.listeners) listener(next)
  }

  private requireActive(): void {
    if (!this.current.active) {
      throw new JspaceError('jspace is disabled', 'JSPACE_DISABLED')
    }
  }

  private requireCard(session: Session): JspaceCard {
    const card = this.card(session)
    if (card === null) {
      throw new JspaceError('jspace card is not open', 'JSPACE_NO_CARD')
    }
    return card
  }

  private nextSeq(session: Session): number {
    const folded = this.fold(session)
    const native = folded.card?.seq ?? 0
    let last = native
    for (const event of session.events) {
      if (event.type !== 'jspace/closed') continue
      try {
        const closed = decodeJspaceClosed(event.data)
        if (closed.sessionId === session.id) last = Math.max(last, closed.seq)
      } catch (error) {
        // A persisted malformed close cannot contribute a seq; the fold records the fault.
        void error
      }
    }
    return last + 1
  }

  private writeCard(session: Session, card: JspaceCard): JspaceCard {
    session.append('jspace/card', card, { ignorable: true })
    return card
  }

  /**
   * Evidence must name a completed call: the `tool/call` exists and a
   * non-error `tool/result` for it is logged (`isError` rides the
   * tool-result block). Still not proof of coverage.
   * @param session - owning session.
   * @param evidence - claimed tool-call id.
   */
  private requireEvidence(session: Session, evidence: string): void {
    const id = line(evidence, 'evidence')
    const ran = session.events.some(event =>
      event.type === 'tool/call' && event.data.callId === id)
    const succeeded = session.events.some((event) => {
      if (event.type !== 'tool/result') return false
      const message = (event.data as {
        message?: {
          source?: { kind?: string; callId?: string }
          content?: ReadonlyArray<{ type?: string; isError?: boolean }>
        }
      }).message
      const block = message?.content?.find(part => part.type === 'tool-result')
      return message?.source?.kind === 'tool'
        && message.source.callId === id
        && block !== undefined
        && block.isError !== true
    })
    if (!ran || !succeeded) {
      throw new JspaceError(
        `jspace evidence ${JSON.stringify(id)} is not a completed, non-error tool call in this session`,
        'JSPACE_EVIDENCE',
      )
    }
  }

  private copyOnFork(session: Session): void {
    if (!this.current.active) return
    const folded = this.fold(session)
    if (folded.card !== null || folded.inherited === null) return
    const parent = folded.inherited
    this.writeCard(session, {
      ...parent,
      seq: 1,
      sessionId: session.id,
      goalOpenedSeq: session.seq,
    })
  }

}

/**
 * Last-wins projection fold. Malformed events keep the previous snapshot
 * and record `fault`; the write-side invariant rejects them before commit
 * when the companion is mounted.
 * @param state - prior projection.
 * @param event - next committed event.
 * @returns the next projection, or the same reference when the event is unrelated.
 */
export function applyJspaceProjection(
  state: JspaceProjection,
  event: SessionEvent,
): JspaceProjection {
  if (event.type !== 'jspace/card' && event.type !== 'jspace/closed') return state
  try {
    if (event.type === 'jspace/card') {
      return { card: decodeJspaceCard(event.data), closed: false }
    }
    decodeJspaceClosed(event.data)
    return { card: null, closed: true }
  } catch (error) {
    /* v8 ignore next -- decode throws Error */
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, fault: message }
  }
}
