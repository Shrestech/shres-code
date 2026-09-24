import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import { assembleContextFor } from '@shres-code/shres-code-agent'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { mountAgentLoopTestDependencies } from '@shres-code/shres-code-agent-loop-testkit'
import { CallId, createUserMessage, LlmAdapter } from '@shres-code/shres-code-llm'
import type { GenerateOptions, StreamChunk } from '@shres-code/shres-code-llm'
import { SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent } from '@shres-code/shres-code-session'
import JsonlSessionPersistence from '@shres-code/shres-code-session-persistence-jsonl'
import SubagentRuntime from '@shres-code/shres-code-subagent'
import * as SubagentSpawn from '@shres-code/shres-code-subagent-spawn-in-process'
import * as control from '@shres-code/shres-code-tool-subagent-control'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'

const testSignal = new AbortController().signal

/** Model-call source the fixtures observe and release. */
interface GatedModelAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[]
  release(): void
}

/** Adapter that keeps every Activation resident until the test releases it. */
class HeldAdapter extends LlmAdapter implements GatedModelAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly gate = Promise.withResolvers<undefined>()

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.gate.promise
    for (const chunk of textResponse('held answer')) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }

  release(): void {
    this.gate.resolve(undefined)
  }
}

/**
 * Adapter holding each session's model calls behind that session's own gate, so
 * one Agent can stay busy while another finishes. Once a session's gate is
 * released, its later calls stream immediately.
 */
class SessionGatedAdapter extends LlmAdapter implements GatedModelAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly gates = new Map<GenerateOptions['sessionId'], PromiseWithResolvers<undefined>>()

  private gate(sessionId: GenerateOptions['sessionId']): PromiseWithResolvers<undefined> {
    const existing = this.gates.get(sessionId)
    if (existing !== undefined) return existing
    const created = Promise.withResolvers<undefined>()
    this.gates.set(sessionId, created)
    return created
  }

  /** Release one session's held calls and leave its later calls ungated. */
  releaseSession(sessionId: GenerateOptions['sessionId']): void {
    this.gate(sessionId).resolve(undefined)
  }

  release(): void {
    for (const gate of this.gates.values()) gate.resolve(undefined)
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.gate(options.sessionId).promise
    for (const chunk of textResponse('held answer')) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Boot the real continuation graph with optional report installation. */
async function setup(options: { load?: boolean; config?: tool.Config; adapter?: GatedModelAdapter } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'shres-tool-subagent-report-'))
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const fiber = options.load === false
    ? undefined
    : await ctx.plugin(tool, options.config ?? { reportDelivery: 'quiet' })
  const adapter = options.adapter ?? new HeldAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  cleanups.push(async () => {
    adapter.release()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  return { ctx, parent, adapter, fiber }
}

/** Start and resolve one resident continuable child. */
async function startChild(ctx: Context, parent: Agent, prompt = 'child task') {
  const started = await ctx.subagents.startContinuable({
    provider: 'spawn',
    label: prompt,
    request: {
      prompt: [{ type: 'text', text: prompt }],
      parent,
    },
    signal: testSignal,
  })
  const child = await vi.waitFor(() => {
    const live = ctx.agents.get(started.childId)
    expect(live).toBeDefined()
    return live as Agent
  })
  return { started, child }
}

let calls = 0
function callReport(ctx: Context, child: Agent, output: string, signal = testSignal) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`report-${++calls}`),
    name: 'report',
    arguments: { output },
    agent: child,
  })
}

/** Occupy the child-local report name to force installation rollback. */
function registerReportConflict(child: Agent): () => void {
  return child.ctx.tools.register({
    name: 'report',
    description: 'conflicting report fixture',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: {} }, render: () => [] },
    execute: () => Promise.resolve({}),
  })
}

/** Reports already visible or still pending in one Agent. */
function reports(agent: Agent): { id: string; text: string; sender: string }[] {
  const visible = agent.session.events.flatMap(event => event.type === 'user/message' ? [event.data] : [])
  return [...visible, ...agent.inbox.nextStep].flatMap((message) => {
    if (message.source.kind !== 'subagent-report') return []
    return [{
      id: message.id,
      text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
      sender: message.source.senderSessionId,
    }]
  })
}

/**
 * Report findings already committed to one Agent's log, in claim order. Reads
 * the log rather than `reports()`, which also counts unclaimed inbox work and
 * so cannot show that a delivery was claimed.
 */
function loggedReportFindings(agent: Agent, childId: SessionId): string[] {
  const frame = `Background subagent ${childId} reported:`
  return agent.session.events.flatMap((event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'subagent-report') return []
    const texts = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    const at = texts.indexOf(frame)
    return at === -1 ? [] : [texts.slice(at + 1).join('\n')]
  })
}

/** Settlement notices one Agent has read, by the child that settled. */
function settledNotices(agent: Agent): { sender: string }[] {
  return agent.session.events.flatMap(event => event.type === 'user/message'
    && event.data.source.kind === 'subagent-settled'
    ? [{ sender: event.data.source.senderSessionId }]
    : [])
}

function renderedText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('')
}

/** The prompt sections one agent's scope assembles, by name. */
async function sectionNames(ctx: Context, agent: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
  return assembly.sections.map(section => section.name)
}

describe('shres-tool-subagent-report', () => {
  it('registers report only in continuable child scopes', async () => {
    const { ctx, parent } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('report')
    expect(ctx.tools.schemas(parent).map(schema => schema.name)).not.toContain('report')

    const { child } = await startChild(ctx, parent)
    const schemas = ctx.tools.schemas(child).filter(schema => schema.name === 'report')
    expect(schemas).toHaveLength(1)
    const properties = (schemas[0]?.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties)).toEqual(['output'])
  })

  it('adds no implicit capability when the package is absent', async () => {
    const { ctx, parent } = await setup({ load: false })
    const { child } = await startChild(ctx, parent)
    expect(ctx.tools.schemas(child).map(schema => schema.name)).not.toContain('report')
    expect((await callReport(ctx, child, 'missing')).isError).toBe(true)
  })

  it('does not imply parent controls and survives a global-tool allow-list', async () => {
    const { ctx, parent } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('send_message')
    await ctx.plugin(control)
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('send_message')

    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'restricted child',
      request: {
        prompt: [{ type: 'text', text: 'restricted child' }],
        parent,
        toolFilter: { allow: [] },
      },
      signal: testSignal,
    })
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live as Agent
    })
    const names = ctx.tools.schemas(child).map(schema => schema.name)
    expect(names).toContain('report')
    expect(names).not.toContain('send_message')
  })

  it('delivers quiet reports with stable message and sender identities without waking', async () => {
    const { ctx, parent, adapter } = await setup()
    const { started, child } = await startChild(ctx, parent)
    const parentRequests = adapter.requests.filter(request => request.sessionId === parent.id).length
    const enqueues: string[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === parent) {
        enqueues.push(agent.inbox.nextTurn.some(queued => queued.id === message.id) ? 'queued' : 'steering')
      }
    })

    const result = await callReport(ctx, child, 'CHILD_FINDING')

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('report unexpectedly failed')
    const messageId = (result.value as { messageId: string }).messageId
    expect(renderedText(result)).toContain(messageId)
    expect(reports(parent)).toEqual([{
      id: messageId,
      text: `Background subagent ${started.childId} reported:\nCHILD_FINDING`,
      sender: started.childId,
    }])
    expect(enqueues).toEqual(['steering'])
    expect(parent.status).toBe('idle')
    expect(adapter.requests.filter(request => request.sessionId === parent.id)).toHaveLength(parentRequests)
  })

  it('wakes an idle parent with one later turn for a wakeup report', async () => {
    const { ctx, parent, adapter } = await setup({ config: { reportDelivery: 'wakeup' } })
    const { child } = await startChild(ctx, parent)
    const enqueues: string[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === parent) {
        enqueues.push(agent.inbox.nextTurn.some(queued => queued.id === message.id) ? 'queued' : 'steering')
      }
    })

    const result = await callReport(ctx, child, 'WAKE_UP')
    expect(result.isError).toBe(false)
    expect(enqueues).toEqual(['queued'])
    await vi.waitFor(() => {
      expect(adapter.requests.some(request => request.sessionId === parent.id)).toBe(true)
    })
  })

  it('steers a report into the turn a running parent already has open', async () => {
    const adapter = new SessionGatedAdapter()
    const { ctx, parent } = await setup({ config: { reportDelivery: 'wakeup' }, adapter })
    const turnStarts: number[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id === parent.id && event.type === 'turn/start') turnStarts.push(event.data.turn)
    })
    // Open the parent's turn before the report, so the report meets a busy parent.
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent works' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(parent.status).toBe('running') })
    const { started, child } = await startChild(ctx, parent)
    const enqueues: string[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === parent) {
        enqueues.push(agent.inbox.nextTurn.some(queued => queued.id === message.id) ? 'queued' : 'steering')
      }
    })

    const result = await callReport(ctx, child, 'BUSY_FINDING')

    expect(result.isError).toBe(false)
    expect(enqueues).toEqual(['steering'])
    expect(parent.inbox.nextStep).toHaveLength(1)
    expect(parent.inbox.nextTurn).toHaveLength(0)
    // The whole delivery is next-step input for the open turn: the report opened
    // no turn of its own while the parent's held step 1 was still running.
    expect(turnStarts).toEqual([1])

    // Release only the parent, so the claim is observable without a child
    // settlement notice adding a turn of its own.
    adapter.releaseSession(parent.id)
    await vi.waitFor(() => { expect(loggedReportFindings(parent, started.childId)).toEqual(['BUSY_FINDING']) })
    expect(parent.inbox.nextStep).toHaveLength(0)
    expect(parent.inbox.nextTurn).toHaveLength(0)
    expect(turnStarts).toEqual([1])
  })

  it('claims back-to-back reports in one turn in send order', async () => {
    const adapter = new SessionGatedAdapter()
    const { ctx, parent } = await setup({ config: { reportDelivery: 'wakeup' }, adapter })
    const { started, child } = await startChild(ctx, parent)
    const turnStarts: number[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id === parent.id && event.type === 'turn/start') turnStarts.push(event.data.turn)
    })
    const enqueues: string[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === parent) {
        enqueues.push(agent.inbox.nextTurn.some(queued => queued.id === message.id) ? 'queued' : 'steering')
      }
    })

    // Sent one after the other, so the first is claimed inside its own send and
    // the second already reads a running parent.
    expect((await callReport(ctx, child, 'FIRST')).isError).toBe(false)
    expect((await callReport(ctx, child, 'SECOND')).isError).toBe(false)
    expect(enqueues).toEqual(['queued', 'steering'])
    // The first report's own send opened turn 1; the steered second one waits
    // for that turn's next step rather than opening a turn of its own.
    expect(turnStarts).toEqual([1])
    expect(parent.inbox.nextStep).toHaveLength(1)

    // Release only the parent: both reports are claimed at one boundary of the
    // turn the first one opened, and the child stays held.
    adapter.releaseSession(parent.id)
    await vi.waitFor(() => {
      expect(loggedReportFindings(parent, started.childId)).toEqual(['FIRST', 'SECOND'])
    })
    expect(parent.inbox.nextStep).toHaveLength(0)
    expect(parent.inbox.nextTurn).toHaveLength(0)
    expect(turnStarts).toEqual([1])
  })

  it('redirects a report on a cancelled running parent to its next turn', async () => {
    const { ctx, parent, adapter } = await setup({ config: { reportDelivery: 'wakeup' } })
    const { started, child } = await startChild(ctx, parent)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent works' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(parent.status).toBe('running') })
    const enqueues: string[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === parent) {
        enqueues.push(agent.inbox.nextTurn.some(queued => queued.id === message.id) ? 'queued' : 'steering')
      }
    })
    parent.cancel({ kind: 'user' })

    const result = await callReport(ctx, child, 'AFTER_CANCEL')

    expect(result.isError).toBe(false)
    // A turn already cancelled takes no steering input, so the send is latched
    // into next-turn and replayed once the parent converges.
    expect(enqueues).toEqual(['queued'])
    adapter.release()
    await vi.waitFor(() => { expect(loggedReportFindings(parent, started.childId)).toEqual(['AFTER_CANCEL']) })
  })

  it('keeps each report as its own next turn while the parent maintains', async () => {
    const adapter = new SessionGatedAdapter()
    const { ctx, parent } = await setup({ config: { reportDelivery: 'wakeup' }, adapter })
    const { started, child } = await startChild(ctx, parent)
    const turnStarts: number[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id === parent.id && event.type === 'turn/start') turnStarts.push(event.data.turn)
    })
    const maintaining = Promise.withResolvers<undefined>()
    const maintenance = parent.runMaintenance(async () => { await maintaining.promise })

    expect((await callReport(ctx, child, 'FIRST_WHILE_MAINTAINING')).isError).toBe(false)
    expect((await callReport(ctx, child, 'SECOND_WHILE_MAINTAINING')).isError).toBe(false)

    // Maintenance folds into an idle status, so the lane preserves FIFO with
    // prompts queued during compaction instead of steering.
    expect(parent.status).toBe('idle')
    expect(parent.inbox.nextTurn).toHaveLength(2)
    expect(parent.inbox.nextStep).toHaveLength(0)
    expect(turnStarts).toEqual([])

    maintaining.resolve(undefined)
    await maintenance
    adapter.releaseSession(parent.id)
    await vi.waitFor(() => {
      expect(loggedReportFindings(parent, started.childId))
        .toEqual(['FIRST_WHILE_MAINTAINING', 'SECOND_WHILE_MAINTAINING'])
    })
    // One turn per report after maintenance, and no next-step claiming.
    expect(turnStarts).toEqual([1, 2])
    expect(parent.inbox.nextTurn).toHaveLength(0)
  })

  it('preserves accepted order across repeated reports', async () => {
    const { ctx, parent } = await setup()
    const { child } = await startChild(ctx, parent)

    expect((await callReport(ctx, child, 'FIRST')).isError).toBe(false)
    expect((await callReport(ctx, child, 'SECOND')).isError).toBe(false)
    expect(reports(parent).map(report => report.text.split('\n').at(-1))).toEqual(['FIRST', 'SECOND'])
  })

  it('keeps an accepted report after the child settles', async () => {
    const { ctx, parent, adapter } = await setup()
    const { started, child } = await startChild(ctx, parent)
    expect((await callReport(ctx, child, 'DURABLE_SELECTION')).isError).toBe(false)

    adapter.release()
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId) === undefined).toBe(true)
    }, { timeout: 5_000 })
    expect(reports(parent).map(report => report.text)).toEqual([
      `Background subagent ${started.childId} reported:\nDURABLE_SELECTION`,
    ])
  })

  it('routes nested reports exactly one edge upward', async () => {
    const { ctx, parent, adapter } = await setup()
    const { child } = await startChild(ctx, parent, 'outer task')
    const { started: grandchildStart, child: grandchild } = await startChild(ctx, child, 'inner task')

    expect((await callReport(ctx, grandchild, 'FROM_GRANDCHILD')).isError).toBe(false)
    expect(reports(parent)).toEqual([])
    // The intermediate parent's turn is open, so quiet context is pending in
    // its inbox until that turn reaches its next safe log boundary.
    expect(reports(child)).toHaveLength(1)
    adapter.release()
    await vi.waitFor(() => { expect(reports(child)).toHaveLength(1) })
    expect(reports(child)[0]?.sender).toBe(grandchildStart.childId)
    expect(reports(child)[0]?.text).toContain('FROM_GRANDCHILD')
  })

  it('accounts wakeup reports delivered to a resident continuable parent', async () => {
    const { ctx, parent, adapter } = await setup({ config: { reportDelivery: 'wakeup' } })
    const { child } = await startChild(ctx, parent, 'outer task')
    const { started: grandchildStart, child: grandchild } = await startChild(ctx, child, 'inner task')

    expect((await callReport(ctx, grandchild, 'WAKE_PARENT_CHILD')).isError).toBe(false)
    expect(ctx.agents.get(child.id)).toBe(child)

    adapter.release()
    await vi.waitFor(() => { expect(reports(child)).toHaveLength(1) })
    expect(reports(child)[0]?.sender).toBe(grandchildStart.childId)
    expect(reports(child)[0]?.text).toContain('WAKE_PARENT_CHILD')
  })

  it('rolls back the accepted report when a nested parent rejects the steered send', async () => {
    const { ctx, parent, adapter } = await setup({ config: { reportDelivery: 'wakeup' } })
    const { child } = await startChild(ctx, parent, 'outer task')
    const { child: grandchild } = await startChild(ctx, child, 'inner task')
    // The nested parent is running, so the report is steered; the rejection must
    // reach the waking accounting that admitted the message.
    vi.spyOn(child, 'steer').mockImplementationOnce(() => {
      throw new Error('parent closed during delivery')
    })

    const result = await callReport(ctx, grandchild, 'REJECTED_STEER')

    expect(result.isError).toBe(true)
    expect(renderedText(result)).toContain('direct parent is not live; report was not delivered')
    expect(child.inbox.nextStep).toHaveLength(0)
    expect(child.inbox.nextTurn).toHaveLength(0)
    // A retained accepted id would keep the nested parent's Activation running
    // forever, so its release is what proves the rollback.
    adapter.release()
    await vi.waitFor(() => { expect(ctx.agents.get(child.id)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('rolls back the accepted report when an idle nested parent rejects the followup', async () => {
    const adapter = new SessionGatedAdapter()
    const { ctx, parent } = await setup({ config: { reportDelivery: 'wakeup' }, adapter })
    const { child } = await startChild(ctx, parent, 'outer task')
    const { child: grandchild } = await startChild(ctx, child, 'inner task')
    // Releasing the nested parent alone finishes its own turn; it stays resident
    // while it owns the held grandchild, and its status reads idle.
    adapter.releaseSession(child.id)
    await vi.waitFor(() => { expect(child.status).toBe('idle') })
    vi.spyOn(child, 'followup').mockImplementationOnce(() => {
      throw new Error('parent closed during delivery')
    })

    const result = await callReport(ctx, grandchild, 'REJECTED_FOLLOWUP')

    expect(result.isError).toBe(true)
    expect(renderedText(result)).toContain('direct parent is not live; report was not delivered')
    expect(child.inbox.nextStep).toHaveLength(0)
    expect(child.inbox.nextTurn).toHaveLength(0)
    adapter.release()
    await vi.waitFor(() => { expect(ctx.agents.get(child.id)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('keeps a nested parent live until its steered report is claimed, then settles it once', async () => {
    const { ctx, parent, adapter } = await setup({ config: { reportDelivery: 'wakeup' } })
    const { child } = await startChild(ctx, parent, 'outer task')
    const { started: innerStart, child: grandchild } = await startChild(ctx, child, 'inner task')

    expect((await callReport(ctx, grandchild, 'STEERED_FINDING')).isError).toBe(false)

    expect(child.inbox.nextStep).toHaveLength(1)
    // Unclaimed next-step input keeps the nested parent resident.
    expect(ctx.agents.get(child.id)).toBe(child)

    adapter.release()
    await vi.waitFor(() => {
      expect(loggedReportFindings(child, innerStart.childId)).toEqual(['STEERED_FINDING'])
    })
    await vi.waitFor(() => { expect(ctx.agents.get(child.id)).toBeUndefined() }, { timeout: 5_000 })
    await vi.waitFor(() => {
      expect(settledNotices(parent).filter(notice => notice.sender === child.id)).toHaveLength(1)
    })
  })

  it('normalizes a direct parent send rejection', async () => {
    const { ctx, parent } = await setup()
    const { child } = await startChild(ctx, parent)
    vi.spyOn(parent, 'inject').mockImplementationOnce(() => {
      throw new Error('parent closed during delivery')
    })

    await expect(ctx.subagents.reportFrom(child, [{ type: 'text', text: 'rejected' }], {
      delivery: 'quiet',
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'PARENT_UNAVAILABLE' })
    expect(reports(parent)).toEqual([])
  })

  it('rejects roots, forged same-id senders, absent parents, cancellation, and drain', async () => {
    const { ctx, parent, adapter } = await setup()
    await expect(ctx.subagents.reportFrom(parent, [{ type: 'text', text: 'root' }], {
      delivery: 'quiet',
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    const disposable = await ctx.agents.create({
      sessionId: SessionId('disposable-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const { child } = await startChild(ctx, disposable.agent)
    const forged = { ...child } as Agent
    await expect(ctx.subagents.reportFrom(forged, [{ type: 'text', text: 'forged' }], {
      delivery: 'quiet',
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    const aborted = new AbortController()
    aborted.abort()
    expect((await callReport(ctx, child, 'cancelled', aborted.signal)).isError).toBe(true)

    await disposable.dispose()
    expect((await callReport(ctx, child, 'orphaned')).isError).toBe(true)

    adapter.release()
    const draining = ctx.subagents.drainContinuableDescendants([child])
    await expect(ctx.subagents.reportFrom(child, [{ type: 'text', text: 'draining' }], {
      delivery: 'quiet',
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'DRAINING' })
    await draining
  })

  it('revokes resident installations and defers later grants to the next Activation', async () => {
    const { ctx, parent, fiber } = await setup()
    const { child } = await startChild(ctx, parent)
    expect(ctx.tools.schemas(child).map(schema => schema.name)).toContain('report')
    expect(await sectionNames(ctx, child)).toContain('tool:report')

    await fiber?.dispose()
    expect(ctx.tools.schemas(child).map(schema => schema.name)).not.toContain('report')
    expect(await sectionNames(ctx, child)).not.toContain('tool:report')
    expect((await callReport(ctx, child, 'revoked')).isError).toBe(true)

    const late = await ctx.plugin(tool, { reportDelivery: 'quiet' })
    expect(ctx.tools.schemas(child).map(schema => schema.name)).not.toContain('report')
    expect(await sectionNames(ctx, child)).not.toContain('tool:report')
    await late.dispose()
  })

  it('rolls back prompt guidance when tool registration fails', async () => {
    const { ctx, parent } = await setup({ load: false })
    const { child } = await startChild(ctx, parent)
    const disposeConflict = registerReportConflict(child)

    expect(() => tool.installReportTool(child.ctx, ctx, 'quiet')).toThrow(/already registered in this scope/)
    expect(await sectionNames(ctx, child)).not.toContain('tool:report')
    disposeConflict()
  })

  it('aggregates a registration failure with a prompt rollback failure', async () => {
    const { ctx, parent } = await setup({ load: false })
    const { child } = await startChild(ctx, parent)
    const disposeConflict = registerReportConflict(child)
    const rollbackFailure = new Error('prompt rollback listener failed')
    let promptChanges = 0
    const off = ctx.on('system-prompt/change', () => {
      promptChanges++
      if (promptChanges === 2) throw rollbackFailure
    })

    let failure: unknown
    try {
      tool.installReportTool(child.ctx, ctx, 'quiet')
    } catch (error: unknown) {
      failure = error
    }
    off()

    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate installation failure')
    expect(failure.errors).toHaveLength(2)
    expect(String(failure.errors[0])).toContain('already registered in this scope')
    expect(failure.errors[1]).toBe(rollbackFailure)
    expect(await sectionNames(ctx, child)).not.toContain('tool:report')
    disposeConflict()
  })

  it('attempts both revocations and aggregates change-listener failures', async () => {
    const { ctx, parent } = await setup({ load: false })
    const { child } = await startChild(ctx, parent)
    const dispose = tool.installReportTool(child.ctx, ctx, 'quiet')
    const toolFailure = new Error('tool removal listener failed')
    const promptFailure = new Error('prompt removal listener failed')
    const offTool = ctx.on('tools/change', () => { throw toolFailure })
    const offPrompt = ctx.on('system-prompt/change', () => { throw promptFailure })

    let failure: unknown
    try {
      dispose()
    } catch (error: unknown) {
      failure = error
    }
    offPrompt()
    offTool()

    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate revocation failure')
    expect(failure.errors).toEqual([toolFailure, promptFailure])
    expect(ctx.tools.schemas(child).map(schema => schema.name)).not.toContain('report')
    expect(await sectionNames(ctx, child)).not.toContain('tool:report')
  })

  it('scopes the report guidance to the child that owns it', async () => {
    const { ctx, parent } = await setup()
    const { child } = await startChild(ctx, parent, 'first child')
    const { child: sibling } = await startChild(ctx, parent, 'second child')

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(child))
    const guidance = assembly.sections.find(section => section.name === 'tool:report')
    // Pins the model-visible instruction that makes the return channel a
    // contract rather than an option the child may quietly skip.
    expect(guidance?.text).toContain('Deliver your result with the report tool before you finish')
    expect(guidance?.text).toContain('reporting never ends your turn')

    expect(await sectionNames(ctx, parent)).not.toContain('tool:report')
    // A sibling installs its own copy; neither child can observe the other's.
    expect(await sectionNames(ctx, sibling)).toContain('tool:report')
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain('tool:report')
  })

  it('rolls back materialization when a setup contribution revokes itself', async () => {
    const { ctx, parent } = await setup({ load: false })
    const self: { revoke?: () => void } = {}
    self.revoke = ctx.subagents.registerContinuableSetup((childCtx) => {
      const dispose = childCtx.tools.register({
        name: 'racing-report',
        description: 'racing setup',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object', properties: {} }, render: () => [] },
        execute: () => Promise.resolve({}),
      })
      self.revoke?.()
      return dispose
    })

    // No session may be announced for the rejected child: the setup
    // validation must reject inside the creation callback, before the factory
    // publishes — a post-publication rejection would persist a resumable
    // ghost that `list_agents` surfaces and `send_message` can resurrect.
    // The parent was created inside setup(), so any later announcement is the
    // rejected child's.
    const announced: SessionId[] = []
    const listener = (session: { id: SessionId }): void => { announced.push(session.id) }
    const removeListener = ctx.on('session/created', listener)
    await expect(ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'racing child',
      request: {
        prompt: [{ type: 'text', text: 'racing child' }],
        parent,
      },
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'ACTIVATION_SETUP_REVOKED' })
    removeListener()
    expect(announced).toEqual([])
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
  })

  it('rolls back materialization when setup revocation lands before publication', async () => {
    const { ctx, parent } = await setup({ load: false })
    const self: { revoke?: () => void } = {}
    let installed = false
    self.revoke = ctx.subagents.registerContinuableSetup(() => {
      installed = true
      queueMicrotask(() => { self.revoke?.() })
      return () => { installed = false }
    })
    const announced: SessionId[] = []
    const removeListener = ctx.on('session/created', (session) => { announced.push(session.id) })

    await expect(ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'revoked child',
      request: {
        prompt: [{ type: 'text', text: 'revoked child' }],
        parent,
      },
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'ACTIVATION_SETUP_REVOKED' })
    removeListener()
    expect(installed).toBe(false)
    expect(announced).toEqual([])
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
    expect(ctx.sessions.list()).toEqual([parent.session])
  })

  it('accepts a report into a host-disposing but still-registered parent', async () => {
    const { ctx } = await setup()
    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('disposing-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const { child } = await startChild(ctx, parentHandle.agent)
    // Host-owned disposal starts asynchronously; the parent stays registered
    // until quiescence, and registry presence — not disposal state — is the
    // acceptance gate (pins the README contract).
    const disposing = parentHandle.dispose()
    const accepted = await callReport(ctx, child, 'during-close')
    expect(accepted.isError).toBe(false)
    await disposing
    expect((await callReport(ctx, child, 'after-close')).isError).toBe(true)
  })

  it('keeps the namespace plugin shape and validates its default', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-report')
    expect(tool.inject).toEqual(['subagents', 'tools', 'systemPrompt'])
    // Waking is the default because a report that never wakes its parent
    // cannot deliver a result to an agent that already parked.
    expect(tool.Config({}).reportDelivery).toBe('wakeup')
    expect(() => tool.Config({ reportDelivery: 'shout' } as never)).toThrow()
  })

  it('wakes the parent under the default configuration', async () => {
    const { ctx, parent, adapter } = await setup({ config: {} })
    const { child } = await startChild(ctx, parent)
    const enqueues: string[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === parent) {
        enqueues.push(agent.inbox.nextTurn.some(queued => queued.id === message.id) ? 'queued' : 'steering')
      }
    })

    expect((await callReport(ctx, child, 'DEFAULT_WAKES')).isError).toBe(false)
    expect(enqueues).toEqual(['queued'])
    await vi.waitFor(() => {
      expect(adapter.requests.some(request => request.sessionId === parent.id)).toBe(true)
    })
  })
})

/** Prove report delivery uses ordinary logged user messages (runtime-context snapshots excluded). */
function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind !== 'plugin'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

describe('shres-tool-subagent-report result independence', () => {
  it('does not report a final assistant answer automatically or create Jobs', async () => {
    const { ctx, parent, adapter } = await setup()
    const { started } = await startChild(ctx, parent)
    adapter.release()
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId) === undefined).toBe(true)
    }, { timeout: 5_000 })

    // The parent does learn the child settled — that account is the
    // continuation service's, carried under its own `subagent-settled` source.
    // Nothing turns the child's final answer into a report it did not send.
    expect(reports(parent)).toEqual([])
    expect(userTexts((await ctx.sessionPersistence.load(started.childId)).events)).toEqual(['child task'])
    expect(ctx.get('jobs')).toBeUndefined()
  })
})
