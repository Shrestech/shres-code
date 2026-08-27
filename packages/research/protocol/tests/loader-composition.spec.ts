import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import SessionStore from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import * as Protocol from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('research-protocol real Loader composition through cordis.yml', () => {
  it('mounts the cycle section when enabled and nothing when disabled', async () => {
    root = await mkdtemp(join(tmpdir(), 'shres-research-protocol-loader-'))
    await writeFile(join(root, 'cordis.yml'), [
      "- name: '@shres-code/shres-code-session'",
      "- name: '@shres-code/shres-code-system-prompt'",
      "- name: '@shres-code/shres-code-research-protocol'",
      '  config:',
      '    enabled: true',
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@shres-code/shres-code-session', SessionStore],
      ['@shres-code/shres-code-system-prompt', SystemPrompt],
      ['@shres-code/shres-code-research-protocol', Protocol],
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
      config: { path: pathToFileURL(join(root, 'cordis.yml')).href },
    })
    await ctx.loader.await()

    const assembled = await ctx.systemPrompt.assemble()
    const section = assembled.sections.find(entry => entry.name === Protocol.RESEARCH_PROTOCOL_SECTION_NAME)
    expect(section?.text).toContain('research:protocol')
  }, 30_000)

  it('mounts an empty section when the toggle is off', async () => {
    root = await mkdtemp(join(tmpdir(), 'shres-research-protocol-loader-'))
    await writeFile(join(root, 'cordis.yml'), [
      "- name: '@shres-code/shres-code-session'",
      "- name: '@shres-code/shres-code-system-prompt'",
      "- name: '@shres-code/shres-code-research-protocol'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@shres-code/shres-code-session', SessionStore],
      ['@shres-code/shres-code-system-prompt', SystemPrompt],
      ['@shres-code/shres-code-research-protocol', Protocol],
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
      config: { path: pathToFileURL(join(root, 'cordis.yml')).href },
    })
    await ctx.loader.await()

    const assembled = await ctx.systemPrompt.assemble()
    const section = assembled.sections.find(entry => entry.name === Protocol.RESEARCH_PROTOCOL_SECTION_NAME)
    expect(section?.text ?? '').toBe('')
  }, 30_000)
})
