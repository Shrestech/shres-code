import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import JspaceService from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('jspace loader composition', () => {
  it('honors enabled from a Loader-booted cordis.yml', async () => {
    root = await mkdtemp(join(tmpdir(), 'shres-jspace-loader-'))
    await writeFile(join(root, 'cordis.yml'), [
      "- name: '@shres-code/shres-code-session'",
      "- name: '@shres-code/shres-code-jspace'",
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
      ['@shres-code/shres-code-jspace', JspaceService],
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
    expect(ctx.jspace.status.active).toBe(true)
    const session = ctx.sessions.create(SessionId('ws-loader'))
    expect(ctx.jspace.open(session, { goal: 'A', next: 'B' }).goal).toBe('A')
  })
})
