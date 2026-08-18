import { describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@shres-code/shres-code-agent'
import type { Agent, AgentStatus } from '@shres-code/shres-code-agent'
import CommandRuntime from '@shres-code/shres-code-commands'
import SessionStore, { Session, SessionId } from '@shres-code/shres-code-session'
import JspaceService, {
  JSPACE_ALWAYS_OPEN_GOAL,
  JSPACE_ALWAYS_OPEN_NEXT,
  JspaceError,
} from '@shres-code/shres-code-jspace'
import * as commandJspace from '../src/index.ts'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

async function harness(enabled = true): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JspaceService, { enabled })
  const plugin = await ctx.plugin(commandJspace)
  const { agent, session } = stubAgent(ctx, `command-jspace-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, plugin }
}

async function run(
  test: Harness,
  suffix = '',
): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>['result']> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/j-space${suffix}`,
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('j-space command was not registered')
  return execution.result
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

describe('@shres-code/shres-code-command-jspace registration', () => {
  it('registers one global command with Loader-safe exports and remounts with the seat', async () => {
    expect(commandJspace.name).toBe('command-jspace')
    expect(commandJspace.inject).toEqual(['commands', 'jspace'])
    expect('default' in commandJspace).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandJspace)).toBe(commandJspace)

    const off = await harness(false)
    expect(off.ctx.commands.find(off.agent, 'j-space')).toBeUndefined()
    const enableOff = await attachSettings(off.ctx, true)
    expect(off.ctx.commands.find(off.agent, 'j-space')).toBeDefined()
    enableOff(false)
    expect(off.ctx.commands.find(off.agent, 'j-space')).toBeUndefined()

    const test = await harness(true)
    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'j-space',
      description: "open or close this session's J-Space card",
      input: { hint: '[on [<goal> | <next>]|off]' },
    })

    const setEnabled = await attachSettings(test.ctx, true)
    setEnabled(true)
    expect(test.ctx.commands.find(test.agent, 'j-space')).toBeDefined()
    setEnabled(false)
    expect(test.ctx.commands.find(test.agent, 'j-space')).toBeUndefined()
    setEnabled(true)
    expect(test.ctx.commands.find(test.agent, 'j-space')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'j-space')).toBeUndefined()
  })
})

describe('/j-space human command', () => {
  it('shows, opens with goal | next, and refuses a second open', async () => {
    const test = await harness()
    await expect(run(test)).resolves.toEqual({
      kind: 'success',
      text: 'No J-Space card is open.',
    })

    await expect(run(test, ' on only-goal')).resolves.toEqual({
      kind: 'error',
      text: 'open a card with jspace_open or: /j-space on <goal> | <next>',
    })
    await expect(run(test, ' on  | next')).resolves.toEqual({
      kind: 'error',
      text: 'open a card with jspace_open or: /j-space on <goal> | <next>',
    })
    await expect(run(test, ' on goal |  ')).resolves.toEqual({
      kind: 'error',
      text: 'open a card with jspace_open or: /j-space on <goal> | <next>',
    })
    await expect(run(test, ' mystery')).resolves.toEqual({
      kind: 'error',
      text: 'open a card with jspace_open or: /j-space on <goal> | <next>',
    })

    await expect(run(test, ' on')).resolves.toEqual({
      kind: 'success',
      text: 'Opened J-Space.',
    })
    expect(test.ctx.jspace.card(test.session)).toMatchObject({
      goal: JSPACE_ALWAYS_OPEN_GOAL,
      next: JSPACE_ALWAYS_OPEN_NEXT,
    })

    await expect(run(test)).resolves.toEqual({
      kind: 'success',
      text: `J-Space is open.\nGoal: ${JSPACE_ALWAYS_OPEN_GOAL}\nNext: ${JSPACE_ALWAYS_OPEN_NEXT}`,
    })
    await expect(run(test, ' on')).resolves.toEqual({
      kind: 'success',
      text: 'A J-Space card is already open.',
    })
    await expect(run(test, ' on Other | Later')).resolves.toEqual({
      kind: 'success',
      text: 'A J-Space card is already open.',
    })
    expect(test.ctx.jspace.card(test.session)?.goal).toBe(JSPACE_ALWAYS_OPEN_GOAL)

    const explicit = await harness()
    const opened = await run(explicit, ' ON Ship W3 | Write tests')
    expect(opened).toEqual({ kind: 'success', text: 'Opened J-Space.' })
    expect(explicit.ctx.jspace.card(explicit.session)).toMatchObject({
      goal: 'Ship W3',
      next: 'Write tests',
    })
  })

  it('closes an open card and reports an already-closed card', async () => {
    const test = await harness()
    await expect(run(test, ' off')).resolves.toEqual({
      kind: 'success',
      text: 'J-Space is already closed.',
    })
    await run(test, ' on Ship | Test')
    await expect(run(test, ' OFF leftover')).resolves.toEqual({
      kind: 'success',
      text: 'Closed J-Space.',
    })
    expect(test.ctx.jspace.card(test.session)).toBeNull()
  })

  it('maps seat refusals and does not swallow unexpected failures', async () => {
    const test = await harness()
    vi.spyOn(test.ctx.jspace, 'open').mockImplementationOnce(() => {
      throw new JspaceError('jspace is disabled', 'JSPACE_DISABLED')
    })
    await expect(run(test, ' on Ship | Test')).resolves.toEqual({
      kind: 'error',
      text: 'jspace is disabled',
    })

    vi.spyOn(test.ctx.jspace, 'card').mockImplementationOnce(() => {
      throw new Error('unexpected failure')
    })
    await expect(run(test)).rejects.toThrow('unexpected failure')
  })
})
