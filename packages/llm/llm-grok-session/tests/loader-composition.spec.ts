/**
 * Real-composition guard: LlmRuntime and a configured `llm-grok-session` row
 * boot from a test-only cordis.yml through the actual Loader + Include path,
 * the route serves one stream against a local proxy stand-in, and disposal
 * withdraws it. A hand-mounted `ctx.plugin` cannot catch Loader export-shape
 * failures, which is why the shipped posture is booted twice.
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
import * as LlmGrokSession from '../src/index.ts'
import { ENTRY_KEY, entryRaw, farFuture, mockUpstream, textTurn, writeAuthDocument } from './helpers.ts'

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

describe('llm-grok-session real composition', () => {
  it('boots the configured route from cordis.yml, serves a stream, and disposes', async () => {
    upstream = await mockUpstream(textTurn('hello'))
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(farFuture()) })
    root = await mkdtemp(join(tmpdir(), 'grok-session-composition-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm',
      "  name: 'test-llm-service'",
      '- id: llm-grok-session',
      "  name: '@shres-code/shres-code-llm-grok-session'",
      '  config:',
      `    authPath: ${JSON.stringify(authPath)}`,
      `    baseURL: ${JSON.stringify(`${upstream.url}/v1`)}`,
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test-llm-service', LlmRuntime],
      ['@shres-code/shres-code-llm-grok-session', LlmGrokSession],
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

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['grok-session'])

    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ provider: 'grok-session', model: 'grok-4.6', messages: [] })) {
      assembler.push(chunk)
    }
    const message = assembler.message({ kind: 'model', provider: 'grok-session', model: 'grok-4.6' })
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(upstream.paths[0]).toBe('/v1/responses')
    expect(upstream.authHeaders[0]).toMatch(/^Bearer ey/)

    const llm = ctx.llm
    await ctx.fiber.dispose()
    expect(llm.listProviders()).toEqual([])
    context = undefined
  })
})
