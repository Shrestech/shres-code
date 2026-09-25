import { Context } from '@shres-code/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import * as PluginAdminInvariant from '../src/invariant.ts'

describe('plugin-admin invariant companion', () => {
  it('registers the package-owned empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(PluginAdminInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
    await expect(ctx.plugin(PluginAdminInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
