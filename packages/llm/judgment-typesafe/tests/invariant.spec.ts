import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import * as JudgmentTypesafeInvariant from '../src/invariant.ts'

describe('judgment-typesafe invariant companion', () => {
  it('registers the package name and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const dispose = await JudgmentTypesafeInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(JudgmentTypesafeInvariant)

    expect(() => {
      ctx.invariants.register('@shres-code/shres-code-judgment-typesafe', () => {})
    }).toThrow(/already registered/)
  })
})
