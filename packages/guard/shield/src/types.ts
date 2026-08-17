import type {} from '@shres-code/shres-code-session/types'

/** Why the paid Shield payload is not screening. */
export type ShieldInactiveReason = 'panic' | 'unlicensed' | 'engine-missing' | 'disabled'

/** Outcome of the host-seat entitlement + resolve step. */
export type ShieldReason = 'active' | ShieldInactiveReason

/**
 * Live status the host seat publishes on `ctx.shield`.
 * The brand mark reads `active` to choose the blue-girl / green-shield lockup.
 */
export interface ShieldStatus {
  /** True only when the paid engine applied and is screening. */
  active: boolean
  /** Discriminant for inactivity; `'active'` when screening. */
  reason: ShieldReason
}

/** Where `apply` was loaded from. */
export type ShieldEngineSource = 'env' | 'sibling' | 'package'

/** Minimal `apply` the paid payload must export. */
export interface ShieldEngineApply {
  (
    ctx: unknown,
    config?: Record<string, unknown>,
  ): Promise<{ dispose(): Promise<void> }> | { dispose(): Promise<void> }
}

/** A resolved paid payload. */
export interface ShieldEngine {
  readonly source: ShieldEngineSource
  readonly apply: ShieldEngineApply
  /**
   * Module-level stats reader used when screening is off. `apply` is not
   * invoked; the engine must not register seams for this read.
   */
  readonly snapshot?: (cwd?: string | null) => unknown
}

/** One counter split used both at repo scope and per channel. */
export interface ShieldCounterSplit {
  /** Unique screening events that ran, including allow. */
  screened: number
  /** Observe verdicts, including ask-tier while posture is observe. */
  observed: number
  /** Approvals required, granted or denied. */
  asked: number
  /** Approvals the user granted. */
  askedGranted: number
  /** Approvals the user denied or that fail-closed. */
  askedDenied: number
  /** Deny, reject, fail-closed ask, or enforce replace. */
  blocked: number
}

/** One recent finding shown on the Settings pane. Host only; never a path. */
export interface ShieldFindingSummary {
  /** Epoch milliseconds when the verdict was recorded. */
  at: number
  /** Outcome shown as Blocked / Asked / Observed. */
  verdict: 'observe' | 'ask' | 'deny'
  /** Rule id that fired. */
  rule: string
  /** Screened channel, e.g. `user_message` or `tool_args`. */
  channel: string
  /** First 16 hex chars of the content digest. */
  sha16: string
  /** Registrable host when the finding names one. */
  host?: string
  /** Tool or subtool call id when the finding is on a call. */
  callId?: string
}

/** Per-rule observe/ask/block counts shown as the pane's "what kind of pattern" list. */
export interface ShieldRuleHistogram {
  observed: number
  asked: number
  blocked: number
}

/** Per-repo counters the Settings pane binds. Stats are not settings. */
export interface ShieldRepoStats extends ShieldCounterSplit {
  /** Realpath of the session workspace, or `null` when no cwd is known. */
  cwd: string | null
  /** The same six counters split by channel name. */
  byChannel: Readonly<Record<string, ShieldCounterSplit>>
  /** Histogram of fired rule ids. Overflow past the engine cap lands in `otherRules`. */
  byRule: Readonly<Record<string, ShieldRuleHistogram>>
  /** Combined counts for rule ids that did not fit `byRule`. */
  otherRules: ShieldRuleHistogram
  /** Last 20 decision summaries for this repo. */
  recent: readonly ShieldFindingSummary[]
}

/** Seed-pack freshness the pane can show; omitted until an update exists. */
export interface ShieldDefinitions {
  /** Pack version string from the engine. */
  version: string
  /** Epoch milliseconds of the last successful refresh, or `null`. */
  updatedAt: number | null
  /** True when the pack is older than the engine's stale threshold. */
  stale: boolean
}

/** Host RPC payload for the current session cwd. */
export interface ShieldSnapshot {
  /** Live seat status; `reason` is `'disabled'` when the switch is off. */
  status: ShieldStatus
  /** Last persisted counts for this repo; disable does not wipe them. */
  stats: ShieldRepoStats
  /** Definition stamp when the engine reports one. */
  definitions?: ShieldDefinitions
}

/**
 * One Shield verdict written to the session log. Matches the W1 `decision`
 * body plus optional `turn`/`step` so Trajectory can attach input-path flags.
 * Writers set `ignorable: true` on the envelope. No scanned text.
 */
export interface ShieldDecision {
  /** Outcome shown as Blocked / Asked / Observed. */
  verdict: 'observe' | 'ask' | 'deny'
  /** Rule id that fired. */
  rule: string
  /** W1 reason code for the verdict. */
  reasonCode: string
  /** Screened channel, e.g. `user_message` or `tool_args`. */
  channel: string
  /** First 16 hex chars of the content digest. */
  sha16: string
  /** Registrable host when the finding names one. */
  host?: string
  /** Tool or subtool call id when the finding is on a call. */
  callId?: string
  /** Plugin origin when present. */
  origin?: string
  /** Input-path turn used to match a user or context row. */
  turn?: number
  /** Input-path step used to match steering in a Step group. */
  step?: number
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * One Shield verdict for Trajectory and the reconstructable session log.
     * Log-only and not surface. Writers set `ignorable: true` on the envelope.
     * Carries no scanned text, tool args, or result body.
     */
    'shield/decision': ShieldDecision
  }
}
