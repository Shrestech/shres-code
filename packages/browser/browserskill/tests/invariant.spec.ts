import { Context } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import { describe, expect, it } from 'vitest'
import * as browserSkillInvariant from '../src/invariant.ts'

describe('browserskill invariant companion', () => {
  it('registers the empty installer, survives disposal, and remounts', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(browserSkillInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
    const remounted = ctx.plugin(browserSkillInvariant)
    await expect(remounted.await()).resolves.toBeDefined()
    await remounted.dispose()
    await ctx.fiber.dispose()
  })
})
