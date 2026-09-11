import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import { createUserMessage } from '@shres-code/shres-code-llm'
import { SessionId } from '@shres-code/shres-code-session'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { TeamId, TeamMessageId } from '../src/brand.ts'
import { emptyTeamFoldState, teamStateFromFold } from '../src/fold.ts'
import type { TeamJournal } from '../src/journal.ts'
import { TeamRuntimeLifecycle } from '../src/lifecycle.ts'
import { TeamMailbox } from '../src/mailbox.ts'
import type { TeamRoster } from '../src/roster.ts'
import type { TeamMemberSnapshot, TeamMessageSnapshot, TeamState } from '../src/types.ts'

const SIGNAL = new AbortController().signal
const LEAD_ID = SessionId('lead')
const CHILD_ID = SessionId('aegis-child')

function memberRow(): TeamMemberSnapshot {
  return {
    id: CHILD_ID,
    name: 'aegis',
    description: 'Architect',
    provider: 'spawn',
    context: 'fresh',
    phase: 'active',
  }
}

function fakeSession(id: SessionId, events: SessionEvent[] = []): Session & { events: SessionEvent[] } {
  return {
    id,
    events,
    header: { seedLength: 0 },
  } as unknown as Session & { events: SessionEvent[] }
}

function fakeAgent(id: SessionId, session: Session, extras: Partial<Agent> = {}): Agent {
  return {
    id,
    session,
    status: 'idle',
    options: {},
    steer: (message: ReturnType<typeof createUserMessage>) => {
      session.events.push({
        type: 'user/message',
        data: message,
        seq: session.events.length,
        time: 0,
      } as SessionEvent)
    },
    ...extras,
  } as Agent
}

function setupMailbox(options: {
  state?: TeamState
  agents?: Map<SessionId, Agent>
  inspect?: (id: SessionId) => Promise<{ meta: { seedLength?: number }; events: SessionEvent[] }>
  followup?: () => Promise<string>
  flush?: () => Promise<boolean>
  maxPending?: number
  maxBytes?: number
} = {}) {
  let state = options.state ?? teamStateFromFold(emptyTeamFoldState(LEAD_ID))
  if (options.state === undefined) {
    state = { ...state, members: [memberRow()] }
  }
  const warnings: string[] = []
  const agents = options.agents ?? new Map<SessionId, Agent>()
  const journal = {
    state: () => state,
    transact: async <T>(_id: SessionId, operation: () => Promise<T>) => operation(),
    appendAndFlush: async (_session: Session, type: string, data: Record<string, unknown>) => {
      if (type === 'team/message/queued') {
        const message = data.message as TeamMessageSnapshot
        state = { ...state, messages: [...state.messages, message] }
      }
      if (type === 'team/message/delivered') {
        state = { ...state, delivered: [...state.delivered, data.messageId as TeamMessageSnapshot['id']] }
      }
    },
  } as unknown as TeamJournal
  const leadSession = fakeSession(LEAD_ID)
  const lead = fakeAgent(LEAD_ID, leadSession)
  agents.set(LEAD_ID, lead)
  const roster = {
    membership: (agent: Agent) => ({
      root: lead,
      id: TeamId(LEAD_ID),
      role: agent.id === LEAD_ID ? 'lead' as const : 'teammate' as const,
      name: agent.id === LEAD_ID ? 'lead' : 'aegis',
    }),
    tryMembership: (agent: Agent) => (agent.id === LEAD_ID || agent.id === CHILD_ID
      ? {
        root: lead,
        id: TeamId(LEAD_ID),
        role: agent.id === LEAD_ID ? 'lead' as const : 'teammate' as const,
        name: agent.id === LEAD_ID ? 'lead' : 'aegis',
      }
      : undefined),
  } as unknown as TeamRoster
  const lifecycle = new TeamRuntimeLifecycle(1_000)
  const followup = options.followup ?? (async () => 'ok')
  const ctx = {
    agents: { get: (id: SessionId) => agents.get(id) },
    sessions: {
      flush: options.flush ?? (async () => true),
      get: (id: SessionId) => agents.get(id)?.session,
    },
    subagents: { followup },
    sessionPersistence: {
      inspect: options.inspect ?? (async () => {
        throw new Error('missing persisted target')
      }),
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
  } as unknown as Context
  const mailbox = new TeamMailbox(
    ctx,
    journal,
    roster,
    lifecycle,
    options.maxPending ?? 64,
    options.maxBytes ?? 65_536,
  )
  return {
    mailbox,
    journal,
    lifecycle,
    lead,
    leadSession,
    agents,
    warnings,
    getState: () => state,
    setState: (next: TeamState) => { state = next },
  }
}

describe('TeamMailbox', () => {
  it('rejects self-send, oversized mail, a full mailbox, and send after dispose', async () => {
    const tiny = setupMailbox({ maxBytes: 16 })
    await expect(tiny.mailbox.send(tiny.lead, {
      target: 'lead',
      content: [{ type: 'text', text: 'nope' }],
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_SELF_MESSAGE' })
    await expect(tiny.mailbox.send(tiny.lead, {
      target: 'aegis',
      content: [{ type: 'text', text: 'hi' }],
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })

    const { mailbox, lead, lifecycle } = setupMailbox({ maxPending: 1 })
    const queued = await mailbox.send(lead, {
      target: 'aegis',
      content: [{ type: 'text', text: 'one' }],
      signal: SIGNAL,
    })
    expect(queued.status).toBe('queued')
    await expect(mailbox.send(lead, {
      target: 'aegis',
      content: [{ type: 'text', text: 'two' }],
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })

    lifecycle.close()
    await expect(mailbox.send(lead, {
      target: 'aegis',
      content: [{ type: 'text', text: 'late' }],
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
  })

  it('steers a live teammate and skips duplicate in-flight dispatch', async () => {
    const childSession = fakeSession(CHILD_ID)
    const child = fakeAgent(CHILD_ID, childSession)
    const { mailbox, lead, agents } = setupMailbox({ agents: new Map([[CHILD_ID, child]]) })
    agents.set(CHILD_ID, child)
    const first = await mailbox.send(lead, {
      target: String(CHILD_ID),
      content: [{ type: 'text', text: 'plan' }],
      signal: SIGNAL,
    })
    expect(first.status).toBe('accepted')
    expect(childSession.events.some(event => event.type === 'user/message')).toBe(true)

    const second = await mailbox.send(lead, {
      target: 'aegis',
      content: [{ type: 'text', text: 'again' }],
      signal: SIGNAL,
    })
    expect(second.status).toBe('accepted')
  })

  it('acknowledges a pre-recorded target receipt and logs a failed checkpoint', async () => {
    const childSession = fakeSession(CHILD_ID)
    const child = fakeAgent(CHILD_ID, childSession)
    const { mailbox, lead, agents, warnings, getState } = setupMailbox({
      agents: new Map([[CHILD_ID, child]]),
      flush: async () => {
        throw new Error('ack fail')
      },
    })
    agents.set(CHILD_ID, child)
    const messageId = TeamMessageId('team-message-pre')
    const source = {
      kind: 'team-message' as const,
      form: 'relay' as const,
      teamId: TeamId(LEAD_ID),
      messageId,
      senderSessionId: LEAD_ID,
      senderName: 'lead',
    }
    childSession.events.push({
      type: 'user/message',
      data: createUserMessage({ content: [{ type: 'text', text: 'already' }], source }),
      seq: 0,
      time: 0,
    } as SessionEvent)
    mailbox.observeSessionEvent(childSession, childSession.events[0]!)
    await vi.waitFor(() => {
      expect(warnings.some(line => line.includes('acknowledgement failed'))).toBe(true)
    })

    mailbox.observeSessionEvent(childSession, {
      type: 'assistant/message',
      data: {},
    } as SessionEvent)
    mailbox.observeSessionEvent(fakeSession(LEAD_ID), {
      type: 'user/message',
      data: createUserMessage({
        content: [{ type: 'text', text: 'x' }],
        source: { ...source, teamId: TeamId(SessionId('missing-team')) },
      }),
    } as SessionEvent)

    expect(getState().delivered).toEqual([])
    expect(lead.id).toBe(LEAD_ID)
  })

  it('delivers through followup, persisted receipts, inspect failure, and recovery skip', async () => {
    const followup = vi.fn(async () => 'ok')
    const { mailbox, lead, getState, setState, lifecycle } = setupMailbox({
      followup,
      inspect: async () => ({
        meta: { seedLength: 0 },
        events: [],
      }),
    })
    const sent = await mailbox.send(lead, {
      target: 'aegis',
      content: [{ type: 'text', text: 'cold' }],
      signal: SIGNAL,
    })
    expect(sent.status).toBe('accepted')
    expect(followup).toHaveBeenCalled()

    const recordedId = TeamMessageId('team-message-recorded')
    setState({
      ...getState(),
      messages: [{
        id: recordedId,
        senderId: LEAD_ID,
        senderName: 'lead',
        targetId: CHILD_ID,
        content: [{ type: 'text', text: 'prior' }],
      }],
      delivered: [],
    })
    const recorded = setupMailbox({
      state: {
        ...teamStateFromFold(emptyTeamFoldState(LEAD_ID)),
        members: [memberRow()],
        messages: [{
          id: recordedId,
          senderId: LEAD_ID,
          senderName: 'lead',
          targetId: CHILD_ID,
          content: [{ type: 'text', text: 'prior' }],
        }],
      },
      inspect: async () => ({
        meta: { seedLength: 0 },
        events: [{
          type: 'user/message',
          data: createUserMessage({
            content: [{ type: 'text', text: 'prior' }],
            source: {
              kind: 'team-message',
              form: 'relay',
              teamId: TeamId(LEAD_ID),
              messageId: recordedId,
              senderSessionId: LEAD_ID,
              senderName: 'lead',
            },
          }),
          seq: 0,
          time: 0,
        } as SessionEvent],
      }),
    })
    await recorded.mailbox.recoverFor(recorded.lead, SIGNAL)
    expect(recorded.getState().delivered).toContain(recordedId)

    const missing = setupMailbox({
      inspect: async () => {
        throw new Error('offline')
      },
    })
    const queued = await missing.mailbox.send(missing.lead, {
      target: 'aegis',
      content: [{ type: 'text', text: 'wait' }],
      signal: SIGNAL,
    })
    expect(queued.status).toBe('queued')
    expect(missing.warnings.some(line => line.includes('cannot read Team message target'))).toBe(true)

    await missing.mailbox.recoverFor(fakeAgent(SessionId('stranger'), fakeSession(SessionId('stranger'))), SIGNAL)
    missing.lifecycle.close()
    await missing.mailbox.recoverFor(missing.lead, SIGNAL)
    expect(lifecycle.disposed).toBe(false)
  })

  it('acks a live target that already recorded the message and queues when steer throws', async () => {
    const childSession = fakeSession(CHILD_ID)
    const child = fakeAgent(CHILD_ID, childSession)
    const { mailbox, lead, agents, getState, setState, warnings } = setupMailbox({
      agents: new Map([[CHILD_ID, child]]),
    })
    agents.set(CHILD_ID, child)
    const accepted = await mailbox.send(lead, {
      target: 'aegis',
      content: [{ type: 'text', text: 'plan' }],
      signal: SIGNAL,
    })
    expect(accepted.status).toBe('accepted')
    setState({ ...getState(), delivered: [] })
    await mailbox.recoverFor(lead, SIGNAL)
    expect(getState().delivered).toContain(accepted.messageId)

    child.steer = () => {
      throw new Error('steer boom')
    }
    const queued = await mailbox.send(lead, {
      target: 'aegis',
      content: [{ type: 'text', text: 'again' }],
      signal: SIGNAL,
    })
    expect(queued.status).toBe('queued')
    expect(warnings.some(line => line.includes('remains queued'))).toBe(true)
  })

  it('serializes two pending deliveries and swallows a dispatch throw', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const followup = vi.fn(async () => {
      await gate
      throw new Error('steer failed')
    })
    const { mailbox, lead } = setupMailbox({ followup, maxPending: 8 })
    const first = mailbox.send(lead, {
      target: 'aegis',
      content: [{ type: 'text', text: 'one' }],
      signal: SIGNAL,
    })
    const second = mailbox.send(lead, {
      target: 'aegis',
      content: [{ type: 'text', text: 'two' }],
      signal: SIGNAL,
    })
    release()
    expect((await first).status).toBe('queued')
    expect((await second).status).toBe('queued')
  })
})
