import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import * as WhisperInvariant from '../src/invariant.ts'

describe('speech-whisper invariant companion', () => {
  it('removes its registry contribution when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(WhisperInvariant)
    expect(() => {
      ctx.invariants.register('@shres-code/shres-code-speech-whisper', () => {})
    }).toThrow(/already registered/u)
    await fiber.dispose()
    await expect(ctx.plugin(WhisperInvariant).await()).resolves.toBeDefined()
  })
})
