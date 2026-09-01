/**
 * Pure types of the J-Space card: the one home of the `jspace`
 * projection key and the durable payload vocabulary, free of runtime
 * factories. `CharterEntryId` (type and factory) lives in `charter.ts`.
 *
 * @module @shres-code/shres-code-jspace/types
 */

import type { CallId } from '@shres-code/shres-code-llm/brand'
import type { CharterEntryId } from './charter.ts'

/** Whether a check has been shown to fail a seeded violation. */
export type CharterDiscrimination = 'demonstrated' | 'unverified'

/**
 * Why a check is `unverified`. Omitted when `discrimination` is
 * `demonstrated`.
 */
export type CharterUnverifiedReason =
  | 'discrimination-off'
  | 'policy-denied'
  | 'probe-timeout'
  | 'probe-infeasible'

/** Content-only mutation applied to `failProbe.path` at registration. */
export type CharterFailProbe =
  | { readonly kind: 'insert'; readonly content: string }
  | { readonly kind: 'prepend'; readonly content: string }
  | { readonly kind: 'replace'; readonly from: string; readonly to: string }

/** Model- and seeder-authored check input (no runtime status). */
export interface CharterCheckInput {
  readonly kind: 'check'
  readonly id?: CharterEntryId
  /** Constraint text this command enforces. Reprinted; the command is not a substitute. */
  readonly constraint: string
  /** Foreground bash command. Exit 0 passes; any other exit fails. */
  readonly command: string
  /**
   * Workspace-relative paths or globs the command is declared to read.
   * At least one. Every path must resolve inside session cwd.
   */
  readonly reads: readonly string[]
  /**
   * Content mutation applied to `failProbe.path` that must make `command` fail.
   * Required when tool `charterDiscrimination` is `'required'`.
   */
  readonly failProbe?: {
    readonly path: string
    readonly mutation: CharterFailProbe
  }
}

/** Model- and seeder-authored prose input. */
export interface CharterProseInput {
  readonly kind: 'prose'
  readonly id?: CharterEntryId
  readonly constraint: string
}

/** Model- and seeder-authored input (no runtime status). */
export type CharterEntryInput =
  | CharterCheckInput
  | CharterProseInput

/** Folded check: input plus discrimination status. */
export interface JspaceCharterCheck extends CharterCheckInput {
  readonly kind: 'check'
  readonly id: CharterEntryId
  readonly discrimination: CharterDiscrimination
  /** Why `unverified`, when that marker is set. Omitted when demonstrated. */
  readonly unverifiedReason?: CharterUnverifiedReason
}

/** Folded prose entry. */
export interface JspaceCharterProse {
  readonly kind: 'prose'
  readonly id: CharterEntryId
  readonly constraint: string
}

/** Folded card charter list. Commands stay on the snapshot so checkpoint/ship can re-run. */
export type JspaceCharterEntry =
  | JspaceCharterCheck
  | JspaceCharterProse

/** One append-only Checked line. `verified` is set only for evidence-grade lines. */
export interface JspaceCheckedLine {
  /** Positive number, never reused on this card. */
  readonly n: number
  /** What was claimed checked. */
  readonly check: string
  /** Named verifier and coverage claim. */
  readonly by: string
  /** Optional session `callId` that exists in the log. */
  readonly evidence?: string
  /**
   * Present when `evidence` resolved to a completed non-error call of a
   * configured verifier tool. Reconstructable from this payload; writers omit
   * the field when the line is not evidence-grade.
   */
  readonly verified?: true
}

/** One unsettled question. */
export interface JspaceOpenLine {
  /** The question still open. */
  readonly question: string
  /** What would settle it, when known. */
  readonly settles?: string
}

/** Whole-card snapshot carried by `jspace/card`. */
export interface JspaceCard {
  /** Card sequence; the fold takes the highest native `seq`. */
  readonly seq: number
  /** Session that authored this snapshot. */
  readonly sessionId: string
  /** What done means. */
  readonly goal: string
  /** At most two live items. */
  readonly core: readonly string[]
  /** Append-only checked lines. */
  readonly checked: readonly JspaceCheckedLine[]
  /** Unsettled questions. */
  readonly open: readonly JspaceOpenLine[]
  /** Single next action. Never empty while the card is open. */
  readonly next: string
  /** Session event seq of the mutation that last set `goal`. */
  readonly goalOpenedSeq: number
  /**
   * Standing constraints this work must honor. Missing on older snapshots;
   * the fold defaults the field to `[]`.
   */
  readonly charter: readonly JspaceCharterEntry[]
}

/** Tombstone carried by `jspace/closed`. */
export interface JspaceClosed {
  /** Card sequence of the close. */
  readonly seq: number
  /** Session that authored the close. */
  readonly sessionId: string
}

/** Register-check stamp carried by `jspace/shipped`. Does not close the card. */
export interface JspaceShipped {
  /** Session that authored the stamp. */
  readonly sessionId: string
  /** Goal text at ship time. */
  readonly goal: string
  /** `goalOpenedSeq` of the epoch this stamp settles. */
  readonly goalOpenedSeq: number
}

/** Folded ship stamp for the current Goal epoch. */
export interface JspaceSettled {
  /** Goal text recorded at ship. */
  readonly goal: string
  /** Epoch this stamp belongs to. */
  readonly goalOpenedSeq: number
  /** Session event seq of the `jspace/shipped` event. */
  readonly seq: number
}

/** Folded projection served to the dock and Settings snapshot. */
export interface JspaceProjection {
  /** Current native card, or null when none is open. */
  readonly card: JspaceCard | null
  /** True after a native close with no later native card. */
  readonly closed: boolean
  /**
   * Present when `jspace_ship` passed for the current Goal epoch.
   * Cleared when `goalOpenedSeq` advances or the card closes.
   */
  readonly settled?: JspaceSettled
  /** Framing or seq fault, when the fold kept the last good snapshot. */
  readonly fault?: string
}

/** Read-only console payload for Settings. */
export interface JspaceSnapshot {
  /** Session cwd when known. */
  readonly cwd: string | null
  /** Whether a native card is open. */
  readonly open: boolean
  /** True after a native close with no later card. */
  readonly closed: boolean
  /** Checked-line count on the current card, or last card before close. */
  readonly checkpoints: number
  /** Fold fault, when the last good snapshot was kept. */
  readonly fault?: string
}

/** Live seat status. */
export interface JspaceStatus {
  /** True only while Settings `enabled` is true. */
  readonly active: boolean
  /** Why the seat is active or not. */
  readonly reason: 'active' | 'disabled'
}

declare module '@shres-code/shres-code-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's native J-Space card, or `null` before the first open
     * and after a close tombstone. Inherited parent-seed events are not this
     * value; copy-on-fork writes a native snapshot first.
     */
    jspace: JspaceProjection
  }
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * Whole J-Space card. Log-only. Writers pass `{ ignorable: true }`.
     * @param seq - monotonic card sequence for this session.
     * @param sessionId - writing session id.
     * @param goal - done-means line.
     * @param core - at most two live items.
     * @param checked - append-only checked lines; a line may carry `verified`.
     * @param open - unsettled questions.
     * @param next - single next action.
     * @param goalOpenedSeq - session event seq that last set `goal`.
     * @param charter - standing constraints; empty when none are registered.
     */
    'jspace/card': JspaceCard
    /**
     * J-Space close tombstone. Log-only. Writers pass `{ ignorable: true }`.
     * @param seq - monotonic card sequence for this session.
     * @param sessionId - writing session id.
     */
    'jspace/closed': JspaceClosed
    /**
     * Goal-epoch ship stamp. Log-only. Writers pass `{ ignorable: true }`.
     * Does not close the card.
     * @param sessionId - writing session id.
     * @param goal - Goal text at ship time.
     * @param goalOpenedSeq - epoch this stamp settles.
     */
    'jspace/shipped': JspaceShipped
    /**
     * Harness-authored charter proposal extracted from the first human user
     * message. Log-only. Writers pass `{ ignorable: true }`.
     * @param entries - proposed inputs (check or prose), with ids assigned.
     * @param sourceSeq - session seq of the `user/message` that was parsed.
     * @param truncated - true when items were dropped at `maxCharterEntries`.
     */
    'jspace/charter-proposal': {
      entries: readonly CharterEntryInput[]
      sourceSeq: number
      truncated: boolean
    }
    /**
     * One nested bash execution of a registered check (checkpoint, ship, or
     * registration probe). Log-only. Writers pass `{ ignorable: true }`.
     * @param entryId - branded charter entry id.
     * @param callId - nested CallId (`<parent>:charter:<entryId>`).
     * @param parentCallId - the jspace_* call that dispatched this run.
     * @param phase - why it ran.
     * @param command - command actually dispatched.
     * @param passed - true only for foreground exit 0.
     * @param exitCode - bash exit, when the tool returned foreground output.
     * @param deniedReason - tools/pre-execute deny text, when denied.
     * @param timedOut - bash timedOut bit.
     * @param outputPreview - bounded stdout+stderr (max 2KiB).
     * @param readsFingerprint - optional stat snapshot of expanded reads.
     */
    'jspace/charter-run': {
      entryId: CharterEntryId
      callId: CallId
      parentCallId: CallId
      phase: 'checkpoint' | 'ship' | 'probe'
      command: string
      passed: boolean
      exitCode?: number | null
      deniedReason?: string
      timedOut?: boolean
      outputPreview: string
      readsFingerprint?: readonly { path: string; mtimeMs: number; size: number }[]
    }
    /**
     * Discrimination probe: mutation applied, command outcome, restore done.
     * Log-only. Writers pass `{ ignorable: true }`.
     * @param entryId - charter entry id.
     * @param callId - nested CallId of the probe bash.
     * @param path - failProbe.path.
     * @param mutationKind - insert, prepend, or replace.
     * @param demonstrated - true when the command failed after mutation.
     * @param unverifiedReason - set when not demonstrated.
     */
    'jspace/charter-probe': {
      entryId: CharterEntryId
      callId: CallId
      path: string
      mutationKind: CharterFailProbe['kind']
      demonstrated: boolean
      unverifiedReason?: CharterUnverifiedReason
    }
    /**
     * Charter list replaced via jspace_charter_amend. Log-only. Writers pass
     * `{ ignorable: true }`. The following `jspace/card` snapshot is authoritative.
     * @param dropped - ids removed.
     * @param added - ids added.
     * @param replaced - ids replaced.
     */
    'jspace/charter-amend': {
      dropped: readonly CharterEntryId[]
      added: readonly CharterEntryId[]
      replaced: readonly CharterEntryId[]
    }
  }
}
