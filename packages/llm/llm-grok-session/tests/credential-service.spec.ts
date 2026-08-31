/**
 * The shared-service path: when the composition also mounts the
 * grok-credential service, the `llm-grok-session` adapter resolves its bearer
 * credential through `ctx.grokCredential.managerFor` instead of the private
 * fallback manager. This is the PR's central claim and is pinned here so the
 * service path cannot silently regress to local credential machinery.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler } from '@shres-code/shres-code-llm'
import GrokCredential from '@shres-code/shres-code-grok-credential'
import * as LlmGrokSession from '../src/index.ts'
import type { Config as GrokSessionConfig } from '../src/config.ts'
import { ENTRY_KEY, entryRaw, farFuture, mockUpstream, textTurn, writeAuthDocument } from './helpers.ts'

let authPath: string | undefined
let upstream: Awaited<ReturnType<typeof mockUpstream>> | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
  authPath = undefined
})

describe('llm-grok-session resolves through the shared credential service', () => {
  it('uses ctx.grokCredential for the bearer credential when the service is mounted', async () => {
    authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(farFuture()) })
    upstream = await mockUpstream(textTurn('hello'))
    const context = new Context()
    ctx = context
    await context.plugin(LlmRuntime)
    await context.plugin(GrokCredential)
    const managerFor = vi.spyOn(context.grokCredential, 'managerFor')
    const pluginConfig: GrokSessionConfig = {
      authPath,
      baseURL: `${upstream.url}/v1`,
    }
    await context.plugin(LlmGrokSession, pluginConfig)

    const assembler = new BlockAssembler()
    for await (const chunk of context.llm.stream({
      provider: 'grok-session',
      model: 'grok-4.6',
      messages: [],
    })) assembler.push(chunk)

    expect(assembler.finish).toMatchObject({ kind: 'stop' })
    expect(upstream.authHeaders[0]).toMatch(/^Bearer /)
    // The adapter took its credential from the shared service, not a fallback.
    expect(managerFor).toHaveBeenCalled()
    managerFor.mockRestore()
  })
})
