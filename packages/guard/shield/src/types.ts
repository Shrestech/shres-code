import type {} from '@shres-code/shres-code-session/types'

/**
 * Why the paid Shield payload is not screening. `'repo-disabled'` covers the
 * per-repo carve-out: every live session's repo is exempt (mount gate) or the
 * requested repo is exempt while the engine screens others (snapshot view).
 */
export type ShieldInactiveReason =
  | 'panic'
  | 'unlicensed'
  | 'engine-missing'
  | 'disabled'
  | 'repo-disabled'


/** Outcome of the host-seat entitlement + resolve step. */
export type ShieldReason = 'active' | ShieldInactiveReason

/**
 * Live status the host seat publishes on `ctx.shield`.
 * The brand mark reads `active` to choose the blue-girl / green-shield lockup.
 */
export interface ShieldStatus {
  /** True only when the paid engine applied and is screening. */
  active: boolean
  /**
   * Present when npm `latest` outruns the applied payload version: rule
   * coverage may predate newer attack families. Advisory only — screening
   * stays active; update via Settings > Shield. One registry probe per boot;
   * cleared on remount when versions converge. (gapfix incident 2026-08-24:
   * a profile rode 0.1.1 while 0.2.0 shipped the authority-impersonation
   * family and nothing said so in headless runs.)
   */
  stale?: { installed: string | null; latest: string }
  /** Discriminant for inactivity; `'active'` when screening. */
  reason: ShieldReason
}

/** Where `apply` was loaded from. */
export type ShieldEngineSource = 'env' | 'sibling' | 'profile' | 'package'

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
   * Absolute path or package specifier that `import()` loaded. Version
   * lookup walks from an absolute path; a bare specifier yields `null`.
   */
  readonly entry: string
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

/** Why a npm check or install did not proceed. */
export type ShieldUpdateBlocked =
  | 'env-override'
  | 'no-profile'
  | 'registry'
  | 'pnpm'

/**
 * Currently resolved paid payload identity. Omitted from the snapshot when
 * nothing resolved.
 */
export interface ShieldPayloadInfo {
  /** Resolution leg that supplied `apply`. */
  source: ShieldEngineSource
  /**
   * `version` from the resolved `@shrestech/shres-shield-plugin` package.json,
   * or `null` when that file is missing or not that package (env fixtures,
   * a bare specifier with no on-disk package).
   */
  version: string | null
}

/**
 * Result of `checkUpdate` / `applyUpdate`. `applied` is true only after a
 * successful profile install and remount.
 */
export interface ShieldPayloadUpdate {
  /** Always `@shrestech/shres-shield-plugin`. */
  specifier: string
  /** Current resolution leg, or `'none'` when the engine is missing. */
  source: ShieldEngineSource | 'none'
  /** Installed payload version, or `null` when it cannot be read. */
  installed: string | null
  /** `dist-tags.latest` from the npm registry, or `null` on a registry miss. */
  latest: string | null
  /**
   * True when `latest` is a semver string different from `installed` and
   * nothing blocks an install. Env override and missing profile force false.
   */
  available: boolean
  /** True only after `applyUpdate` installed `latest` into the profile. */
  applied: boolean
  /** Present when the check or install cannot proceed. */
  blocked?: ShieldUpdateBlocked
  /** Registry, pnpm, or validation diagnostic; omitted on success. */
  detail?: string
}

/** Host RPC payload for the current session cwd. */
export interface ShieldSnapshot {
  /**
   * Effective status for the requested repo: `'disabled'` when the global
   * switch is off, `'repo-disabled'` when this repo is exempt while the
   * engine screens others.
   */
  status: ShieldStatus
  /** Last persisted counts for this repo; disable does not wipe them. */
  stats: ShieldRepoStats
  /** Definition stamp when the engine reports one. */
  definitions?: ShieldDefinitions
  /** Resolved payload identity when an engine file loaded. */
  payload?: ShieldPayloadInfo
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
