/**
 * The ctx.claudeCredential service: one shared, memoized session manager per
 * credential spec, a fresh manager for every changed fact, and the service
 * withdrawn with its fiber.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import ClaudeCredential from '../src/index.ts'
import type { ClaudeSessionOptions } from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** Boot the service alone over a throwaway context. */
async function boot(): Promise<ClaudeCredential> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(ClaudeCredential)
  return ctx.claudeCredential
}

/** A credential spec without reader hooks; never resolves a token here. */
function spec(ref: Partial<ClaudeSessionOptions> = {}): ClaudeSessionOptions {
  return {
    useKeychain: true,
    securityPath: '/usr/bin/security',
    authPath: '/tmp/claude/.credentials.json',
    keychainAccount: 'claude-user',
    refreshLeewayMs: 300_000,
    ...ref,
  }
}

describe('claudeCredential service', () => {
  it('shares one manager for the same credential spec', async () => {
    const service = await boot()
    expect(service.managerFor(spec())).toBe(service.managerFor(spec()))
  })

  it('builds a new manager for every changed credential fact', async () => {
    const service = await boot()
    expect(service.managerFor(spec())).not.toBe(service.managerFor(spec({ useKeychain: false })))
    expect(service.managerFor(spec())).not.toBe(service.managerFor(spec({ securityPath: '/other/security' })))
    expect(service.managerFor(spec())).not.toBe(service.managerFor(spec({ authPath: '/other/.credentials.json' })))
    expect(service.managerFor(spec())).not.toBe(service.managerFor(spec({ keychainAccount: 'other-user' })))
    expect(service.managerFor(spec())).not.toBe(service.managerFor(spec({ refreshLeewayMs: 5_000 })))
  })

  it('withdraws the service with its fiber', async () => {
    const ctx = new Context()
    context = ctx
    const fiber = await ctx.plugin(ClaudeCredential)
    expect(ctx.get('claudeCredential')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('claudeCredential')).toBeUndefined()
  })
})
