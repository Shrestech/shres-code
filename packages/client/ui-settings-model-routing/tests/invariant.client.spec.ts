import { Context } from '@shres-code/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import * as Invariant from '../src/invariant.ts'

describe('ui-settings-model-routing invariant companion', () => {
  it('registers the package-owned empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(Invariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
