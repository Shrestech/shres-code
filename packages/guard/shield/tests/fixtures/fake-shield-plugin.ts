/**
 * Test double for `@shres-shield/plugin`. `SHRES_SHIELD_MODULE` points here.
 */

/** Outcome of a seat-ctx service probe matching the real adapter. */
export type ServiceProbe = 'ok' | 'threw' | 'absent'

export const applied: {
  count: number
  config: unknown
  disposed: number
  approvalProbe: ServiceProbe
  jobsProbe: ServiceProbe
  stats: {
    cwd: string | null
    screened: number
    observed: number
    asked: number
    askedGranted: number
    askedDenied: number
    blocked: number
    byChannel: Record<string, never>
    recent: readonly never[]
  }
} = {
  count: 0,
  config: undefined,
  disposed: 0,
  approvalProbe: 'absent',
  jobsProbe: 'absent',
  stats: {
    cwd: '/tmp/shield-fixture',
    screened: 4,
    observed: 1,
    asked: 2,
    askedGranted: 1,
    askedDenied: 1,
    blocked: 1,
    byChannel: {},
    recent: [],
  },
}

/**
 * Read a host service the way the paid adapter does (`ctx.approval`, not
 * `ctx.get`). Cordis throws when the seat fiber did not inject the name.
 * @param ctx - the seat ctx forwarded into `apply`.
 * @param key - service name the adapter probes.
 * @returns `ok` when the property is present, `absent` when undefined, `threw` on inject miss.
 */
function probe(ctx: unknown, key: 'approval' | 'jobs'): ServiceProbe {
  try {
    const value = (ctx as Record<string, unknown> | null)?.[key]
    return value === undefined ? 'absent' : 'ok'
  } catch {
    return 'threw'
  }
}

/**
 * Module-level stats reader. The seat uses this when screening is off so
 * disable/panic can show persisted counts without calling {@link apply}.
 */
export const stats = {
  /**
   * @param cwd - session workspace used as the stats key.
   * @returns the fixture counters, rebound to `cwd` when one is supplied.
   */
  snapshot(cwd?: string | null): typeof applied.stats {
    return cwd === undefined || cwd === null
      ? applied.stats
      : { ...applied.stats, cwd }
  },
}

/**
 * Record apply and return a disposer the seat must register.
 * @param ctx - host context the seat forwards into the paid payload.
 * @param config - forwarded seat config.
 * @returns a plugin instance whose dispose increments {@link applied.disposed}.
 */
export async function apply(ctx: unknown, config: unknown): Promise<{
  dispose(): Promise<void>
  stats: typeof stats
}> {
  applied.count += 1
  applied.config = config
  applied.approvalProbe = probe(ctx, 'approval')
  applied.jobsProbe = probe(ctx, 'jobs')
  return {
    stats,
    dispose: async () => {
      applied.disposed += 1
    },
  }
}
