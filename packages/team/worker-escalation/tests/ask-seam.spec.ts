/**
 * The ask-to-escalate through the real interaction ask seam. The suite composes
 * the shipped `UserQuestionService` and the shipped `AgentRegistry`, so the
 * seam's own admission decides every case: a worker session that is a runtime
 * root is asked directly, a worker owned by its parent is asked as the Team root
 * supervising it, and an owned worker with no live Team root is refused before
 * any provider runs. The two substituted parts are the external boundaries: the
 * UI that shows the question, and the Team service the ladder resolves its asker
 * through. The Team double answers `tryMembership` the way the shipped roster
 * does, naming the live Lead as an active teammate's root.
 *
 * The ladder's own decision is the other half of every case: `ask` records the
 * chosen option or the class that stopped the ask, and nothing else about the
 * decision changes. The suite drives real appends, so a decision is written by
 * the same microtask-scheduled evaluation production runs.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import AgentRegistry, { type Agent } from '@shres-code/shres-code-agent'
import { TeamId } from '@shres-code/shres-code-agent-team'
import type { TeamMembership } from '@shres-code/shres-code-agent-team'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import UserQuestionService from '@shres-code/shres-code-user-questions'
import type { AskUserQuestionRequest, UserQuestionProvider } from '@shres-code/shres-code-user-questions'
import * as WorkerEscalation from '../src/index.ts'
import { FakeJudgment } from './fake-judgment.ts'

/** The required judgment question text; no ask-to-escalate case reads it. */
const PROGRESS = 'Is this worker going to finish without help?'

/** The two option labels the human sees, in the order they are offered. */
const ESCALATE = 'Escalate to the Lead now'
const KEEP_WORKING = 'Keep working'

/** What one scripted UI does with an ask. */
type Script =
  | { readonly kind: 'answer'; readonly selected: string[]; readonly custom?: string; readonly id?: string }
  | { readonly kind: 'two-items'; readonly id?: string }
  | { readonly kind: 'throw'; readonly error: Error }

/** UI double: records every question it is shown and answers from one script. */
class StubQuestions implements UserQuestionProvider {
  /** Every question this provider received, in order. */
  readonly seen: AskUserQuestionRequest[] = []

  /** What the next ask does. */
  private script: Script = { kind: 'answer', selected: [ESCALATE] }

  /**
   * Replace the answer or failure every later ask produces.
   * @param script - the behavior to apply.
   */
  set(script: Script): void {
    this.script = script
  }

  /**
   * Record one ask and answer from the script.
   * @param request - the questions, agent, and signal the ladder sent.
   * @returns the scripted answer.
   */
  ask(request: AskUserQuestionRequest): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> {
    this.seen.push(request)
    if (this.script.kind === 'throw') return Promise.reject(this.script.error)
    const id = this.script.id ?? request.questions[0]?.id ?? 'missing'
    if (this.script.kind === 'two-items') {
      return Promise.resolve({
        answers: [{ id, selected: [ESCALATE] }, { id, selected: [KEEP_WORKING] }],
      })
    }
    return Promise.resolve({
      answers: [{
        id,
        selected: [...this.script.selected],
        ...this.script.custom === undefined ? {} : { custom: this.script.custom },
      }],
    })
  }
}

/**
 * Team double: the mailbox the terminal reports through, and the membership the
 * ladder resolves its asker through. `tryMembership` mirrors the shipped roster:
 * the live Lead is an active teammate's root, and the Lead is its own lead row.
 */
class StubTeams extends Service {
  /** Every report the ladder asked this mailbox to deliver. */
  readonly sent: string[] = []

  private liveRoot: Agent | undefined

  constructor(ctx: Context) {
    super(ctx, 'agentTeams')
  }

  /**
   * Set the live Team root this double reports, or clear it.
   * @param root - the live Lead agent, or undefined for a worker that is not a member.
   */
  setRoot(root: Agent | undefined): void {
    this.liveRoot = root
  }

  /**
   * Accept one report.
   * @param request - the target and content the ladder sent.
   * @returns an accepted mailbox result.
   */
  sendMessage(_agent: unknown, request: { readonly target: string; readonly content: readonly { readonly text?: string }[] }): Promise<{ messageId: string; status: 'accepted' }> {
    this.sent.push(request.content.map(part => part.text ?? '').join(''))
    return Promise.resolve({ messageId: 'm-1', status: 'accepted' })
  }

  /**
   * Resolve one live Agent's Team role.
   * @param agent - the candidate live Agent.
   * @returns its membership, or undefined when this Team is not the one.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    const root = this.liveRoot
    if (root === undefined) return undefined
    const isRoot = agent.id === root.id
    return { root, id: TeamId(root.id), role: isRoot ? 'lead' : 'teammate', name: isRoot ? 'lead' : 'worker' }
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

/** Flush the microtask the ladder evaluates from, and the ask it awaits. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Structural Agent: the shape the shipped registry and seam both accept. */
function stubAgent(id: string, session: Session): Agent {
  const agentId = id as Agent['id']
  return { id: agentId, session: { id: agentId, header: session.header } } as unknown as Agent
}

/** One booted ladder plus the seams it reaches. */
interface Booted {
  readonly ctx: Context
  readonly agents: AgentRegistry | undefined
  readonly questions: StubQuestions | undefined
  readonly teams: StubTeams | undefined
}

/**
 * Boot the ladder over the real session store, the real Agent registry, and the
 * real user-questions service.
 * @param config - ladder fields beyond the required question text.
 * @param options - `questions: false` omits the ask seam, `agents: false` omits
 *   the registry, `team: false` omits the Team service, and `judgment: true`
 *   mounts a scripted engine beside them.
 * @returns the context and every double the composition carries.
 */
async function boot(
  config: Record<string, unknown>,
  options: { readonly questions?: boolean; readonly judgment?: boolean; readonly agents?: boolean; readonly team?: boolean } = {},
): Promise<Booted> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  let agents: AgentRegistry | undefined
  if (options.agents !== false) {
    await ctx.plugin(AgentRegistry)
    agents = ctx.get('agents')
  }
  let questions: StubQuestions | undefined
  if (options.questions !== false) {
    await ctx.plugin(UserQuestionService)
    questions = new StubQuestions()
    ctx.userQuestions.registerProvider(questions)
  }
  let teams: StubTeams | undefined
  if (options.team !== false) {
    await ctx.plugin(StubTeams)
    teams = ctx.get('agentTeams') as unknown as StubTeams
  }
  if (options.judgment === true) await ctx.plugin(FakeJudgment)
  await ctx.plugin(WorkerEscalation, { enabled: true, minStepsBetween: 0, askToEscalate: true, progressInstructions: PROGRESS, ...config })
  return { ctx, agents, questions, teams }
}

/** One failing tool call and its errored result: the shortest firing trigger. */
function failing(session: Session, index: number): SessionEvent<'tool/result'> {
  const callId = CallId('call-' + String(index))
  const called = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'bash',
    arguments: JSON.stringify({ command: 'a' + String(index) }),
  })
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'boom' }], isError: true }),
  }, { surfaceOp: 'append', sourceEventSeqs: [called.seq] })
}

/** One finished step, which is the unit the cooldown counts. */
function completeStep(session: Session, step: number): void {
  session.append('step/start', { turn: 1, step })
  session.append('step/end', { turn: 1, step })
}

/** Every ladder decision in a session log. */
function decisions(session: Session): SessionEvent<'escalation/decision'>[] {
  return session.events.filter(
    (event): event is SessionEvent<'escalation/decision'> => event.type === 'escalation/decision',
  )
}

/**
 * Drive one firing trigger on a worker session and let the ladder decide.
 * @param session - the worker session to drive.
 * @returns the same session, after the microtask that writes its decision.
 */
async function drive(session: Session): Promise<Session> {
  failing(session, 1)
  failing(session, 2)
  await settle()
  return session
}

/** One enrolled worker: its session, and the live root owning it when it has one. */
interface Enrolled {
  readonly worker: Session
  readonly root?: Agent | undefined
}

/**
 * Create one worker session and register its live Agent.
 * @param booted - the booted ladder.
 * @param id - session id.
 * @param owner - `root` registers the worker as its own runtime root,
 *   `delegated` registers it as the child of a live root at `lead-root-<id>`,
 *   and `none` registers no Agent at all.
 * @returns the worker and the owning root when one was registered.
 * @throws Error when the case needs the registry and the composition omitted it.
 */
function enroll(booted: Booted, id: string, owner: 'root' | 'delegated' | 'none'): Enrolled {
  const agents = booted.agents
  if (agents === undefined) throw new Error('this case needs the live agent registry')
  const worker = booted.ctx.sessions.create(SessionId(id), { meta: { delegationDepth: 1 } })
  if (owner === 'root') {
    agents.enter(stubAgent(id, worker), undefined)
    return { worker }
  }
  if (owner === 'delegated') {
    const rootId = 'lead-root-' + id
    const root = stubAgent(rootId, booted.ctx.sessions.create(SessionId(rootId)))
    agents.enter(root, undefined)
    agents.enter(stubAgent(id, worker), root)
    return { worker, root }
  }
  return { worker }
}

describe('the ask-to-escalate through the real ask seam', () => {
  it('asks as the Team root when the worker is an owned child', async () => {
    const booted = await boot({})
    const { worker, root } = enroll(booted, 'worker-through-root', 'delegated')
    booted.teams?.setRoot(root)
    await drive(worker)

    // The seam refuses an owned child, so the ask rides the Team root instead: the
    // human answers in that root's session, and the question names the worker.
    expect(booted.questions?.seen).toHaveLength(1)
    const asked = booted.questions?.seen[0]
    expect(asked?.agent).toBe(root)
    expect(asked?.agent).toBe(booted.agents?.get(SessionId('lead-root-worker-through-root')))
    expect(asked?.questions[0]?.question).toContain('Worker worker-through-root looks stuck')

    const logged = decisions(worker)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data.ask).toEqual({ reason: 'answered', option: 'escalate' })
    expect(logged[0]?.data.choice).toBe('continue')
  })

  it('refuses an owned worker that has no live Team root', async () => {
    const booted = await boot({})
    const { worker } = enroll(booted, 'worker-without-root', 'delegated')
    await drive(worker)

    // A Team service that reports no membership leaves the worker as the asker,
    // which is exactly the caller the seam refuses.
    expect(booted.questions?.seen).toEqual([])
    expect(decisions(worker)[0]?.data.ask).toEqual({ reason: 'delegated-caller' })
  })

  it('refuses an owned worker when no Team service is composed', async () => {
    const booted = await boot({}, { team: false })
    const { worker } = enroll(booted, 'worker-without-team', 'delegated')
    await drive(worker)

    expect(booted.questions?.seen).toEqual([])
    expect(decisions(worker)[0]?.data.ask).toEqual({ reason: 'delegated-caller' })
  })

  it('asks a worker that is its own runtime root and logs the chosen option', async () => {
    const booted = await boot({})
    const { worker } = enroll(booted, 'worker-root', 'root')
    await drive(worker)

    // One question, with the two options as the human reads them.
    expect(booted.questions?.seen).toHaveLength(1)
    const question = booted.questions?.seen[0]?.questions[0]
    expect(question).toMatchObject({
      id: 'worker-escalation',
      header: 'Worker escalation',
      question: 'Worker worker-root looks stuck: its errorBurst trigger fired at event 3. Escalate it to the Lead now?',
      options: [
        { label: ESCALATE, description: 'Record that this worker should be escalated to the Lead now. The choice is logged; nothing is sent.' },
        { label: KEEP_WORKING, description: 'Record that this worker should keep going. The ladder asks again after the next firing trigger.' },
      ],
    })
    // The detail is the bounded digest: what the worker was doing when it stuck.
    expect(question?.detail).toContain('Worker session id: worker-root')
    expect(question?.detail).toContain('Recent tool outcomes:')
    expect(booted.questions?.seen[0]?.agent).toBe(booted.agents?.get(SessionId('worker-root')))

    const logged = decisions(worker)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data.ask).toEqual({ reason: 'answered', option: 'escalate' })
    // Nothing executes on the answer: the choice stays the Stage 0 continue and
    // the worker's own conversation receives nothing.
    expect(logged[0]?.data.choice).toBe('continue')
    expect(worker.events.filter(event => event.type === 'user/message')).toEqual([])
  })

  it('maps the second option back to its own vocabulary', async () => {
    const booted = await boot({})
    booted.questions?.set({ kind: 'answer', selected: [KEEP_WORKING] })
    const { worker } = enroll(booted, 'worker-keep-working', 'root')
    await drive(worker)

    const logged = decisions(worker)
    expect(logged[0]?.data.ask).toEqual({ reason: 'answered', option: 'keep-working' })
  })

  it('is not gated by any judgment threshold', async () => {
    const booted = await boot({}, { judgment: true })
    // An answer below both gates still leaves the human ask in place.
    const judgment = booted.ctx.get('judgment') as unknown as FakeJudgment
    judgment.script({ confidence: 0.1, probabilities: { continue: 0.51, 'needs-help': 0.49 } })
    const { worker } = enroll(booted, 'worker-low-confidence-asked', 'root')
    await drive(worker)

    const logged = decisions(worker)
    expect(logged[0]?.data).toMatchObject({ reason: 'low-confidence', engine: 'ok' })
    expect(logged[0]?.data.ask).toEqual({ reason: 'answered', option: 'escalate' })
  })

  it('records each seam failure under its own class', async () => {
    const absent = await boot({}, { questions: false })
    const withoutSeam = decisions(await drive(enroll(absent, 'worker-without-seam', 'root').worker))

    const orphan = await boot({})
    const withoutAgent = decisions(await drive(enroll(orphan, 'worker-without-agent', 'none').worker))

    const noRegistry = await boot({}, { agents: false })
    const orphanOfRegistry = decisions(await drive(
      noRegistry.ctx.sessions.create(SessionId('worker-without-registry'), { meta: { delegationDepth: 1 } }),
    ))

    const failing = await boot({})
    failing.questions?.set({ kind: 'throw', error: new Error('the provider is down') })
    const unavailable = decisions(await drive(enroll(failing, 'worker-provider-down', 'root').worker))

    const cases = [
      [withoutSeam, { reason: 'seam-absent' }],
      [withoutAgent, { reason: 'agent-absent' }],
      [orphanOfRegistry, { reason: 'agent-absent' }],
      [unavailable, { reason: 'seam-unavailable' }],
    ] as const
    for (const [logged, expected] of cases) {
      expect(logged).toHaveLength(1)
      expect(logged[0]?.data.ask).toEqual(expected)
      expect(logged[0]?.data.choice).toBe('continue')
    }
  })

  it('records an unusable answer as invalid, without an option', async () => {
    const scripts: readonly Script[] = [
      // A question this ladder did not ask.
      { kind: 'answer', selected: [ESCALATE], id: 'someone-elses-question' },
      // Custom text alongside a selected label overrides it.
      { kind: 'answer', selected: [ESCALATE], custom: 'do something else' },
      // No option at all, which a UI may report for a skipped question.
      { kind: 'answer', selected: [] },
      // More than one option, on a question that is not multi-select.
      { kind: 'answer', selected: [ESCALATE, KEEP_WORKING] },
      // A label the question does not offer.
      { kind: 'answer', selected: ['Escalate to the Lead'] },
      // The same question answered twice cannot name one choice.
      { kind: 'two-items' },
    ]
    for (const [index, script] of scripts.entries()) {
      const booted = await boot({})
      booted.questions?.set(script)
      const { worker } = enroll(booted, 'worker-unusable-' + String(index), 'root')
      await drive(worker)

      const logged = decisions(worker)
      expect(logged).toHaveLength(1)
      expect(logged[0]?.data.ask).toEqual({ reason: 'invalid-answer' })
    }
  })

  it('asks nothing while askToEscalate is off, and writes no ask field', async () => {
    const booted = await boot({ askToEscalate: false })
    const { worker } = enroll(booted, 'worker-ask-off', 'root')
    await drive(worker)

    expect(booted.questions?.seen).toEqual([])
    const logged = decisions(worker)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data).not.toHaveProperty('ask')
  })

  it('asks nothing for the terminal, which already reports to the Lead', async () => {
    const booted = await boot({ maxContinues: 0 })
    const { worker } = enroll(booted, 'worker-terminal-no-ask', 'root')
    await drive(worker)

    expect(booted.questions?.seen).toEqual([])
    const logged = decisions(worker)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data).toMatchObject({ choice: 'report-blocked', reason: 'max-continues' })
    expect(logged[0]?.data).not.toHaveProperty('ask')
  })

  it('asks once per decision, not once per event', async () => {
    const booted = await boot({ minStepsBetween: 2 })
    const { worker } = enroll(booted, 'worker-one-ask', 'root')
    await drive(worker)
    // The cooldown counts completed steps, so the first decision waits for them.
    expect(booted.questions?.seen).toEqual([])
    completeStep(worker, 1)
    completeStep(worker, 2)
    await settle()
    expect(booted.questions?.seen).toHaveLength(1)

    // Completing more steps clears the cooldown, but a standing trigger points at
    // the event the first decision already recorded: still one ask.
    completeStep(worker, 3)
    completeStep(worker, 4)
    await settle()
    expect(booted.questions?.seen).toHaveLength(1)
    expect(decisions(worker)).toHaveLength(1)

    // Fresh evidence earns the next decision and its own ask.
    failing(worker, 3)
    await settle()
    expect(booted.questions?.seen).toHaveLength(2)
    expect(decisions(worker)).toHaveLength(2)
  })
})
