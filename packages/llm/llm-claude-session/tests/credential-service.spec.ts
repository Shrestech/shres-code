/**
 * The shared-service path: when the composition also mounts the
 * claude-credential service, the `llm-claude-session` adapter resolves its
 * bearer credential through `ctx.claudeCredential.managerFor` instead of the
 * private fallback manager; without the service, the local fallback serves the
 * same store.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import ClaudeCredential from '@shres-code/shres-code-claude-credential'
import LlmRuntime, { BlockAssembler } from '@shres-code/shres-code-llm'
import * as LlmClaudeSession from '../src/index.ts'
import type { Config as ClaudeSessionConfig } from '../src/config.ts'
import { accessToken, mockAnthropic, writeCredentialsDocument } from './helpers.ts'

let upstream: Awaited<ReturnType<typeof mockAnthropic>> | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
})

/** Mount the route and record the bearer of one streamed turn. */
async function streamBearer(context: Context): Promise<string | undefined> {
  const assembler = new BlockAssembler()
  for await (const chunk of context.llm.stream({ provider: 'claude-session', model: 'claude-opus-5', messages: [] })) {
    assembler.push(chunk)
  }
  expect(assembler.finish).toEqual({ kind: 'stop' })
  return upstream!.requests[0]?.headers.authorization
}

describe('llm-claude-session credential source', () => {
  it('uses ctx.claudeCredential when the shared service is mounted', async () => {
    const authPath = await writeCredentialsDocument({ accessToken: accessToken('service') })
    upstream = await mockAnthropic()
    const context = new Context()
    ctx = context
    await context.plugin(LlmRuntime)
    await context.plugin(ClaudeCredential)
    const managerFor = vi.spyOn(context.claudeCredential, 'managerFor')

    const pluginConfig: ClaudeSessionConfig = { authPath, useKeychain: false, baseURL: upstream.url }
    await context.plugin(LlmClaudeSession, pluginConfig)

    expect(await streamBearer(context)).toBe(`Bearer ${accessToken('service')}`)
    expect(managerFor).toHaveBeenCalled()
    managerFor.mockRestore()
  })

  it('serves the same store through the local fallback when the service is absent', async () => {
    const authPath = await writeCredentialsDocument({ accessToken: accessToken('fallback') })
    upstream = await mockAnthropic()
    const context = new Context()
    ctx = context
    await context.plugin(LlmRuntime)

    const pluginConfig: ClaudeSessionConfig = { authPath, useKeychain: false, baseURL: upstream.url }
    await context.plugin(LlmClaudeSession, pluginConfig)

    expect(context.get('claudeCredential')).toBeUndefined()
    expect(await streamBearer(context)).toBe(`Bearer ${accessToken('fallback')}`)
  })
})
