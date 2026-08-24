/**
 * Proves PR #37: opening a different Goal resets Core and Checked on the folded
 * card (read from the session event log, not tool return values) and re-gates
 * jspace_ship, while re-opening the same Goal only updates Goal/Next with no
 * reset. Keyless: always runs, no model, no API key.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import { CallId } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import type { ToolExecutionResult } from '@shres-code/shres-code-tools'
import JspaceService from '@shres-code/shres-code-jspace'
import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
}

/** Build a minimal agent whose session is the jspace card owner. */
function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return { id: session.id, session } as unknown as Agent
}

/** Mount the jspace seat plus tool-jspace exactly as the unit spec does. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(JspaceService, { enabled: true })
  const fiber = await ctx.plugin(tool)
  return { ctx, agent: stubAgent(ctx, `ws-e2e-${Math.random()}`), fiber }
}

/** Run one jspace tool call against the mounted context. */
async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent: Agent,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    agent,
  })
}

/** Concatenate the text blocks of a tool result. */
function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * The folded card state carried by the last `jspace/card` session event.
 * @returns The whole-card snapshot data, or throws if no card event was logged.
 */
function foldedCard(agent: Agent): Record<string, unknown> {
  const cards = agent.session.events.filter(event => event.type === 'jspace/card')
  const last = cards[cards.length - 1]
  if (last === undefined) throw new Error('no jspace/card event in the session log')
  return last.data as Record<string, unknown>
}

describe('jspace goal-epoch reset (e2e)', () => {
  it('resets Core and Checked on a different-Goal open and re-gates ship, but not on a same-Goal open', async () => {
    const { ctx, agent } = await harness()

    await execute(ctx, 'jspace_open', { goal: 'G1', next: 'B', core: ['one'] }, agent)
    await execute(ctx, 'jspace_note', { core: 'two' }, agent)
    await execute(ctx, 'jspace_checkpoint', { check: 'c1', by: 'e2e verifier' }, agent)
    const shipped = await execute(ctx, 'jspace_ship', {}, agent)
    expect(shipped.isError).toBe(false)

    // A different Goal resets Core and Checked on the folded card in the log.
    await execute(ctx, 'jspace_open', { goal: 'D1', next: 'Start' }, agent)
    const reset = foldedCard(agent)
    expect(reset.goal).toBe('D1')
    expect(reset.core).toEqual([])
    expect(reset.checked).toEqual([])

    // Ship is re-gated until a checkpoint under the new Goal.
    const stale = await execute(ctx, 'jspace_ship', {}, agent)
    expect(stale.isError).toBe(true)
    expect(text(stale)).toContain('checkpoint for the current Goal')

    await execute(ctx, 'jspace_checkpoint', { check: 'd1', by: 'e2e verifier' }, agent)
    const pass = await execute(ctx, 'jspace_ship', {}, agent)
    expect(pass.isError).toBe(false)

    // Re-opening the same Goal updates Goal/Next with no reset of Core/Checked.
    await execute(ctx, 'jspace_open', { goal: 'D1', next: 'Next step' }, agent)
    const same = foldedCard(agent)
    expect(same.goal).toBe('D1')
    expect(same.next).toBe('Next step')
    expect(same.core).toEqual([])
    expect(same.checked).toEqual([{ n: 1, check: 'd1', by: 'e2e verifier' }])
  })
})
