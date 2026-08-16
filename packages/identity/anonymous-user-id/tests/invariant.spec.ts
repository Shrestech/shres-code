import { describe, expect, it } from 'vitest'
import { Context } from '@roos-code/cordis'
import InvariantRegistry from '@roos-code/roos-code-invariants'
import * as UserIdInvariant from '@roos-code/roos-code-anonymous-user-id/invariant'

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(UserIdInvariant).await()).resolves.toBeDefined()
  })
})
