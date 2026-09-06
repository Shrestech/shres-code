/**
 * The shared-service path: when the composition also mounts the
 * codex-credential service, the `llm-codex-session` adapter resolves its
 * bearer credential through `ctx.codexCredential.managerFor` instead of the
 * private fallback manager. This is the PR's central claim and is pinned
 * here so the service path cannot silently regress to local credential
 * machinery.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler } from '@shres-code/shres-code-llm'
import CodexCredential from '@shres-code/shres-code-codex-credential'
import * as LlmCodexSession from '../src/index.ts'
import type { Config as CodexSessionConfig } from '../src/config.ts'
import { farFuture, mockUpstream, textTurn, tokensRaw, writeAuthDocument } from './helpers.ts'

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

describe('llm-codex-session resolves through the shared credential service', () => {
  it('uses ctx.codexCredential for the bearer credential when the service is mounted', async () => {
    authPath = await writeAuthDocument(tokensRaw(farFuture()))
    upstream = await mockUpstream(textTurn('hello'))
    const context = new Context()
    ctx = context
    await context.plugin(LlmRuntime)
    await context.plugin(CodexCredential)
    const managerFor = vi.spyOn(context.codexCredential, 'managerFor')
    const pluginConfig: CodexSessionConfig = {
      authPath,
      baseURL: upstream.url,
    }
    await context.plugin(LlmCodexSession, pluginConfig)

    const assembler = new BlockAssembler()
    for await (const chunk of context.llm.stream({
      provider: 'codex-session',
      model: 'gpt-6-astra',
      messages: [],
    })) assembler.push(chunk)

    expect(assembler.finish).toMatchObject({ kind: 'stop' })
    expect(upstream.authHeaders[0]).toMatch(/^Bearer /)
    expect(upstream.accountHeaders[0]).toBe('account-1')
    // The adapter took its credential from the shared service, not a fallback.
    expect(managerFor).toHaveBeenCalled()
    managerFor.mockRestore()
  })
})
