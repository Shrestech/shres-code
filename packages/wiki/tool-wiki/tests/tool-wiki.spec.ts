import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CallId } from '@shres-code/shres-code-llm'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import { Session, SessionId } from '@shres-code/shres-code-session'
import type { Agent } from '@shres-code/shres-code-agent'
import FileWikiService from '@shres-code/shres-code-wiki-filesystem'
import * as tool from '../src/index.ts'
import {
  formatLogOutput,
  formatReadOutput,
  formatSearchOutput,
  formatWriteOutput,
} from '../src/index.ts'
import * as Companion from '../src/invariant.ts'

const signal = new AbortController().signal
let calls = 0

function agentWithSession(id = 'wiki-agent'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(enabled = true): Promise<{ ctx: Context; dir: string; toolFiber: { dispose(): Promise<void> } }> {
  const dir = await mkdtemp(join(tmpdir(), 'tool-wiki-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FileWikiService, { root: join(dir, 'wiki'), watch: false, enabled })
  const toolFiber = await ctx.plugin(tool)
  return { ctx, dir, toolFiber }
}

function execute(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('formatters', () => {
  it('renders empty search, failures, and success lines', () => {
    expect(formatSearchOutput({ hits: [] })).toBe('No wiki pages matched.')
    expect(formatSearchOutput({
      hits: [{ path: 'a.md', title: 'A', temperature: 'HOT', score: 1.25, excerpt: 'ex' }],
    })).toMatch(/HOT/)
    expect(formatReadOutput({
      path: 'a.md', title: 'A', body: 'b', temperature: 'HOT', created: 'c', updated: 'u', touched: 't',
    })).toMatch(/path: a.md/)
    expect(formatWriteOutput({ path: 'a.md', status: 'written' })).toMatch(/Wrote/)
    expect(formatWriteOutput({ path: 'a.md', status: 'failed' })).toMatch(/unknown/)
    expect(formatWriteOutput({ path: 'a.md', status: 'failed', reason: 'invalid-path' })).toMatch(/invalid-path/)
    expect(formatLogOutput({ path: 'log/x.md', status: 'appended' })).toMatch(/Appended/)
    expect(formatLogOutput({ path: '', status: 'failed' })).toMatch(/unknown/)
    expect(formatLogOutput({ path: '', status: 'failed', reason: 'disabled' })).toMatch(/disabled/)
  })
})

describe('tool-wiki', () => {
  it('registers four tools while enabled and none while disabled', async () => {
    const on = await setup(true)
    const names = on.ctx.tools.schemas().map(schema => schema.name).sort()
    expect(names).toEqual(['wiki_log', 'wiki_read', 'wiki_search', 'wiki_write'])
    expect(on.ctx.tools.get('wiki_search')?.presentCall?.({ query: 'q' })).toMatchObject({
      title: 'Search wiki: q', kind: 'search',
    })
    expect(on.ctx.tools.get('wiki_read')?.presentCall?.({ path: 'a.md' })).toMatchObject({ kind: 'read' })
    expect(on.ctx.tools.get('wiki_write')?.presentCall?.({ path: 'a.md', body: 'x' })).toMatchObject({ kind: 'edit' })
    expect(on.ctx.tools.get('wiki_log')?.presentCall?.({ body: 'n' })).toMatchObject({ kind: 'edit' })
    await rm(on.dir, { recursive: true, force: true })
    const off = await setup(false)
    expect(off.ctx.tools.schemas().filter(schema => schema.name.startsWith('wiki_'))).toEqual([])
    await rm(off.dir, { recursive: true, force: true })
  })

  it('writes, searches, reads (bumping touched), and logs through a real session', async () => {
    const { ctx, dir } = await setup(true)
    const agent = agentWithSession()
    const written = await execute(ctx, 'wiki_write', { path: 'n.md', body: '# Notes\n\nlanguage models' }, agent)
    expect(written.isError).toBe(false)
    expect(text(written)).toMatch(/Wrote wiki page n.md/)
    const searched = await execute(ctx, 'wiki_search', { query: 'language', limit: 5 }, agent)
    expect(text(searched)).toMatch(/n.md/)
    const empty = await execute(ctx, 'wiki_search', { query: 'zzzz', includeArchive: true }, agent)
    expect(text(empty)).toBe('No wiki pages matched.')
    const read = await execute(ctx, 'wiki_read', { path: 'n.md' }, agent)
    expect(text(read)).toMatch(/Notes/)
    expect(agent.session.events.some(event => event.type === 'wiki/page' && event.data.op === 'touch')).toBe(true)
    const logged = await execute(ctx, 'wiki_log', { body: 'shipped' }, agent)
    expect(text(logged)).toMatch(/Appended wiki log/)
    const blankLog = await execute(ctx, 'wiki_log', { body: '  ' }, agent)
    expect(text(blankLog)).toMatch(/required-field/)
    const bad = await execute(ctx, 'wiki_write', { path: '../x.md', body: 'nope' }, agent)
    expect(text(bad)).toMatch(/invalid-path/)
    const missing = await execute(ctx, 'wiki_read', { path: 'missing.md' }, agent)
    expect(missing.isError).toBe(true)
    await expect(execute(ctx, 'wiki_write', { path: 'a.md', body: 'a' })).resolves.toMatchObject({ isError: true })
    await rm(dir, { recursive: true, force: true })
  })

  it('unregisters tools when the plugin fiber disposes', async () => {
    const { ctx, dir, toolFiber } = await setup(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'wiki_search')).toBe(true)
    await toolFiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'wiki_search')).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  it('accepts optional write fields', async () => {
    const { ctx, dir } = await setup(true)
    const agent = agentWithSession('opt')
    const result = await execute(ctx, 'wiki_write', {
      path: 'p.md',
      body: 'body',
      title: 'T',
      tags: ['a'],
      contradicts: ['q.md'],
      superseded_by: 'r.md',
    }, agent)
    expect(result.isError).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('tool-wiki invariant companion', () => {
  it('registers without a runtime check', async () => {
    const ctx = new Context()
    ctx.provide('invariants', {
      register: (name: string, install: () => void) => {
        expect(name).toBe('@shres-code/shres-code-tool-wiki')
        install()
        return () => {}
      },
    })
    await Companion.apply(ctx)
  })
})
