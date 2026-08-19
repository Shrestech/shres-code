import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import * as KokoroInvariant from '../src/invariant.ts'

describe('speech-kokoro invariant companion', () => {
  it('removes its registry contribution when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(KokoroInvariant)
    expect(() => {
      ctx.invariants.register('@shres-code/shres-code-speech-kokoro', () => {})
    }).toThrow(/already registered/u)
    await fiber.dispose()
    await expect(ctx.plugin(KokoroInvariant).await()).resolves.toBeDefined()
  })
})
