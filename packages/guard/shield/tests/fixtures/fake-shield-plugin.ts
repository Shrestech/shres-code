/**
 * Test double for `@shres-shield/plugin`. `SHRES_SHIELD_MODULE` points here.
 */

export const applied: { count: number; config: unknown; disposed: number } = {
  count: 0,
  config: undefined,
  disposed: 0,
}

/**
 * Record apply and return a disposer the seat must register.
 * @param _ctx - unused host context.
 * @param config - forwarded seat config.
 * @returns a plugin instance whose dispose increments {@link applied.disposed}.
 */
export async function apply(_ctx: unknown, config: unknown): Promise<{ dispose(): Promise<void> }> {
  applied.count += 1
  applied.config = config
  return {
    dispose: async () => {
      applied.disposed += 1
    },
  }
}
