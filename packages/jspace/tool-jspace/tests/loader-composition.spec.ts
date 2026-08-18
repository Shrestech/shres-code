import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import type { Agent } from '@shres-code/shres-code-agent'
import { CallId } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import JspaceService from '@shres-code/shres-code-jspace'
import * as ToolJspace from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('tool-jspace real Loader composition through cordis.yml', () => {
  it('registers the four tools when the seat is enabled and opens a card', async () => {
    root = await mkdtemp(join(tmpdir(), 'shres-tool-jspace-loader-'))
    await writeFile(join(root, 'cordis.yml'), [
      "- name: '@shres-code/shres-code-session'",
      "- name: '@shres-code/shres-code-system-prompt'",
      "- name: '@shres-code/shres-code-tools'",
      "- name: '@shres-code/shres-code-jspace'",
      '  config:',
      '    enabled: true',
      "- name: '@shres-code/shres-code-tool-jspace'",
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
      ['@shres-code/shres-code-tools', ToolRuntime],
      ['@shres-code/shres-code-jspace', JspaceService],
      ['@shres-code/shres-code-tool-jspace', ToolJspace],
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

    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining([
      'jspace_open',
      'jspace_note',
      'jspace_checkpoint',
      'jspace_ship',
    ]))

    const session = ctx.sessions.create(SessionId('ws-tool-loader'))
    const agent = { id: session.id, session } as unknown as Agent
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('open'),
      name: 'jspace_open',
      arguments: { goal: 'Ship W3', next: 'Write tests' },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(ctx.jspace.card(session)?.goal).toBe('Ship W3')
  }, 30_000)
})
