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
}
