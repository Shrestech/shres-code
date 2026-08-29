import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import AgentRegistry, { Inbox } from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import { CallId, LlmAdapter } from '@shres-code/shres-code-llm'
import type { GenerateOptions, StreamChunk } from '@shres-code/shres-code-llm'
import LlmRuntime from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime, { defineTool } from '@shres-code/shres-code-tools'
import FileWikiService from '@shres-code/shres-code-wiki-filesystem'
import * as Companion from '../src/invariant.ts'
import * as librarian from '../src/index.ts'
import {
  frameLibrarianPrompt,
  parseLibrarianProposal,
  resolveLibrarianConfig,
  resolveLibrarianRoute,
  runLibrarianCycle,
} from '../src/index.ts'

class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script
  }
}

class ThrowAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> {
    throw new Error('provider down')
  }
}

class ThrowStringAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> {
    throw 'string-fail'
  }
}

function textScript(text: string, finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    finish,
  ]
}

function stubAgent(ctx: Context, id = 'wiki-lib-agent'): Agent {
  const scope = ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId(id))
  const injected: unknown[] = []
  const value: Agent = {
    id: SessionId(id),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: (message) => { injected.push(message) },
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  Object.assign(value, { injected })
  return value
}

async function boot(script: readonly StreamChunk[], extra: {
  wiki?: object
  librarian?: object
  adapter?: LlmAdapter
} = {}): Promise<{ ctx: Context; dir: string; adapter: LlmAdapter }> {
  const dir = await mkdtemp(join(tmpdir(), 'wiki-lib-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  const adapter = extra.adapter ?? new ScriptAdapter(script)
  ctx.llm.registerAdapter(['wiki-local'], adapter)
  await ctx.plugin(FileWikiService, {
    root: join(dir, 'wiki'),
    watch: false,
    ...extra.wiki,
  })
  await ctx.plugin(librarian, extra.librarian ?? { provider: 'wiki-local', model: 'tiny' })
  return { ctx, dir, adapter }
}

describe('parseLibrarianProposal / resolveLibrarianRoute / resolveLibrarianConfig', () => {
  it('parses fenced JSON and skips junk rows', () => {
    const parsed = parseLibrarianProposal(`
\`\`\`json
{"pages":[{"op":"update","path":"n.md","body":"# N","title":"N","tags":["t"],"contradicts":["x.md"],"superseded_by":"o.md"},{"path":""},1],"log":"note","summary":"ok"}
\`\`\`
`)
    expect(parsed?.pages).toHaveLength(1)
    expect(parsed?.pages[0]).toMatchObject({ op: 'update', path: 'n.md' })
    expect(parsed?.log).toBe('note')
    expect(parseLibrarianProposal('not json')).toBeUndefined()
    expect(parseLibrarianProposal('{')).toBeUndefined()
    expect(parseLibrarianProposal('{]')).toBeUndefined()
    expect(parseLibrarianProposal('{nope}')).toBeUndefined()
    expect(parseLibrarianProposal('[]')).toBeUndefined()
    expect(parseLibrarianProposal('{"pages":1}')).toEqual({ pages: [] })
    expect(parseLibrarianProposal('{"pages":[{"path":"a.md"}]}')?.pages).toEqual([])
    expect(parseLibrarianProposal('{"pages":[{"path":"a.md","body":"b","op":"merge"}]}')?.pages[0]?.op).toBe('merge')
    expect(parseLibrarianProposal('{"pages":[{"path":"p.md","body":"b"}]}')?.pages[0]).toEqual({
      op: 'create', path: 'p.md', body: 'b',
    })
  })

  it('resolves settings then project then plugin, and stays dormant when disabled', () => {
    expect(resolveLibrarianRoute({ enabled: false, roles: { librarian: { provider: 'a', model: 'b' } } }, {}, {}, true))
      .toBeUndefined()
    expect(resolveLibrarianRoute({}, {}, {}, true)).toBeUndefined()
    expect(resolveLibrarianRoute(
      { roles: { librarian: { provider: 's', model: 'sm' } } },
      { roles: { librarian: { provider: 'p', model: 'pm' } } },
      { provider: 'c', model: 'cm' },
      true,
    )).toEqual({ provider: 's', model: 'sm' })
    expect(resolveLibrarianRoute(
      {},
      { roles: { librarian: { provider: 'p', model: 'pm' } } },
      { provider: 'c', model: 'cm' },
      true,
    )).toEqual({ provider: 'p', model: 'pm' })
    expect(resolveLibrarianRoute({}, {}, { provider: 'c', model: 'cm' }, true))
      .toEqual({ provider: 'c', model: 'cm' })
  })

  it('fills defaults and rejects a half pair or non-positive tunables', () => {
    expect(resolveLibrarianConfig()).toMatchObject({ timeoutMs: 30_000, maxLogEvents: 40 })
    expect(() => resolveLibrarianConfig({ provider: 'p' })).toThrow(/together/)
    expect(() => resolveLibrarianConfig({ timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => resolveLibrarianConfig({ maxOutputTokens: 1.5 })).toThrow(/maxOutputTokens/)
    expect(() => resolveLibrarianConfig({ timeoutMs: 3_000_000_000 })).toThrow(/timeoutMs/)
    expect(() => resolveLibrarianConfig({ maxInputBytes: 0 })).toThrow(/maxInputBytes/)
    expect(() => resolveLibrarianConfig({ maxLogEvents: 0 })).toThrow(/maxLogEvents/)
  })
})

describe('runLibrarianCycle', () => {
  it('writes pages and a log from one bound call and logs the request first', async () => {
    const json = JSON.stringify({
      pages: [{
        path: 'pattern.md',
        body: '# Pattern\n\nroot cause + fix',
        title: 'Pattern',
        tags: ['fix'],
        contradicts: ['old.md'],
        superseded_by: 'next.md',
      }],
      log: 'consolidated',
      summary: 'filed pattern.md',
    })
    const { ctx, dir, adapter } = await boot(textScript(json))
    const agent = stubAgent(ctx)
    let loggedBeforeDispatch = false
    const original = adapter.stream.bind(adapter)
    adapter.stream = async function * (options: GenerateOptions) {
      loggedBeforeDispatch = agent.session.events.some(event => event.type === 'wiki/librarian-request')
      yield * original(options)
    }
    const result = await runLibrarianCycle(
      ctx,
      agent.session,
      resolveLibrarianConfig({ provider: 'wiki-local', model: 'tiny' }),
      'wiki-summarize',
      undefined,
      agent,
    )
    expect(loggedBeforeDispatch).toBe(true)
    expect(result.kind).toBe('applied')
    expect(result.paths).toEqual(['pattern.md', expect.stringMatching(/^log\//)])
    expect((adapter as ScriptAdapter).requests[0]?.purpose).toBe('wiki-summarize')
    expect(agent.session.events.some(event => event.type === 'wiki/page' && event.data.op === 'create')).toBe(true)
    const throwing = Object.assign(agent, { inject: () => { throw new Error('gone') } })
    await runLibrarianCycle(
      ctx,
      agent.session,
      resolveLibrarianConfig({ provider: 'wiki-local', model: 'tiny' }),
      'wiki-summarize',
      undefined,
      throwing,
    )
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('skips illegal page paths and blank log bodies', async () => {
    const { ctx, dir } = await boot(textScript(JSON.stringify({
      pages: [{ path: '../no.md', body: 'x' }],
      log: '   ',
    })))
    expect(await runLibrarianCycle(
      ctx,
      ctx.sessions.create(),
      resolveLibrarianConfig({ provider: 'wiki-local', model: 'tiny' }),
    )).toMatchObject({ kind: 'empty' })
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('stays dormant when unbound and when the wiki seat is disabled', async () => {
    const { ctx, dir } = await boot(textScript('{}'), { librarian: {}, wiki: { enabled: true } })
    const session = ctx.sessions.create()
    expect(await runLibrarianCycle(ctx, session, resolveLibrarianConfig({}))).toMatchObject({ kind: 'dormant' })
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
    const off = await boot(textScript('{}'), { wiki: { enabled: false }, librarian: { provider: 'wiki-local', model: 'tiny' } })
    expect(await runLibrarianCycle(off.ctx, off.ctx.sessions.create(), resolveLibrarianConfig({
      provider: 'wiki-local',
      model: 'tiny',
    }))).toMatchObject({ kind: 'dormant' })
    await off.ctx.fiber.dispose()
    await rm(off.dir, { recursive: true, force: true })
  })

  it('records failed, empty, tool-call, and max-tokens cycles', async () => {
    const { ctx, dir } = await boot(textScript('not json'))
    const session = ctx.sessions.create()
    const bound = resolveLibrarianConfig({ provider: 'wiki-local', model: 'tiny' })
    expect(await runLibrarianCycle(ctx, session, bound)).toMatchObject({ kind: 'empty' })
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })

    const tools = await boot([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: CallId('c1'), name: 'x', argumentsDelta: '{}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('c1'), name: 'x', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    expect(await runLibrarianCycle(tools.ctx, tools.ctx.sessions.create(), bound)).toMatchObject({ kind: 'failed' })
    await tools.ctx.fiber.dispose()
    await rm(tools.dir, { recursive: true, force: true })

    const stealthTools = await boot([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('c2'), name: 'x', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(await runLibrarianCycle(stealthTools.ctx, stealthTools.ctx.sessions.create(), bound)).toMatchObject({
      kind: 'failed',
      detail: /text only/,
    })
    await stealthTools.ctx.fiber.dispose()
    await rm(stealthTools.dir, { recursive: true, force: true })

    const maxed = await boot(textScript('x', { type: 'finish', reason: { kind: 'max-tokens' } }))
    expect(await runLibrarianCycle(maxed.ctx, maxed.ctx.sessions.create(), bound)).toMatchObject({ kind: 'failed' })
    await maxed.ctx.fiber.dispose()
    await rm(maxed.dir, { recursive: true, force: true })

    const down = await boot([], { adapter: new ThrowAdapter() })
    expect(await runLibrarianCycle(down.ctx, down.ctx.sessions.create(), bound)).toMatchObject({
      kind: 'failed',
      detail: 'provider down',
    })
    await down.ctx.fiber.dispose()
    await rm(down.dir, { recursive: true, force: true })

    const asString = await boot([], { adapter: new ThrowStringAdapter() })
    expect(await runLibrarianCycle(asString.ctx, asString.ctx.sessions.create(), bound)).toMatchObject({
      kind: 'failed',
      detail: 'string-fail',
    })
    await asString.ctx.fiber.dispose()
    await rm(asString.dir, { recursive: true, force: true })

    const errored = await boot(textScript('x', {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'nope', code: 'ERR' } },
    }))
    expect(await runLibrarianCycle(errored.ctx, errored.ctx.sessions.create(), bound)).toMatchObject({
      kind: 'failed',
      detail: 'nope',
    })
    await errored.ctx.fiber.dispose()
    await rm(errored.dir, { recursive: true, force: true })

    const aborted = await boot(textScript('x', {
      type: 'finish',
      reason: { kind: 'aborted', failure: { message: 'cut', code: 'ABORTED' } },
    }))
    expect(await runLibrarianCycle(aborted.ctx, aborted.ctx.sessions.create(), bound)).toMatchObject({
      kind: 'failed',
      detail: 'cut',
    })
    await aborted.ctx.fiber.dispose()
    await rm(aborted.dir, { recursive: true, force: true })

    const weird = await boot(textScript('x', { type: 'finish', reason: { kind: 'other' } as never }))
    expect(await runLibrarianCycle(weird.ctx, weird.ctx.sessions.create(), bound)).toMatchObject({
      kind: 'failed',
    })
    await weird.ctx.fiber.dispose()
    await rm(weird.dir, { recursive: true, force: true })
  })

  it('refuses an oversize prompt without dispatching', async () => {
    const { ctx, dir, adapter } = await boot(textScript('{}'))
    const session = ctx.sessions.create()
    const result = await runLibrarianCycle(ctx, session, resolveLibrarianConfig({
      provider: 'wiki-local',
      model: 'tiny',
      maxInputBytes: 8,
    }))
    expect(result.kind).toBe('failed')
    expect((adapter as ScriptAdapter).requests).toHaveLength(0)
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('dispatches wiki-extract when asked and frames the current wiki', async () => {
    const { ctx, dir, adapter } = await boot(textScript('{"pages":[]}'))
    const session = ctx.sessions.create()
    await ctx.wiki.writePage(session, { path: 'a.md', body: '# A\n\nsee [a](a.md)' })
    const result = await runLibrarianCycle(
      ctx,
      session,
      resolveLibrarianConfig({ provider: 'wiki-local', model: 'tiny' }),
      'wiki-extract',
    )
    expect(result.kind).toBe('empty')
    expect((adapter as ScriptAdapter).requests[0]?.purpose).toBe('wiki-extract')
    expect(frameLibrarianPrompt([], [], []).includes('Current wiki pages')).toBe(true)
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('wiki-librarian apply without tools', () => {
  it('still disposes and drains', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-lib-notools-'))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['wiki-local'], new ScriptAdapter(textScript('{}')))
    await ctx.plugin(FileWikiService, { root: join(dir, 'wiki'), watch: false })
    await ctx.plugin(librarian, { provider: 'wiki-local', model: 'tiny' })
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('wiki-librarian apply triggers', () => {
  it('runs a cycle after a successful jspace_ship tool result', async () => {
    const json = JSON.stringify({ pages: [{ path: 'from-ship.md', body: '# From ship' }], log: 'shipped' })
    const { ctx, dir } = await boot(textScript(json))
    ctx.tools.register(defineTool({
      name: 'jspace_ship',
      description: 'test ship',
      parameters: {},
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'shipped' }] },
      execute: async () => true,
    }))
    const agent = stubAgent(ctx)
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('ship-1'),
      name: 'jspace_ship',
      arguments: {},
      agent,
    })
    expect(ctx.wiki.hasPage('from-ship.md')).toBe(true)
    ctx.tools.register(defineTool({
      name: 'noop',
      description: 'noop',
      parameters: {},
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => true,
    }))
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('noop-1'),
      name: 'noop',
      arguments: {},
      agent,
    })
    expect(librarian.name).toBe('wiki-librarian')
    expect(librarian.inject).toEqual(['wiki', 'llm'])
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('runs a cycle on session dispose', async () => {
    const json = JSON.stringify({ pages: [{ path: 'from-dispose.md', body: '# From dispose' }] })
    const { ctx, dir } = await boot(textScript(json))
    const agent = stubAgent(ctx)
    ctx.emit('session/disposed', agent.session)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.wiki.hasPage('from-dispose.md')).toBe(true)
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('still runs when jobs.start throws and coalesces a second cycle', async () => {
    const json = JSON.stringify({ pages: [{ path: 'from-job.md', body: '# Job' }] })
    const { ctx, dir } = await boot(textScript(json))
    ctx.provide('jobs', { start: () => { throw new Error('no controller') } })
    ctx.tools.register(defineTool({
      name: 'jspace_ship',
      description: 'test ship',
      parameters: {},
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'shipped' }] },
      execute: async () => true,
    }))
    const agent = stubAgent(ctx)
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('ship-2'),
      name: 'jspace_ship',
      arguments: {},
      agent,
    })
    expect(ctx.wiki.hasPage('from-job.md')).toBe(true)
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('startLibrarianJob', () => {
  it('registers a completed and a failed job outcome', async () => {
    const started: Array<{ run: () => { cancel(): void; done: Promise<unknown> } }> = []
    const jobs = {
      start(spec: { run: () => { cancel(): void; done: Promise<unknown> } }) {
        started.push(spec)
        return 'wiki-librarian-1'
      },
    }
    const agent = { id: 'a' } as unknown as Agent
    librarian.startLibrarianJob(jobs, agent, Promise.resolve({
      kind: 'applied', detail: 'ok', paths: [],
    }))
    librarian.startLibrarianJob(jobs, agent, Promise.reject(new Error('boom')))
    const hooks = started.map(spec => spec.run())
    hooks[0]?.cancel()
    expect(await hooks[0]?.done).toEqual({ status: 'completed' })
    expect(await hooks[1]?.done).toEqual({ status: 'failed', detail: 'boom' })
    expect(librarian.librarianJobErrorDetail(new Error('boom'))).toBe('boom')
    expect(librarian.librarianJobErrorDetail('nope')).toBe('nope')
  })
})

describe('wiki-librarian invariant companion', () => {
  it('registers without a runtime check', async () => {
    const ctx = new Context()
    ctx.provide('invariants', {
      register: (name: string, install: () => void) => {
        expect(name).toBe('@shres-code/shres-code-wiki-librarian')
        install()
        return () => {}
      },
    })
    await Companion.apply(ctx)
  })
})
