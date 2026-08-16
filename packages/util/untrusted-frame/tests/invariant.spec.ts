import { describe, expect, it } from 'vitest'
import { Context } from '@roos-code/cordis'
import InvariantRegistry from '@roos-code/roos-code-invariants'
import * as UntrustedFrameInvariant from '../src/invariant.ts'

describe('untrusted-frame invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(UntrustedFrameInvariant)

    expect(() => {
      ctx.invariants.register('@roos-code/roos-code-untrusted-frame', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
