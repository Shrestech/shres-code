import { Context } from '@shres-code/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import * as JSpaceSettingsInvariant from '../src/invariant.ts'

describe('ui-settings-jspace invariant companion', () => {
  it('registers the empty installer and keeps the node half inert', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(JSpaceSettingsInvariant).await()).resolves.toBeDefined()
    const { apply } = await import('../src/index.ts')
    apply()
    await ctx.fiber.dispose()
  })
})
