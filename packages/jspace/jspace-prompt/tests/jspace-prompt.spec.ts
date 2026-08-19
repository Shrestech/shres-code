import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import AgentRegistry, { Inbox } from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import { createUserMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import JspaceService, {
  JSPACE_ALWAYS_OPEN_GOAL,
  JSPACE_AVAILABLE_LINE,
} from '@shres-code/shres-code-jspace'
import * as JspacePrompt from '../src/index.ts'

function liveAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
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
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  ctx.agents.register(agent)
  return agent
}

async function harness(config: ConstructorParameters<typeof JspaceService>[1] = { enabled: true }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(JspaceService, config)
  await ctx.plugin(JspacePrompt)
  return ctx
}

describe('jspace-prompt', () => {
  it('omits the section when the seat is off', async () => {
    const ctx = await harness({ enabled: false })
    const assembled = await ctx.systemPrompt.assemble()
    expect(assembled.sections.find(section => section.name === JspacePrompt.JSPACE_SECTION)?.text ?? '').toBe('')
    expect(JspacePrompt.passFor(ctx, undefined)).toBe('fast')
  })

  it('skips non-user log messages when reading turn text', async () => {
    const ctx = await harness({ enabled: true })
    const agent = liveAgent(ctx, 'ws-prompt-plugin-src')
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'plugin said this' }],
      source: { kind: 'plugin', plugin: 'repeat-tool-reminder' },
    }), { surfaceOp: 'append' })
    const assembled = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(assembled.sections.find(section => section.name === JspacePrompt.JSPACE_PROTOCOL_SECTION)?.text)
      .toContain('call jspace_open')
    expect(assembled.sections.find(section => section.name === JspacePrompt.JSPACE_PROTOCOL_SECTION)?.text)
      .not.toContain('Pass:')
  })

  it('ignores non-text claimed parts when classifying', async () => {
    const ctx = await harness({ enabled: true, mode: 'available' })
    const agent = liveAgent(ctx, 'ws-prompt-image')
    const message = {
      ...createUserMessage({
        content: [{ type: 'text', text: '' }],
        source: { kind: 'user' },
      }),
      content: [{ type: 'image' as const, mimeType: 'image/png', url: 'about:blank' }],
    }
    await ctx.systemPrompt.assemble({ agent, scope: agent, messages: [message as never] })
    expect(ctx.jspace.card(agent.session)).toBeNull()
  })

  it('does not auto-open a one-glance turn in available mode', async () => {
    const ctx = await harness({ enabled: true, mode: 'available' })
    const agent = liveAgent(ctx, 'ws-prompt-available')
    const message = createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    })
    await ctx.systemPrompt.assemble({ agent, scope: agent, messages: [message] })
    expect(ctx.jspace.card(agent.session)).toBeNull()
  })

  it('prints the availability line when on and no card is open', async () => {
    const ctx = await harness({ enabled: true })
    const agent = liveAgent(ctx, 'ws-prompt-avail')
    const assembled = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(assembled.sections.find(section => section.name === JspacePrompt.JSPACE_SECTION)?.text)
      .toBe(JSPACE_AVAILABLE_LINE)
  })

  it('prints the five-line card after open and the availability line after close', async () => {
    const ctx = await harness({ enabled: true })
    const agent = liveAgent(ctx, 'ws-prompt-card')
    ctx.jspace.open(agent.session, { goal: 'Ship W2', next: 'Write tests' })
    const open = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const text = open.sections.find(section => section.name === JspacePrompt.JSPACE_SECTION)?.text ?? ''
    expect(text).toContain('Goal:      Ship W2')
    expect(text).toContain('Next:      Write tests')
    ctx.jspace.close(agent.session)
    const closed = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(closed.sections.find(section => section.name === JspacePrompt.JSPACE_SECTION)?.text)
      .toBe(JSPACE_AVAILABLE_LINE)
  })

  it('opens a card during assemble when mode is always-open, seeding Goal from the turn text', async () => {
    const ctx = await harness({ enabled: true, mode: 'always-open' })
    const agent = liveAgent(ctx, 'ws-prompt-always')
    const first = await ctx.systemPrompt.assemble({ agent, scope: agent, messages: [
      createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
    ] })
    expect(ctx.jspace.card(agent.session)?.goal).toBe('go')
    expect(first.sections.find(section => section.name === JspacePrompt.JSPACE_SECTION)?.text)
      .toContain('Goal:      go')
    const second = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(ctx.jspace.card(agent.session)?.seq).toBe(1)
    expect(second.sections.find(section => section.name === JspacePrompt.JSPACE_SECTION)?.text)
      .toContain('Goal:      go')
  })

  it('falls back to the stock Goal when always-open assembles with no human text', async () => {
    const ctx = await harness({ enabled: true, mode: 'always-open' })
    const agent = liveAgent(ctx, 'ws-prompt-always-blank')
    const assembled = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(ctx.jspace.card(agent.session)?.goal).toBe(JSPACE_ALWAYS_OPEN_GOAL)
    expect(assembled.sections.find(section => section.name === JspacePrompt.JSPACE_SECTION)?.text)
      .toContain(`Goal:      ${JSPACE_ALWAYS_OPEN_GOAL}`)
  })

  it('does not auto-open after an explicit close', async () => {
    const ctx = await harness({ enabled: true, mode: 'always-open' })
    const agent = liveAgent(ctx, 'ws-prompt-stay-closed')
    ctx.jspace.open(agent.session, { goal: 'Ship W2', next: 'Write tests' })
    ctx.jspace.close(agent.session)
    await ctx.systemPrompt.assemble({ agent, scope: agent, messages: [
      createUserMessage({ content: [{ type: 'text', text: 'refactor this across every file' }], source: { kind: 'user' } }),
    ] })
    expect(ctx.jspace.card(agent.session)).toBeNull()
    ctx.jspace.open(agent.session, { goal: 'Ship W2', next: 'Write tests' })
    expect(ctx.jspace.card(agent.session)?.goal).toBe('Ship W2')
  })

  it('does not auto-open when the seat is off', async () => {
    const ctx = await harness({ enabled: false, mode: 'always-open' })
    const agent = liveAgent(ctx, 'ws-prompt-off')
    await ctx.systemPrompt.assemble({ agent, scope: agent, messages: [
      createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
    ] })
    expect(ctx.jspace.card(agent.session)).toBeNull()
  })

  it('uses the availability line when assemble has no agent', async () => {
    const ctx = await harness({ enabled: true })
    const assembled = await ctx.systemPrompt.assemble()
    expect(assembled.sections.find(section => section.name === JspacePrompt.JSPACE_SECTION)?.text)
      .toBe(JSPACE_AVAILABLE_LINE)
  })

  it('uses a short open driver on fast and operational card rules on loop', async () => {
    const ctx = await harness({ enabled: true, mode: 'available' })
    const agent = liveAgent(ctx, 'ws-prompt-fast')
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'What time is it?' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const fast = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const fastProtocol = fast.sections.find(section => section.name === JspacePrompt.JSPACE_PROTOCOL_SECTION)?.text ?? ''
    expect(fastProtocol).toContain('call jspace_open')
    expect(fastProtocol).toContain('Skip the card for one-step work')
    expect(fastProtocol).not.toContain('accessible workspace')

    ctx.jspace.open(agent.session, { goal: 'Ship J2', next: 'Write tests' })
    const loop = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const protocol = loop.sections.find(section => section.name === JspacePrompt.JSPACE_PROTOCOL_SECTION)?.text ?? ''
    expect(protocol).toContain('durable external state')
    expect(protocol).toContain('current intermediate')
    expect(protocol).toContain('successful tool-call id')
    expect(protocol).toContain('successful ship closes the card')
    expect(protocol).not.toContain('Pass:')
    expect(JspacePrompt.JSPACE_DRIVER_CLOSED).toContain('jspace_open')
    expect(JspacePrompt.JSPACE_DRIVER_OPEN).toContain('jspace_note')
  })

  it('opens a card during assemble when claimed text selects loop', async () => {
    const ctx = await harness({ enabled: true, mode: 'available' })
    const agent = liveAgent(ctx, 'ws-prompt-loop-text')
    const message = createUserMessage({
      content: [{ type: 'text', text: 'Audit this repository across every file and persist the findings.' }],
      source: { kind: 'user' },
    })
    const assembled = await ctx.systemPrompt.assemble({ agent, scope: agent, messages: [message] })
    expect(ctx.jspace.card(agent.session)?.goal)
      .toBe('Audit this repository across every file and persist the findings.')
    expect(assembled.sections.find(section => section.name === JspacePrompt.JSPACE_SECTION)?.text)
      .toContain('Goal:      Audit this repository across every file and persist the findings.')
    expect(assembled.sections.find(section => section.name === JspacePrompt.JSPACE_PROTOCOL_SECTION)?.text)
      .toContain('durable external state')
  })
})

describe('seedGoal', () => {
  it('keeps the first non-empty line, trimmed', () => {
    expect(JspacePrompt.seedGoal('\n  \n  Ship the feature  \nlater line')).toBe('Ship the feature')
    expect(JspacePrompt.seedGoal('one')).toBe('one')
  })

  it('falls back to the stock placeholder on blank text', () => {
    expect(JspacePrompt.seedGoal('')).toBe(JSPACE_ALWAYS_OPEN_GOAL)
    expect(JspacePrompt.seedGoal(' \n\t\n ')).toBe(JSPACE_ALWAYS_OPEN_GOAL)
  })

  it('leaves a line at the limit untouched', () => {
    const exact = 'x'.repeat(JspacePrompt.JSPACE_SEED_GOAL_MAX)
    expect(JspacePrompt.seedGoal(exact)).toBe(exact)
  })

  it('cuts at a sentence boundary and marks the cut', () => {
    expect(JspacePrompt.seedGoal(`${'a'.repeat(150)}. ${'b'.repeat(150)}`))
      .toBe(`${'a'.repeat(150)}…`)
    expect(JspacePrompt.seedGoal(`${'q'.repeat(150)}! ${'r'.repeat(150)}`))
      .toBe(`${'q'.repeat(150)}…`)
  })

  it('cuts at a word boundary when no sentence ends in range', () => {
    expect(JspacePrompt.seedGoal(`${'a'.repeat(150)} ${'b'.repeat(150)}`))
      .toBe(`${'a'.repeat(150)}…`)
  })

  it('hard-cuts a single long word and marks the cut', () => {
    const line = 'a'.repeat(JspacePrompt.JSPACE_SEED_GOAL_MAX + 50)
    expect(JspacePrompt.seedGoal(line)).toBe(`${'a'.repeat(JspacePrompt.JSPACE_SEED_GOAL_MAX)}…`)
  })
})
