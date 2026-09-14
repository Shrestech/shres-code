/**
 * The `ctx.cursorCredential` service: one shared, memoized session manager
 * per credential spec, a fresh manager for a changed spec.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import CursorCredential from '../src/index.ts'
import type { CursorSessionOptions } from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** Boot the service alone over a throwaway context. */
async function boot(): Promise<CursorCredential> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(CursorCredential)
  return ctx.cursorCredential
}

/** A credential spec without reader hooks; never resolves a token here. */
function spec(ref: Partial<CursorSessionOptions> = {}): CursorSessionOptions {
  return { securityPath: '/usr/bin/security', authPath: '/tmp/cursor/auth.json', useKeychain: true, ...ref }
}

describe('cursorCredential service', () => {
  it('shares one manager for the same spec', async () => {
    const service = await boot()
    expect(service.managerFor(spec())).toBe(service.managerFor(spec()))
  })

  it('builds a new manager when the credential facts change', async () => {
    const service = await boot()
    expect(service.managerFor(spec())).not.toBe(service.managerFor(spec({ useKeychain: false })))
    expect(service.managerFor(spec())).not.toBe(service.managerFor(spec({ authPath: '/other/auth.json' })))
    expect(service.managerFor(spec())).not.toBe(service.managerFor(spec({ securityPath: '/other/security' })))
  })
})
