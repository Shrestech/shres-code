import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import * as CloudInvariant from '../src/invariant.ts'

describe('speech-openai-compatible invariant companion', () => {
  it('removes its registry contribution when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(CloudInvariant)
    expect(() => {
      ctx.invariants.register('@shres-code/shres-code-speech-openai-compatible', () => {})
    }).toThrow(/already registered/u)
    await fiber.dispose()
    await expect(ctx.plugin(CloudInvariant).await()).resolves.toBeDefined()
  })
})
