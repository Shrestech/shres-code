import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import { CallId } from '@shres-code/shres-code-llm'
import { Session, SessionId } from '@shres-code/shres-code-session'
import AgentRegistry, { Inbox } from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import FileWikiService from '@shres-code/shres-code-wiki-filesystem'
import * as ToolWiki from '@shres-code/shres-code-tool-wiki'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('wiki-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

async function boot(enabled: boolean): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'shres-wiki-loader-'))
  const wikiRoot = join(root, 'wiki')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@shres-code/shres-code-agent'",
    "- name: '@shres-code/shres-code-system-prompt'",
    "- name: '@shres-code/shres-code-tools'",
    "- name: '@shres-code/shres-code-wiki-filesystem'",
    '  config:',
    `    root: ${JSON.stringify(wikiRoot)}`,
    '    watch: false',
    `    enabled: ${String(enabled)}`,
    "- name: '@shres-code/shres-code-tool-wiki'",
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-agent', AgentRegistry],
    ['@shres-code/shres-code-system-prompt', SystemPrompt],
    ['@shres-code/shres-code-tools', ToolRuntime],
    ['@shres-code/shres-code-wiki-filesystem', FileWikiService],
    ['@shres-code/shres-code-tool-wiki', ToolWiki],
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
  return ctx
}

describe('tool-wiki loader composition', () => {
  it('writes a page through the Loader-booted tools and logs wiki/page', async () => {
    const ctx = await boot(true)
    const owner = agent(ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-1'),
      name: 'wiki_write',
      arguments: { path: 'from-loader.md', body: '# Loader\n' },
      agent: owner,
    })
    expect(result.isError).toBe(false)
    expect(owner.session.events.some(event => event.type === 'wiki/page' && event.data.op === 'create')).toBe(true)
  })

  it('exposes no wiki tools when the seat is composed disabled', async () => {
    const ctx = await boot(false)
    expect(ctx.tools.schemas().some(schema => schema.name.startsWith('wiki_'))).toBe(false)
  })
})
