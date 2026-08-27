/**
 * Keyless: requireCoreOnOpen refuses a card that carries no constraint, and
 * requireCoreForShip refuses a ship whose Core the epoch reset emptied.
 * No model, no API key.
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
import { OPEN_REQUIRES_CORE } from '../src/open.ts'
import { SHIP_REQUIRES_CORE } from '../src/ship.ts'

const testToolSignal = new AbortController().signal

const HOUSE_RULE = 'SKUs stay uppercase; quantities are integers'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
}

/** Build a minimal agent whose session is the jspace card owner. */
function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return { id: session.id, session } as unknown as Agent
}

/** Mount the seat with both constraint-capture requirements on. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(JspaceService, { enabled: true })
  await ctx.plugin(tool, { requireCoreOnOpen: true, requireCoreForShip: true })
  return { ctx, agent: stubAgent(ctx, `ws-e2e-core-${Math.random()}`) }
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

describe('jspace constraint capture (e2e)', () => {
  it('refuses a coreless open, then a ship whose Goal change emptied Core', async () => {
    const { ctx, agent } = await harness()

    const bare = await execute(ctx, 'jspace_open', { goal: 'G1', next: 'Run tests' }, agent)
    expect(bare.isError).toBe(true)
    expect(text(bare)).toContain(OPEN_REQUIRES_CORE)
    expect(agent.session.events.filter(event => event.type === 'jspace/card')).toHaveLength(0)

    const opened = await execute(ctx, 'jspace_open', {
      goal: 'G1',
      next: 'Run tests',
      core: [HOUSE_RULE],
    }, agent)
    expect(opened.isError).toBe(false)
    await execute(ctx, 'jspace_checkpoint', { check: 'tests ran', by: 'e2e verifier' }, agent)
    const shipped = await execute(ctx, 'jspace_ship', {}, agent)
    expect(shipped.isError).toBe(false)

    // A changed Goal opens a new epoch and clears Core, so the next ship must
    // find the constraints written back onto the card.
    await execute(ctx, 'jspace_open', { goal: 'G2', next: 'Fix the bin path' }, agent)
    expect(ctx.jspace.card(agent.session)?.core).toEqual([])
    await execute(ctx, 'jspace_checkpoint', { check: 'tests ran again', by: 'e2e verifier' }, agent)
    const refused = await execute(ctx, 'jspace_ship', {}, agent)
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain(SHIP_REQUIRES_CORE)

    const noted = await execute(ctx, 'jspace_note', { core: HOUSE_RULE }, agent)
    expect(noted.isError).toBe(false)
    const passed = await execute(ctx, 'jspace_ship', {}, agent)
    expect(passed.isError).toBe(false)
  })
})
