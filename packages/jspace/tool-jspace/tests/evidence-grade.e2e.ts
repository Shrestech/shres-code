/**
 * Keyless: requireVerifiedEvidence refuses ship until a checkpoint cites a
 * completed non-error verifier tool call, then passes. No model, no API key.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import type { ToolExecutionResult } from '@shres-code/shres-code-tools'
import JspaceService from '@shres-code/shres-code-jspace'
import * as tool from '../src/index.ts'
import { SHIP_REQUIRES_VERIFIED_EVIDENCE } from '../src/ship.ts'

const testToolSignal = new AbortController().signal

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
}

/** Build a minimal agent whose session is the jspace card owner. */
function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return { id: session.id, session } as unknown as Agent
}

/** Mount the seat with evidence-grade ship required. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(JspaceService, {
    enabled: true,
    verifierTools: ['bash'],
    requireVerifiedEvidence: true,
  })
  await ctx.plugin(tool)
  return { ctx, agent: stubAgent(ctx, `ws-e2e-evidence-${Math.random()}`) }
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

/** Log a completed non-error `bash` call the checkpoint can cite. */
function recordVerifier(agent: Agent, callId: string): void {
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(callId),
    name: 'bash',
    arguments: '{}',
  })
  agent.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: CallId(callId),
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
}

describe('jspace evidence-grade ship (e2e)', () => {
  it('refuses ship on a keyword checkpoint and passes after a verifier citation', async () => {
    const { ctx, agent } = await harness()

    await execute(ctx, 'jspace_open', { goal: 'G1', next: 'Run tests' }, agent)
    await execute(ctx, 'jspace_checkpoint', {
      check: 'keyword only',
      by: 'e2e verifier',
    }, agent)
    const refused = await execute(ctx, 'jspace_ship', {}, agent)
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain(SHIP_REQUIRES_VERIFIED_EVIDENCE)

    recordVerifier(agent, 'call-bash')
    const checked = await execute(ctx, 'jspace_checkpoint', {
      check: 'tests ran',
      by: 'e2e verifier',
      evidence: 'call-bash',
    }, agent)
    expect(checked.isError).toBe(false)
    const cards = agent.session.events.filter(event => event.type === 'jspace/card')
    const last = cards[cards.length - 1]
    if (last === undefined) throw new Error('no jspace/card event in the session log')
    const line = last.data.checked[last.data.checked.length - 1]
    expect(line).toMatchObject({ evidence: 'call-bash', verified: true })

    const pass = await execute(ctx, 'jspace_ship', {}, agent)
    expect(pass.isError).toBe(false)
  })
})
