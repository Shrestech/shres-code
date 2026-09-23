/**
 * The adapter credential path: the resolved access token reaches the outgoing
 * request verbatim, credential failures keep or gain their seam code, the
 * local fallback keys one manager per credential source, and a credential-path
 * change through the settings section reaches the next request without
 * re-registering the route.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler } from '@shres-code/shres-code-llm'
import type { FinishReason } from '@shres-code/shres-code-llm'
import { settingsNamespace } from '@shres-code/shres-code-settings'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import * as LlmClaudeSession from '../src/index.ts'
import type { Config as ClaudeSessionConfig } from '../src/config.ts'
import { accessToken, mockAnthropic, writeCredentialsDocument } from './helpers.ts'

const NS = settingsNamespace('llm-claude-session')

let root: string | undefined
let upstream: Awaited<ReturnType<typeof mockAnthropic>> | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the real plugin over the given composition entry. */
async function boot(config: ClaudeSessionConfig): Promise<Context> {
  const context = new Context()
  ctx = context
  await context.plugin(LlmRuntime)
  await context.plugin(LlmClaudeSession, config)
  return context
}

/** Drive one request through the production assembler. */
async function streamOnce(context: Context): Promise<{ finish: FinishReason }> {
  const assembler = new BlockAssembler()
  for await (const chunk of context.llm.stream({ provider: 'claude-session', model: 'claude-opus-5', messages: [] })) {
    assembler.push(chunk)
  }
  return { finish: assembler.finish }
}

describe('llm-claude-session credential path', () => {
  it('sends the resolved access token verbatim as the OAuth bearer', async () => {
    const authPath = await writeCredentialsDocument({ accessToken: accessToken('verbatim') })
    upstream = await mockAnthropic()
    const context = await boot({ authPath, useKeychain: false, baseURL: upstream.url })

    const result = await streamOnce(context)

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(upstream.requests[0]!.path).toBe('/v1/messages')
    expect(upstream.requests[0]!.headers.authorization).toBe(`Bearer ${accessToken('verbatim')}`)
    // The OAuth marker is what switches pi-ai onto the Claude Code wire.
    expect(upstream.requests[0]!.headers.authorization).toContain('sk-ant-oat01-')
  })

  it('passes an LlmError from the credential engine through unchanged', async () => {
    const authPath = await writeCredentialsDocument()
    await writeFile(authPath, '{ not json')
    upstream = await mockAnthropic()
    const context = await boot({ authPath, useKeychain: false, baseURL: upstream.url })

    const result = await streamOnce(context)

    const finish = result.finish
    expect(finish.kind).toBe('error')
    if (finish.kind !== 'error') return
    expect(finish.failure.code).toBe('MISSING_CREDENTIAL')
    expect(finish.failure.message).toMatch(/is not valid JSON/)
    // Passthrough, not the adapter's own wrap.
    expect(finish.failure.message).not.toMatch(/reading the Claude Code session failed/)
    expect(upstream.requests).toHaveLength(0)
  })

  it('wraps a non-seam credential read failure as MISSING_CREDENTIAL', async () => {
    upstream = await mockAnthropic()
    // A NUL byte fails every stat/read with a non-ENOENT error, which is the
    // branch where the adapter wraps the raw failure itself.
    const context = await boot({ authPath: 'bad\u0000path', useKeychain: false, baseURL: upstream.url })

    const result = await streamOnce(context)

    const finish = result.finish
    expect(finish.kind).toBe('error')
    if (finish.kind !== 'error') return
    expect(finish.failure.code).toBe('MISSING_CREDENTIAL')
    expect(finish.failure.message).toMatch(/^llm-claude-session: reading the Claude Code session failed: /)
    expect(upstream.requests).toHaveLength(0)
  })

  it('keys the local fallback by the credential source, including the keychain store', async () => {
    upstream = await mockAnthropic()
    // A stand-in security-tool path keeps the read off the real login keychain:
    // the exec fails, which the engine reads as an absent item.
    const context = await boot({
      useKeychain: true,
      securityPath: '/nonexistent/security',
      baseURL: upstream.url,
    })

    const result = await streamOnce(context)

    const finish = result.finish
    expect(finish.kind).toBe('error')
    if (finish.kind !== 'error') return
    expect(finish.failure.code).toBe('MISSING_CREDENTIAL')
    expect(finish.failure.message).toContain('the login keychain item "Claude Code-credentials"')
  })

  it('reuses one manager while the credential spec is unchanged', async () => {
    const authPath = await writeCredentialsDocument({ accessToken: accessToken('reused') })
    upstream = await mockAnthropic()
    const context = await boot({ authPath, useKeychain: false, baseURL: upstream.url })

    await streamOnce(context)
    await streamOnce(context)

    expect(upstream.requests).toHaveLength(2)
    expect(upstream.requests[1]!.headers.authorization).toBe(upstream.requests[0]!.headers.authorization)
  })

  it('reads the current section per request: an authPath change reaches the next request', async () => {
    const firstPath = await writeCredentialsDocument({ accessToken: accessToken('first') })
    const secondPath = await writeCredentialsDocument({ accessToken: accessToken('second') })
    upstream = await mockAnthropic()
    root = await mkdtemp(join(tmpdir(), 'claude-session-live-'))
    const context = new Context()
    ctx = context
    await context.plugin(LlmRuntime)
    await context.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
    // The registry binds the adapter instance once; a credential-source change
    // must move the store without touching it.
    const registerAdapter = vi.spyOn(LlmRuntime.prototype, 'registerAdapter')
    await context.plugin(LlmClaudeSession, { authPath: firstPath, useKeychain: false, baseURL: upstream.url })
    expect(registerAdapter).toHaveBeenCalledTimes(1)

    await streamOnce(context)
    expect(upstream.requests[0]!.headers.authorization).toBe(`Bearer ${accessToken('first')}`)

    await context.settings.update(NS, { authPath: secondPath })

    await streamOnce(context)
    expect(upstream.requests[1]!.headers.authorization).toBe(`Bearer ${accessToken('second')}`)
    expect(registerAdapter).toHaveBeenCalledTimes(1)
    expect(context.llm.listProviders().map(provider => provider.id)).toEqual(['claude-session'])
    expect(context.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['claude-session'])
    registerAdapter.mockRestore()
  })
})
