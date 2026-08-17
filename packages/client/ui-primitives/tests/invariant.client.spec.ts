import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import * as PrimitivesInvariant from '@shres-code/shres-code-client-ui-primitives/invariant'
import InvariantRegistry from '@shres-code/shres-code-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(PrimitivesInvariant).await()).resolves.toBeDefined()
  })
})
