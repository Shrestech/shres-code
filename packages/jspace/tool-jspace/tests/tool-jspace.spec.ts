import { describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import type { Agent } from '@shres-code/shres-code-agent'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime, { defineTool } from '@shres-code/shres-code-tools'
import type { ToolExecutionResult } from '@shres-code/shres-code-tools'
import JspaceService, { JspaceError } from '@shres-code/shres-code-jspace'
import * as tool from '../src/index.ts'

const TOOL_NAMES = [
  'jspace_open',
  'jspace_note',
  'jspace_checkpoint',
  'jspace_ship',
] as const

const testToolSignal = new AbortController().signal

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
}

function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return { id: session.id, session } as unknown as Agent
}

async function harness(enabled = true): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(JspaceService, { enabled })
  const fiber = await ctx.plugin(tool)
  return { ctx, agent: stubAgent(ctx, `ws-tool-${Math.random()}`), fiber }
}

function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name).filter(name => TOOL_NAMES.includes(name as typeof TOOL_NAMES[number]))
}

async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: Agent,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function attachSettings(ctx: Context, enabled: boolean): Promise<(next: boolean) => void> {
  let current = {
    enabled,
    mode: 'available' as const,
    requireCoverage: true,
    coverageTerms: [] as string[],
  }
  const watchers = new Set<() => void>()
  await ctx.plugin({
    name: 'settings-stub',
    apply: (scope: Context) => {
      scope.provide('settings', {
        register: () => ({
          get: () => current,
          watch: (listener: () => void) => {
            watchers.add(listener)
            return () => { watchers.delete(listener) }
          },
          update: async () => {},
          replace: async () => {},
        }),
      })
    },
  })
  return (next) => {
    current = { ...current, enabled: next }
    for (const listener of watchers) listener()
  }
}

function recordEvidence(agent: Agent, callId: string, isError = false): void {
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(callId),
    name: 'read',
    arguments: '{}',
  })
  agent.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: CallId(callId),
      content: [{ type: 'text', text: isError ? 'boom' : 'ok' }],
      isError,
    }),
  }, { surfaceOp: 'append' })
}

describe('tool-jspace registration', () => {
  it('has the namespace-plugin export shape', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-jspace')
    expect(tool.inject).toEqual(['tools', 'jspace'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(tool)).toBe(tool)
  })

  it('lists the four tools only while the seat is active', async () => {
    const off = await harness(false)
    expect(toolNames(off.ctx)).toEqual([])
    const on = await harness(true)
    expect(toolNames(on.ctx)).toEqual([...TOOL_NAMES])
  })

  it('remounts when settings flip the seat and unregisters on dispose', async () => {
    const test = await harness(false)
    expect(toolNames(test.ctx)).toEqual([])
    const setEnabled = await attachSettings(test.ctx, true)
    expect(toolNames(test.ctx)).toEqual([...TOOL_NAMES])
    setEnabled(true)
    expect(toolNames(test.ctx)).toEqual([...TOOL_NAMES])
    setEnabled(false)
    expect(toolNames(test.ctx)).toEqual([])
    setEnabled(true)
    expect(toolNames(test.ctx)).toEqual([...TOOL_NAMES])
    await test.fiber.dispose()
    expect(toolNames(test.ctx)).toEqual([])
  })

  it('uses args-only generic render intent', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.get('jspace_open')?.presentCall?.({ goal: 'Ship', next: 'Test' }))
      .toEqual({ card: 'generic', title: 'Open J-Space', kind: 'other', rawInput: 'Ship' })
    expect(ctx.tools.get('jspace_note')?.presentCall?.({ next: 'Later' }))
      .toEqual({ card: 'generic', title: 'Update J-Space', kind: 'other', rawInput: { next: 'Later' } })
    expect(ctx.tools.get('jspace_checkpoint')?.presentCall?.({
      check: 'done',
      by: 'unit tests covering the fold',
    })).toEqual({ card: 'generic', title: 'Record checkpoint', kind: 'other', rawInput: 'done' })
    expect(ctx.tools.get('jspace_ship')?.presentCall?.({}))
      .toEqual({ card: 'generic', title: 'Ship J-Space', kind: 'other' })
    expect(ctx.tools.get('jspace_ship')?.presentCall?.({ path: 'notes.md' }))
      .toEqual({ card: 'generic', title: 'Ship J-Space', kind: 'other', rawInput: 'notes.md' })
  })
})

describe('jspace tools', () => {
  it('opens, notes, and rejects a swap without departing', async () => {
    const { ctx, agent } = await harness()
    const opened = await execute(ctx, 'jspace_open', {
      goal: 'Ship W3',
      next: 'Write tests',
      core: ['seat'],
    }, agent)
    expect(opened.isError).toBe(false)
    expect(text(opened)).toBe('Opened J-Space.')
    expect(ctx.jspace.card(agent.session)?.core).toEqual(['seat'])

    const already = await execute(ctx, 'jspace_open', { goal: 'X', next: 'Y' }, agent)
    expect(already.isError).toBe(false)
    expect(text(already)).toBe('Updated J-Space.')
    expect(ctx.jspace.card(agent.session)).toMatchObject({ goal: 'X', next: 'Y', core: ['seat'] })

    const appended = await execute(ctx, 'jspace_note', { core: 'tools' }, agent)
    expect(appended.isError).toBe(false)
    expect(ctx.jspace.card(agent.session)?.core).toEqual(['seat', 'tools'])
    const swap = await execute(ctx, 'jspace_note', { core: 'third' }, agent)
    expect(swap.isError).toBe(true)
    expect(text(swap)).toContain('departing')
    expect(ctx.jspace.card(agent.session)?.core).toEqual(['seat', 'tools'])

    const noted = await execute(ctx, 'jspace_note', {
      departing: 'seat',
      core: 'prompt',
      next: 'Checkpoint',
      open: [{ question: 'Ship path?', settles: 'A register check' }],
    }, agent)
    expect(noted.isError).toBe(false)
    expect(text(noted)).toBe('Updated J-Space.')
    expect(ctx.jspace.card(agent.session)).toMatchObject({
      core: ['prompt', 'tools'],
      next: 'Checkpoint',
      open: [{ question: 'Ship path?', settles: 'A register check' }],
    })
  })

  it('refuses a checkpoint without coverage and writes no Checked line', async () => {
    const { ctx, agent } = await harness()
    await execute(ctx, 'jspace_open', { goal: 'A', next: 'B' }, agent)
    const failed = await execute(ctx, 'jspace_checkpoint', {
      check: 'done',
      by: 'I looked',
    }, agent)
    expect(failed.isError).toBe(true)
    expect(text(failed)).toContain('verifier and coverage')
    expect(ctx.jspace.card(agent.session)?.checked).toEqual([])
  })

  it('rejects unknown evidence and accepts a known tool-call id', async () => {
    const { ctx, agent } = await harness()
    await execute(ctx, 'jspace_open', { goal: 'A', next: 'B' }, agent)
    const unknown = await execute(ctx, 'jspace_checkpoint', {
      check: 'done',
      by: 'unit tests covering the fold',
      evidence: 'missing',
    }, agent)
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toContain('non-error tool call')
    expect(ctx.jspace.card(agent.session)?.checked).toEqual([])

    recordEvidence(agent, 'call-1')
    const known = await execute(ctx, 'jspace_checkpoint', {
      check: 'read the file',
      by: 'unit tests covering the fold',
      evidence: 'call-1',
    }, agent)
    expect(known.isError).toBe(false)
    expect(text(known)).toBe('Recorded checkpoint.')
    expect(ctx.jspace.card(agent.session)?.checked).toEqual([
      { n: 1, check: 'read the file', by: 'unit tests covering the fold', evidence: 'call-1' },
    ])

    recordEvidence(agent, 'call-err', true)
    const errored = await execute(ctx, 'jspace_checkpoint', {
      check: 'ran the command',
      by: 'unit tests covering the fold',
      evidence: 'call-err',
    }, agent)
    expect(errored.isError).toBe(true)
    expect(text(errored)).toContain('non-error tool call')
    expect(ctx.jspace.card(agent.session)?.checked).toHaveLength(1)
  })

  it('ships after a current-Goal checkpoint and fails after a goal change without a new one', async () => {
    const { ctx, agent } = await harness()
    const none = await execute(ctx, 'jspace_ship', {}, agent)
    expect(none.isError).toBe(true)
    expect(text(none)).toContain('not open')

    await execute(ctx, 'jspace_open', { goal: 'A', next: 'B' }, agent)
    const early = await execute(ctx, 'jspace_ship', {}, agent)
    expect(early.isError).toBe(true)
    expect(text(early)).toContain('checkpoint for the current Goal')

    await execute(ctx, 'jspace_checkpoint', {
      check: 'done',
      by: 'unit tests covering the fold',
    }, agent)
    const shipped = await execute(ctx, 'jspace_ship', { path: 'notes.md' }, agent)
    expect(shipped.isError).toBe(false)
    if (shipped.isError) throw new Error('expected ship success')
    expect(shipped.value).toEqual({ shipped: true, path: 'notes.md' })
    expect(text(shipped)).toBe('Ship check passed.')
    expect(ctx.jspace.card(agent.session)).not.toBeNull()

    await execute(ctx, 'jspace_note', { goal: 'B-goal' }, agent)
    const stale = await execute(ctx, 'jspace_ship', {}, agent)
    expect(stale.isError).toBe(true)
    expect(text(stale)).toContain('checkpoint for the current Goal')

    await execute(ctx, 'jspace_checkpoint', {
      check: 'again',
      by: 'unit tests covering the fold',
    }, agent)
    const again = await execute(ctx, 'jspace_ship', {}, agent)
    expect(again.isError).toBe(false)
    if (again.isError) throw new Error('expected ship success')
    expect(again.value).toEqual({ shipped: true })
  })

  it('rejects a non-agent caller and remaps seat errors', async () => {
    const { ctx, agent } = await harness()
    const missing = await execute(ctx, 'jspace_open', { goal: 'A', next: 'B' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('owning agent session')
    expect(await execute(ctx, 'jspace_note', { next: 'C' })).toMatchObject({ isError: true })
    expect(await execute(ctx, 'jspace_checkpoint', {
      check: 'x',
      by: 'unit tests covering the fold',
    })).toMatchObject({ isError: true })
    expect(await execute(ctx, 'jspace_ship', {})).toMatchObject({ isError: true })

    vi.spyOn(ctx.jspace, 'open').mockImplementationOnce(() => {
      throw new JspaceError('jspace core may hold at most two items', 'JSPACE_CORE')
    })
    const mapped = await execute(ctx, 'jspace_open', { goal: 'A', next: 'B' }, agent)
    expect(mapped.isError).toBe(true)
    expect(text(mapped)).toContain('at most two')

    vi.spyOn(ctx.jspace, 'open').mockImplementationOnce(() => {
      throw new Error('unexpected failure')
    })
    const unexpected = await execute(ctx, 'jspace_open', { goal: 'A', next: 'B' }, agent)
    expect(unexpected.isError).toBe(true)
    expect(text(unexpected)).toContain('unexpected failure')
  })

  it('refuses an identical non-card tool call while a card is open', async () => {
    const { ctx, agent } = await harness()
    ctx.tools.register(defineTool({
      name: 'echo',
      description: 'echo',
      parameters: { msg: { type: 'string', required: true, description: 'text' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { echoed: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value.echoed) }],
      },
      execute: args => Promise.resolve({ echoed: String((args as { msg: string }).msg) }),
    }))
    await execute(ctx, 'jspace_open', { goal: 'A', next: 'B' }, agent)
    agent.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('prev-echo'),
      name: 'echo',
      arguments: '{"msg":"hi"}',
    })
    const denied = await execute(ctx, 'echo', { msg: 'hi' }, agent)
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('same arguments within a turn')
    await execute(ctx, 'jspace_note', { next: 'Try another path' }, agent)
    const allowed = await execute(ctx, 'echo', { msg: 'hi' }, agent)
    expect(allowed.isError).toBe(false)
  })

  it('does not refuse repeats when the seat is off', async () => {
    const { ctx, agent } = await harness(false)
    ctx.tools.register(defineTool({
      name: 'echo',
      description: 'echo',
      parameters: { msg: { type: 'string', required: true, description: 'text' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { echoed: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value.echoed) }],
      },
      execute: args => Promise.resolve({ echoed: String((args as { msg: string }).msg) }),
    }))
    agent.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('prev-echo'),
      name: 'echo',
      arguments: '{"msg":"hi"}',
    })
    const allowed = await execute(ctx, 'echo', { msg: 'hi' }, agent)
    expect(allowed.isError).toBe(false)
  })

  it('does not refuse repeats when no card is open', async () => {
    const { ctx, agent } = await harness()
    ctx.tools.register(defineTool({
      name: 'echo',
      description: 'echo',
      parameters: { msg: { type: 'string', required: true, description: 'text' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { echoed: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value.echoed) }],
      },
      execute: args => Promise.resolve({ echoed: String((args as { msg: string }).msg) }),
    }))
    agent.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('prev-echo'),
      name: 'echo',
      arguments: '{"msg":"hi"}',
    })
    const allowed = await execute(ctx, 'echo', { msg: 'hi' }, agent)
    expect(allowed.isError).toBe(false)
    const noAgent = await execute(ctx, 'echo', { msg: 'hi' })
    expect(noAgent.isError).toBe(false)
  })
})
