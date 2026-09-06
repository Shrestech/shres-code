/**
 * Real-composition guard: LlmRuntime and a configured `llm-codex-session`
 * row boot from a test-only cordis.yml through the actual Loader + Include
 * path, the route serves one stream against a local backend stand-in, and
 * disposal withdraws it. A hand-mounted `ctx.plugin` cannot catch Loader
 * export-shape failures, which is why the shipped posture is booted twice.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import LlmRuntime from '@shres-code/shres-code-llm'
import { BlockAssembler } from '@shres-code/shres-code-llm'
import * as LlmCodexSession from '../src/index.ts'
import { farFuture, mockUpstream, textTurn, tokensRaw, writeAuthDocument } from './helpers.ts'

let root: string | undefined
let context: Context | undefined
let upstream: Awaited<ReturnType<typeof mockUpstream>> | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await upstream?.close()
  upstream = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('llm-codex-session real composition', () => {
  it('boots the configured route from cordis.yml, serves a stream, and disposes', async () => {
    upstream = await mockUpstream(textTurn('hello'))
    const authPath = await writeAuthDocument(tokensRaw(farFuture()))
    root = await mkdtemp(join(tmpdir(), 'codex-session-composition-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm',
      "  name: 'test-llm-service'",
      '- id: llm-codex-session',
      "  name: '@shres-code/shres-code-llm-codex-session'",
      '  config:',
      `    authPath: ${JSON.stringify(authPath)}`,
      `    baseURL: ${JSON.stringify(upstream.url)}`,
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test-llm-service', LlmRuntime],
      ['@shres-code/shres-code-llm-codex-session', LlmCodexSession],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['codex-session'])

    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ provider: 'codex-session', model: 'gpt-6-astra', messages: [] })) {
      assembler.push(chunk)
    }
    const message = assembler.message({ kind: 'model', provider: 'codex-session', model: 'gpt-6-astra' })
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(upstream.paths[0]).toBe('/responses')
    expect(upstream.authHeaders[0]).toMatch(/^Bearer ey/)
    expect(upstream.accountHeaders[0]).toBe('account-1')

    const llm = ctx.llm
    await ctx.fiber.dispose()
    expect(llm.listProviders()).toEqual([])
    context = undefined
  })
})
