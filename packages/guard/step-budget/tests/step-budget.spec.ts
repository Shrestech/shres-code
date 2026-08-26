import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { createUserMessage } from '@shres-code/shres-code-llm'
import { SessionId, type SessionEvent } from '@shres-code/shres-code-session'
import { defineContentToolFixture } from '@shres-code/shres-code-tools'
import type { Agent } from '@shres-code/shres-code-agent'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { mountAgentLoopTestDependencies } from '@shres-code/shres-code-agent-loop-testkit'
import * as StepBudget from '@shres-code/shres-code-step-budget'
import type { Config } from '@shres-code/shres-code-step-budget'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the per-turn step budget: exhaustion ends the turn
 * `blocked` with a durable stop record and a queued notice, the claimed batch
 * survives the stop, a fresh turn gets a fresh budget, and the shipped
 * unlimited default changes nothing — all driven through a real agent loop
 * against a scripted mock adapter (no network).
 */

/** Boot the core spine + the guard; the caller registers adapters and extra listeners. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(StepBudget, config)
  ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'p', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

function prompt(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Every step the loop entered, as `<turn>.<step>` pairs. */
function steps(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'step/start'> => e.type === 'step/start')
    .map(e => `${e.data.turn}.${e.data.step}`)
}

function turnEndings(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'turn/end'> => e.type === 'turn/end')
    .map(e => e.data.reason.kind)
}

function stops(agent: Agent): SessionEvent<'step-budget/exhausted'>['data'][] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'step-budget/exhausted'> => e.type === 'step-budget/exhausted')
    .map(e => e.data)
}

/** Every plugin-sourced context queued or entered for the agent, flattened for terse assertions. */
function notices(agent: Agent): { text: string; source: unknown }[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'agent/inbox/spliced'> => e.type === 'agent/inbox/spliced')
    .flatMap(e => e.data.inserted)
    .filter(message => message.source.kind === 'plugin')
    .map(message => ({
      text: message.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: message.source,
    }))
}

/** A script whose tool calls never conclude, so the turn only ends when something stops it. */
function endlessToolCalls(count: number): MockAdapter {
  return new MockAdapter([
    ...Array.from({ length: count }, (_, i) => toolCallResponse(`c${i}`, 'probe', { i })),
    textResponse('done'),
  ])
}

describe('budget exhaustion', () => {
  it('ends the turn blocked at the first step past the budget', async () => {
    const ctx = await harness({ maxStepsPerTurn: 3 })
    ctx.llm.registerAdapter(['mock'], endlessToolCalls(8))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(steps(agent)).toEqual(['1.1', '1.2', '1.3'])
    expect(turnEndings(agent)).toEqual(['blocked'])
  })

  it('records the stop durably with the turn coordinates and the budget in force', async () => {
    const ctx = await harness({ maxStepsPerTurn: 2 })
    ctx.llm.registerAdapter(['mock'], endlessToolCalls(8))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(stops(agent)).toEqual([{ turn: 1, step: 3, limit: 2 }])
    // Log-only and skippable, so a build without this guard still reads the log.
    const stop = [...agent.session.events].find(e => e.type === 'step-budget/exhausted')
    expect(stop?.ignorable).toBe(true)
    // The stop precedes the loop's own turn ending.
    const ending = [...agent.session.events].find(e => e.type === 'turn/end')
    expect(stop!.seq).toBeLessThan(ending!.seq)
  })

  it('queues one model-facing notice naming the budget', async () => {
    const ctx = await harness({ maxStepsPerTurn: 2 })
    ctx.llm.registerAdapter(['mock'], endlessToolCalls(8))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await waitForIdle(ctx, agent)

    const found = notices(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toBe(
      'Your previous turn stopped after 2 model steps, the most this session allows in one turn. '
      + 'The work is unfinished and nothing was cancelled. '
      + 'Before continuing, state in one or two sentences what is already done and what remains, '
      + 'then take the single most valuable next action instead of redoing earlier steps.',
    )
    expect(found[0]!.source).toEqual({
      kind: 'plugin',
      plugin: 'step-budget',
      form: 'notice',
      summary: 'step budget 2 reached',
    })
  })

  it('delivers the notice to the first step of the next turn', async () => {
    const ctx = await harness({ maxStepsPerTurn: 2 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'probe', { i: 1 }),
      toolCallResponse('c2', 'probe', { i: 2 }),
      textResponse('recovered'),
    ]))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await waitForIdle(ctx, agent)
    prompt(agent, 'carry on')
    await waitForIdle(ctx, agent)

    const entered = [...agent.session.events]
      .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message')
      .filter(e => e.data.source.kind === 'plugin' && e.data.source.plugin === 'step-budget')
    expect(entered).toHaveLength(1)
    expect(turnEndings(agent)).toEqual(['blocked', 'completed'])
    expect(steps(agent)).toEqual(['1.1', '1.2', '2.1'])
  })

  it('returns the claimed batch to the inbox instead of dropping it', async () => {
    const ctx = await harness({ maxStepsPerTurn: 1 })
    // A post-execute context is claimed for the step the budget then refuses.
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      const downstream = await next()
      return {
        ...downstream,
        additionalContexts: [createUserMessage({
          content: [{ type: 'text', text: 'downstream-ctx' }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      }
    })
    ctx.llm.registerAdapter(['mock'], endlessToolCalls(4))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(steps(agent)).toEqual(['1.1'])
    // The context the refused step had already claimed is pending again, ahead
    // of the guard's own notice.
    expect(agent.inbox.nextStep.map(message => message.content
      .map(block => block.type === 'text' ? block.text : '').join(''))).toEqual([
      'downstream-ctx',
      expect.stringContaining('Your previous turn stopped after 1 model steps'),
    ])
  })

  it('gives every turn its own budget', async () => {
    const ctx = await harness({ maxStepsPerTurn: 1 })
    ctx.llm.registerAdapter(['mock'], endlessToolCalls(6))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await waitForIdle(ctx, agent)
    prompt(agent, 'again')
    await waitForIdle(ctx, agent)

    expect(steps(agent)).toEqual(['1.1', '2.1'])
    expect(stops(agent)).toEqual([
      { turn: 1, step: 2, limit: 1 },
      { turn: 2, step: 2, limit: 1 },
    ])
  })

  it('never fires on a turn that finishes inside its budget', async () => {
    const ctx = await harness({ maxStepsPerTurn: 5 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      textResponse('done'),
    ]))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(steps(agent)).toEqual(['1.1', '1.2'])
    expect(stops(agent)).toHaveLength(0)
    expect(turnEndings(agent)).toEqual(['completed'])
  })
})

describe('the unlimited default', () => {
  it('registers no listener and leaves a long turn untouched', async () => {
    const ctx = await harness()
    ctx.llm.registerAdapter(['mock'], endlessToolCalls(6))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(steps(agent)).toEqual(['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7'])
    expect(stops(agent)).toHaveLength(0)
    expect(notices(agent)).toHaveLength(0)
    expect(turnEndings(agent)).toEqual(['completed'])
  })
})

describe('disposal', () => {
  it('stops enforcing once the plugin fiber is disposed', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const fiber = await ctx.plugin(StepBudget, { maxStepsPerTurn: 1 })
    ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'p', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      textResponse('done'),
    ]))
    await fiber.dispose()

    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(steps(agent)).toEqual(['1.1', '1.2'])
    expect(stops(agent)).toHaveLength(0)
  })
})

describe('config validation fails loud', () => {
  async function spine(): Promise<Context> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    return ctx
  }

  it('rejects a negative budget', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(StepBudget, { maxStepsPerTurn: -1 })).rejects.toThrow(/integer >= 0/)
  })

  it('rejects a fractional budget', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(StepBudget, { maxStepsPerTurn: 2.5 })).rejects.toThrow(/integer >= 0/)
  })
})
