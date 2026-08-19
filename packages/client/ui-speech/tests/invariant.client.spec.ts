// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import * as SpeechUiInvariant from '../src/invariant.ts'

describe('ui-speech invariant companion', () => {
  it('removes its registry contribution when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(SpeechUiInvariant)
    expect(() => {
      ctx.invariants.register('@shres-code/shres-code-client-ui-speech', () => {})
    }).toThrow(/already registered/u)
    await fiber.dispose()
    await expect(ctx.plugin(SpeechUiInvariant).await()).resolves.toBeDefined()
  })
})
