import { describe, expect, it } from 'vitest'
import { Context } from '@roos-code/cordis'
import * as GeneralInvariant from '@roos-code/roos-code-client-ui-settings-general/invariant'
import InvariantRegistry from '@roos-code/roos-code-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(GeneralInvariant).await()).resolves.toBeDefined()
  })
})
