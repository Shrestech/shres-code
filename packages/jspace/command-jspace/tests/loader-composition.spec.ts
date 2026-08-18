import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import AgentRegistry, { Inbox } from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import CommandRuntime from '@shres-code/shres-code-commands'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import JspaceService from '@shres-code/shres-code-jspace'
import * as commandJspace from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('command-jspace real Loader composition through cordis.yml', () => {
  it('discovers and executes /j-space through the assembled command plane', async () => {
    root = await mkdtemp(join(tmpdir(), 'shres-command-jspace-loader-'))
    await writeFile(join(root, 'cordis.yml'), [
      "- name: '@shres-code/shres-code-session'",
      "- name: '@shres-code/shres-code-commands'",
      "- name: '@shres-code/shres-code-agent'",
      "- name: '@shres-code/shres-code-jspace'",
      '  config:',
      '    enabled: true',
      "- name: '@shres-code/shres-code-command-jspace'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@shres-code/shres-code-session', SessionStore],
      ['@shres-code/shres-code-commands', CommandRuntime],
      ['@shres-code/shres-code-agent', AgentRegistry],
      ['@shres-code/shres-code-jspace', JspaceService],
      ['@shres-code/shres-code-command-jspace', commandJspace],
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

    const session = ctx.sessions.create(SessionId('ws-command-loader'))
    const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
    const agent: Agent = {
      id: session.id,
      options: {},
      session,
      inbox,
      ctx,
      status: 'idle',
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle() { return Promise.resolve() },
    }
    ctx.agents.register(agent)

    expect(ctx.commands.list(agent)).toContainEqual({
      name: 'j-space',
      description: "open or close this session's J-Space card",
      input: { hint: '[on [<goal> | <next>]|off]' },
    })
    const execution = await ctx.commands.execute(
      agent,
      '/j-space on Ship W3 | Write tests',
      new AbortController().signal,
    )
    if (execution === undefined) throw new Error('Loader composition did not resolve /j-space')
    expect(execution.result).toEqual({ kind: 'success', text: 'Opened J-Space.' })
    expect(ctx.jspace.card(session)?.next).toBe('Write tests')
  }, 30_000)
})
