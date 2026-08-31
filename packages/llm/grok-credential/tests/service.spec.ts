/**
 * The `ctx.grokCredential` service: one shared, memoized session manager per
 * credential spec, a fresh manager for a changed spec.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import GrokCredential from '../src/index.ts'
import type { GrokSessionOptions } from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** Boot the service alone over a throwaway context. */
async function boot(): Promise<GrokCredential> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(GrokCredential)
  return ctx.grokCredential
}

/** A credential spec without transport hooks; never resolves a token here. */
function spec(ref: Partial<GrokSessionOptions> = {}): GrokSessionOptions {
  return { authPath: '/tmp/grok/auth.json', refreshLeewayMs: 300_000, ...ref }
}

describe('grokCredential service', () => {
  it('shares one manager for the same spec', async () => {
    const service = await boot()
    expect(service.managerFor(spec())).toBe(service.managerFor(spec()))
  })

  it('builds a new manager when the credential facts change', async () => {
    const service = await boot()
    expect(service.managerFor(spec()))
      .not.toBe(service.managerFor(spec({ refreshLeewayMs: 5_000 })))
    expect(service.managerFor(spec()))
      .not.toBe(service.managerFor(spec({ authPath: '/other/grok/auth.json' })))
  })
})
