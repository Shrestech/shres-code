import { Context } from '@roos-code/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@roos-code/roos-code-invariants'
import * as PluginsInvariant from '../src/invariant.ts'

describe('ui-settings-plugin-inventory invariant companion', () => {
  it('registers the empty installer and keeps the node half inert', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(PluginsInvariant).await()).resolves.toBeDefined()
    const { apply } = await import('../src/index.ts')
    apply()
    await ctx.fiber.dispose()
  })
})
