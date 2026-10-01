/**
 * Keyless committed expected outputs for the two human-facing surfaces this
 * package produces: the blocked report a worker mails its Lead, and the
 * ask-to-escalate question the human answers. Each arm boots a test-only
 * `cordis.yml` through the real Loader and include builtin over the real
 * settings-file provider, the real session store, the real Agent registry, the
 * real user-questions seam, and the real package, with one test double for the
 * external boundary that arm needs: the Team mailbox, or the UI that answers a
 * question. The mailbox double delivers the way the mailbox does, so the Lead's
 * committed log holds the report as the ordinary `user/message` its conversation
 * receives; the UI double renders nothing of its own, so the committed question
 * is exactly what a provider hands the human.
 *
 * The ask arm enters its worker as its own runtime root, because the seam admits
 * an ask only for the session's exact live runtime root; a worker the Team
 * spawns is owned by its parent and refused with `DELEGATED_CALLER` before any
 * provider runs (`tests/ask-seam.spec.ts` pins that case).
 *
 * The committed outputs are the complete model-visible report text, the Lead's
 * normalized durable log, the question as the human receives it, and the worker's
 * normalized durable decision log. Record with
 * `SHRES_SNAPSHOT=refresh npx vitest run packages/team/worker-escalation/tests/report.snapshot.spec.ts`;
 * every other run replays and compares.
 *
 * The repository's snapshot lane discovers only scenario modules under an
 * example's tests directory, and no example composes a Team plus a delegated
 * worker, so this arm keeps the same contract inside the package beside the
 * real-composition suite the way the compaction provider's snapshot arms do.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@shres-code/shres-code-agent'
import { TeamId } from '@shres-code/shres-code-agent-team'
import type { TeamMembership } from '@shres-code/shres-code-agent-team'
import { CallId, MessageId } from '@shres-code/shres-code-llm'
import type { MessageSource, ToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import FileSettingsProvider from '@shres-code/shres-code-settings-file'
import UserQuestionService from '@shres-code/shres-code-user-questions'
import type { AskUserQuestionRequest, UserQuestionProvider } from '@shres-code/shres-code-user-questions'
import * as WorkerEscalation from '../src/index.ts'
import { WORKER_ESCALATION_SETTINGS_NAMESPACE } from '../src/config.ts'

/** The package entry name the test-only composition uses. */
const PACKAGE = '@shres-code/shres-code-worker-escalation'

/** Cold-cache Loader resolution can exceed the default per-test budget. */
const COMPOSITION_TIMEOUT_MS = 60_000

/** The option label the UI double answers with, as a human would click it. */
const ESCALATE = 'Escalate to the Lead now'

/** One message the ladder asked the mailbox to deliver. */
interface SentMail {
  readonly target: string
  readonly text: string
}

/**
 * Team double. It records each send and delivers the report the way the real
 * mailbox does — an ordinary `user/message` on the target session whose source
 * kind is `team-message` — and it answers `tryMembership` the way the shipped
 * roster does, naming the live Lead as its teammate's root, which is the asker
 * the ladder resolves for a worker it cannot ask directly.
 */
class SnapshotTeamMailbox extends Service {
  readonly sent: SentMail[] = []
  /** The Lead session deliveries land on. */
  lead: Session | undefined
  /** The live Lead agent, which is the root this double reports. */
  root: Agent | undefined

  constructor(ctx: Context) {
    super(ctx, 'agentTeams')
  }

  /**
   * Resolve one live Agent's Team role.
   * @param agent - the candidate live Agent.
   * @returns its membership, or undefined while this double has no live root.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    const root = this.root
    if (root === undefined) return undefined
    const isRoot = agent.id === root.id
    return { root, id: TeamId(root.id), role: isRoot ? 'lead' : 'teammate', name: isRoot ? 'lead' : 'worker' }
  }

  /**
   * Deliver one report into the Lead's conversation.
   * @param request - the target, content, and signal the ladder sent.
   * @returns the accepted mailbox result.
   */
  sendMessage(_agent: unknown, request: { readonly target: string; readonly content: readonly { readonly type: string; readonly text?: string }[]; readonly signal: AbortSignal }): Promise<{ messageId: string; status: 'accepted' }> {
    const text = request.content.map(part => part.text ?? '').join('')
    this.sent.push({ target: request.target, text })
    const lead = this.lead
    if (lead === undefined) throw new Error('the snapshot mailbox has no Lead session to deliver to')
    lead.append('user/message', {
      id: MessageId('team-message-1'),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'team-message',
        form: 'relay',
        teamId: 'team-lead',
        messageId: 'team-message-1',
        senderSessionId: 'worker-snapshot',
        senderName: 'worker',
      } as unknown as MessageSource,
    }, { surfaceOp: 'append' })
    return Promise.resolve({ messageId: 'm-1', status: 'accepted' })
  }
}

/**
 * UI double, standing in for the client that shows a question and returns the
 * human's click. It renders nothing and invents no wording: the recorded request
 * is the surface a human sees.
 */
class SnapshotQuestions implements UserQuestionProvider {
  /** Every question this UI was shown, in order. */
  readonly seen: AskUserQuestionRequest[] = []

  /**
   * Record one question and answer it as the human would.
   * @param request - the questions, agent, and signal the ladder sent.
   * @returns the answer naming the recorded option label.
   */
  ask(request: AskUserQuestionRequest): Promise<{ answers: { id: string; selected: string[] }[] }> {
    this.seen.push(request)
    return Promise.resolve({
      answers: [{ id: request.questions[0]?.id ?? 'missing', selected: [ESCALATE] }],
    })
  }
}

/** Structural Agent: the identity the shipped registry and the ask seam both accept. */
function stubAgent(id: string, session: Session): Agent {
  const agentId = id as Agent['id']
  // A registered root agent needs a scoped context for its model-selection hook.
  return { id: agentId, ctx: new Context(), session: { id: agentId, header: session.header } } as unknown as Agent
}

const snapshotsDir = join(dirname(fileURLToPath(import.meta.url)), 'snapshots', 'worker-escalation')
const refreshing = process.env['SHRES_SNAPSHOT'] === 'refresh'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Flush the microtask the ladder evaluates from, and the ask or report it starts. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Boot the test-only composition through the real Loader.
 * @param config - the ladder config the composition passes its entry.
 * @returns the loaded context.
 */
async function boot(config: Record<string, unknown>): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'shres-worker-escalation-snapshot-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, '')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: settings',
    "  name: '@shres-code/shres-code-settings-file'",
    '  config:',
    '    path: ' + JSON.stringify(settingsPath),
    '    debounceMs: 10',
    "- name: '@shres-code/shres-code-session'",
    "- name: '@shres-code/shres-code-agent'",
    "- name: '@shres-code/shres-code-user-questions'",
    "- name: '@test/worker-escalation-team'",
    "- name: '" + PACKAGE + "'",
    '  config:',
    ...Object.entries(config).map(([key, value]) => '    ' + key + ': ' + JSON.stringify(value)),
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-settings-file', FileSettingsProvider],
    ['@shres-code/shres-code-session', SessionStore],
    ['@shres-code/shres-code-agent', AgentRegistry],
    ['@shres-code/shres-code-user-questions', UserQuestionService],
    ['@test/worker-escalation-team', SnapshotTeamMailbox],
    [PACKAGE, WorkerEscalation],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error('unexpected Loader import: ' + specifier)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** One failing tool call and its errored result. */
function failing(session: Session, index: number, command: string): void {
  const callId = CallId('call-' + String(index))
  const called = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'bash',
    arguments: JSON.stringify({ command }),
  })
  const message: ToolResultMessage = {
    id: MessageId('result-' + String(index)),
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'exit status 1' }], isError: true }],
  }
  session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append', sourceEventSeqs: [called.seq] })
}

/**
 * The assignment and the two failed approaches every arm starts from: the
 * shortest log that carries a Team assignment and fires a trigger.
 * @param session - the worker session to drive.
 */
function drive(session: Session): void {
  session.append('user/message', {
    id: MessageId('prompt-1'),
    role: 'user',
    content: [{ type: 'text', text: 'Fix the failing parser test.' }],
    source: {
      kind: 'team-message',
      form: 'relay',
      teamId: 'team-lead',
      messageId: 'assignment-1',
      senderSessionId: 'lead-session',
      senderName: 'lead',
    } as unknown as MessageSource,
  }, { surfaceOp: 'append' })
  failing(session, 1, 'pnpm test')
  failing(session, 2, 'pnpm test -- --run')
}

/** One finished step, which is the unit the cooldown counts. */
function completeStep(session: Session, step: number): void {
  session.append('step/start', { turn: 1, step })
  session.append('step/end', { turn: 1, step })
}

/**
 * Normalize one session's durable log: event order, type, payload, and append
 * envelope, with the composed Team message identity tokenized. Wall-clock
 * stamps are excluded.
 * @param session - the session to normalize.
 * @param messageIds - message identities to tokenize.
 * @returns one JSON record per event.
 */
function normalizeLog(session: Session, messageIds: readonly string[]): string {
  const records = session.events.map(event => ({
    type: event.type,
    data: event.data,
    surfaceOp: 'surfaceOp' in event ? event.surfaceOp : undefined,
    ignorable: 'ignorable' in event ? event.ignorable : undefined,
  }))
  let rendered = JSON.stringify(records)
  for (const id of messageIds) rendered = rendered.replaceAll(id, '{{messageId}}')
  return rendered + '\n'
}

/**
 * Render one question exactly as the UI hands it to the human: the heading, the
 * question, the supporting detail, and each option with its description.
 * @param request - the ask request a provider received.
 * @returns the human-facing text.
 */
function renderQuestion(request: AskUserQuestionRequest): string {
  const question = request.questions[0]
  if (question === undefined) throw new Error('the ask carried no question')
  const options = (question.options ?? []).map(option => '- ' + option.label + ' — ' + (option.description ?? ''))
  return [
    // The session whose view shows the question: for a worker the Team spawned it is
    // the root that supervises it, which is where the human reads the team.
    'Shown in session: ' + (request.agent?.id ?? 'no agent'),
    'Header: ' + (question.header ?? ''),
    'Question: ' + question.question,
    'Detail:',
    question.detail ?? '',
    '',
    'Options:',
    ...options,
  ].join('\n')
}

/**
 * Compare one output with its committed fixture, writing it in refresh mode.
 * The fixture file always ends in one newline; the compared value never does.
 * @param name - fixture file name.
 * @param output - the recorded output.
 * @returns the recorded output.
 */
async function expectFixture(name: string, output: string): Promise<string> {
  const file = join(snapshotsDir, name)
  const body = output.endsWith('\n') ? output : output + '\n'
  if (refreshing) {
    await mkdir(snapshotsDir, { recursive: true })
    await writeFile(file, body)
    return output
  }
  expect(body, name).toBe(await readFile(file, 'utf8'))
  return output
}

/** The delivery a send produced on the Lead's log. */
interface Delivery {
  readonly report: string
  readonly leadLog: string
}

/** Drive one terminal report through the composed package and return what the Lead received. */
async function reportArm(): Promise<Delivery> {
  const loaded = await boot({ enabled: true, maxContinues: 0, minStepsBetween: 0, progressInstructions: 'Is this worker going to finish without help?' })
  expect(loaded.settings.get(WORKER_ESCALATION_SETTINGS_NAMESPACE)).toMatchObject({ enabled: true })
  const lead = loaded.sessions.create(SessionId('lead-session'))
  const agents = loaded.get('agents') as AgentRegistry
  const mailbox = loaded.get('agentTeams') as unknown as SnapshotTeamMailbox
  mailbox.lead = lead
  const worker = loaded.sessions.create(SessionId('worker-snapshot'), {
    meta: { delegationDepth: 1, parentSession: lead.id },
  })
  agents.enter(stubAgent(lead.id, lead), undefined)
  agents.enter(stubAgent(worker.id, worker), agents.get(lead.id))
  drive(worker)
  completeStep(worker, 1)
  await settle()

  const delivered = lead.events.filter(
    (event): event is SessionEvent<'user/message'> => event.type === 'user/message',
  )
  expect(delivered).toHaveLength(1)
  const report = delivered[0]?.data.content.map(part => part.type === 'text' ? part.text : '').join('') ?? ''
  return {
    report,
    leadLog: normalizeLog(lead, ['team-message-1']),
  }
}

/** The question one ask arm showed the human, and the decision it wrote. */
interface Asked {
  readonly question: string
  readonly decisionLog: string
}

/** Drive one ask-to-escalate through the composed package and return what the human saw. */
async function askArm(): Promise<Asked> {
  const loaded = await boot({
    enabled: true,
    maxContinues: 3,
    minStepsBetween: 0,
    askToEscalate: true,
    progressInstructions: 'Is this worker going to finish without help?',
  })
  const agents = loaded.get('agents') as AgentRegistry
  const questions = new SnapshotQuestions()
  loaded.userQuestions.registerProvider(questions)
  const lead = loaded.sessions.create(SessionId('lead-session'))
  const mailbox = loaded.get('agentTeams') as unknown as SnapshotTeamMailbox
  const leadAgent = stubAgent(lead.id, lead)
  agents.enter(leadAgent, undefined)
  mailbox.root = leadAgent
  // A worker the Team spawned is owned by its Lead, which the seam refuses as a
  // caller: the ask rides the live Team root instead, and the human answers it in
  // the Lead's session.
  const worker = loaded.sessions.create(SessionId('worker-ask-snapshot'), {
    meta: { delegationDepth: 1, parentSession: lead.id },
  })
  agents.enter(stubAgent(worker.id, worker), leadAgent)
  drive(worker)
  completeStep(worker, 1)
  await settle()

  expect(questions.seen).toHaveLength(1)
  const asked = questions.seen[0]
  if (asked === undefined) throw new Error('the ask arm recorded no question')
  expect(asked.agent).toBe(leadAgent)
  const decisions = worker.events.filter(event => event.type === 'escalation/decision')
  expect(decisions).toHaveLength(1)
  expect(decisions[0]?.data).toMatchObject({ ask: { reason: 'answered', option: 'escalate' } })
  return {
    question: renderQuestion(asked),
    decisionLog: normalizeLog(worker, []),
  }
}

describe('snapshots of the package', () => {
  it('delivers the bounded report into the Lead conversation as a team message', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const delivered = await reportArm()

    expect(await expectFixture('report-blocked.expected.txt', delivered.report)).toBe(delivered.report)
    expect(await expectFixture('lead-log.expected.jsonl', delivered.leadLog)).toBe(delivered.leadLog)

    // The envelope beside the compared text: one relay message on the Lead's log.
    expect(delivered.report).toContain('Worker report: blocked.')
    expect(delivered.leadLog).toContain('"kind":"team-message"')
    expect(delivered.leadLog).toContain('"surfaceOp":"append"')
    // The report is bounded by the digest cap the composition set.
    expect(delivered.report.length).toBeLessThan(4000)
  })

  it('shows the human the two-option question and logs the option they chose', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const asked = await askArm()

    expect(await expectFixture('escalate-ask.expected.txt', asked.question)).toBe(asked.question)
    expect(await expectFixture('escalate-decision.expected.jsonl', asked.decisionLog)).toBe(asked.decisionLog)

    // The question's own contract, beside the compared text: two options, and the
    // trigger and digest that tell the human which worker this is about.
    expect(asked.question).toContain('Shown in session: lead-session')
    expect(asked.question).toContain('Escalate to the Lead now')
    expect(asked.question).toContain('Keep working')
    expect(asked.question).toContain('its errorBurst trigger fired at event 4')
    expect(asked.question).toContain('Fix the failing parser test.')
    expect(asked.decisionLog).toContain('"reason":"answered"')
  })
})
