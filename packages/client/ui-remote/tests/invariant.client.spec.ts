import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import * as RemoteInvariant from '@shres-code/shres-code-client-ui-remote/invariant'
import InvariantRegistry from '@shres-code/shres-code-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(RemoteInvariant).await()).resolves.toBeDefined()
  })

  it('node-half apply is a no-op host placeholder', async () => {
    const { apply } = await import('../src/index.ts')
    apply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })
})
