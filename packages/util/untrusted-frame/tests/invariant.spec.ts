import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import * as UntrustedFrameInvariant from '../src/invariant.ts'

describe('untrusted-frame invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(UntrustedFrameInvariant)

    expect(() => {
      ctx.invariants.register('@shres-code/shres-code-untrusted-frame', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
