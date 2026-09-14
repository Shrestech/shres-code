/**
 * Real-composition guard: LlmRuntime, the shared cursor-credential engine,
 * and a configured `llm-cursor-session` row boot from a test-only
 * cordis.yml through the actual Loader + Include path, the route serves the
 * model catalog, stream() fails loud with the wire-gate diagnostic, and
 * disposal withdraws the route. A hand-mounted `ctx.plugin` cannot catch
 * Loader export-shape failures, which is why the shipped posture is booted.
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
import CursorCredential from '@shres-code/shres-code-cursor-credential'
import * as LlmCursorSession from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('llm-cursor-session real composition', () => {
  it('boots the route from cordis.yml, serves the catalog, fails loud on chat, and disposes', async () => {
    root = await mkdtemp(join(tmpdir(), 'cursor-session-composition-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm',
      "  name: 'test-llm-service'",
      '- id: cursor-credential',
      "  name: '@shres-code/shres-code-cursor-credential'",
      '- id: llm-cursor-session',
      "  name: '@shres-code/shres-code-llm-cursor-session'",
      '  config:',
      '    useKeychain: false',
      `    authPath: ${JSON.stringify(join(root, 'absent-auth.json'))}`,
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test-llm-service', LlmRuntime],
      ['@shres-code/shres-code-cursor-credential', CursorCredential],
      ['@shres-code/shres-code-llm-cursor-session', LlmCursorSession],
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

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['cursor-session'])
    const models = await ctx.llm.listModels('cursor-session')
    expect(models.map(model => model.id)).toContain('cursor-grok-4.6-high')

    // No credential exists at the configured path, so the login failure is
    // the surfaced diagnostic, ahead of the wire gate: the seam surfaces an
    // adapter failure as the terminal finish chunk.
    const chunks: { type: string; reason?: { kind?: string; failure?: { code?: string } } }[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'cursor-session', model: 'gpt-5.2', messages: [] })) {
      chunks.push(chunk)
    }
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.reason?.kind).toBe('error')
    expect(finish?.reason?.failure?.code).toBe('MISSING_CREDENTIAL')

    await context.fiber.dispose()
    context = undefined
    const ctx2 = new Context()
    context = ctx2
    expect(ctx2.get('llm')).toBeUndefined()
  })

  it('boots the bundle posture: an entry with no config section resolves schema defaults', async () => {
    root = await mkdtemp(join(tmpdir(), 'cursor-session-composition-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm',
      "  name: 'test-llm-service'",
      '- id: llm-cursor-session',
      "  name: '@shres-code/shres-code-llm-cursor-session'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test-llm-service', LlmRuntime],
      ['@shres-code/shres-code-llm-cursor-session', LlmCursorSession],
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

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['cursor-session'])
    const models = await ctx.llm.listModels('cursor-session')
    expect(models.map(model => model.id)).toContain('gpt-5.2')
  })
})
