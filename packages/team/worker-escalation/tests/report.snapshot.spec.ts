/**
 * Keyless committed expected outputs for the one model-visible surface this
 * package adds: the blocked report a worker mails its Lead. The arm boots a
 * test-only `cordis.yml` through the real Loader and include builtin over the
 * real settings-file provider, the real session store, the real package, and a
 * test double for the two external boundaries — the Agent registry the ladder
 * resolves the worker through, and the Team mailbox it reports through. The
 * double delivers the way the mailbox does, so the Lead's committed log holds
 * the report as the ordinary `user/message` its conversation receives.
 *
 * The committed outputs are the complete model-visible report text and the
 * Lead's normalized durable log. Record with
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
import { CallId, MessageId } from '@shres-code/shres-code-llm'
import type { MessageSource, ToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import FileSettingsProvider from '@shres-code/shres-code-settings-file'
import * as WorkerEscalation from '../src/index.ts'
import { WORKER_ESCALATION_SETTINGS_NAMESPACE } from '../src/config.ts'

/** The package entry name the test-only composition uses. */
const PACKAGE = '@shres-code/shres-code-worker-escalation'

/** Cold-cache Loader resolution can exceed the default per-test budget. */
const COMPOSITION_TIMEOUT_MS = 60_000

/** One message the ladder asked the mailbox to deliver. */
interface SentMail {
  readonly target: string
  readonly text: string
}

/**
 * Team mailbox double. It records each send and delivers the report the way the
 * real mailbox does: an ordinary `user/message` on the target session whose
 * source kind is `team-message`.
 */
class SnapshotTeamMailbox extends Service {
  readonly sent: SentMail[] = []
  /** The Lead session deliveries land on. */
  lead: Session | undefined

  constructor(ctx: Context) {
    super(ctx, 'agentTeams')
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

/** Agent-registry double: the ladder only asks whether an Agent exists for a session id. */
class SnapshotAgents extends Service {
  private readonly agents = new Map<string, { readonly id: string; readonly session: Session }>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  /** Register one live agent. */
  register(session: Session): void {
    this.agents.set(session.id, { id: session.id, session })
  }

  /**
   * Resolve one registered agent.
   * @param id - session id the ladder asked about.
   * @returns the agent, or undefined when the session is not one.
   */
  get(id: string): { readonly id: string; readonly session: Session } | undefined {
    return this.agents.get(id)
  }
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

/** Flush the microtask the ladder evaluates from, and the report it starts. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Boot the test-only composition through the real Loader. */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'shres-worker-escalation-snapshot-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, '')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: settings',
    "  name: '@shres-code/shres-code-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    "- name: '@shres-code/shres-code-session'",
    "- name: '@test/worker-escalation-agents'",
    "- name: '@test/worker-escalation-team'",
    `- name: '${PACKAGE}'`,
    '  config:',
    '    enabled: true',
    '    maxContinues: 0',
    '    minStepsBetween: 0',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-settings-file', FileSettingsProvider],
    ['@shres-code/shres-code-session', SessionStore],
    ['@test/worker-escalation-agents', SnapshotAgents],
    ['@test/worker-escalation-team', SnapshotTeamMailbox],
    [PACKAGE, WorkerEscalation],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
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

/** The worker log that reaches the terminal: one failed approach on an open epoch. */
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
  session.append('step/start', { turn: 1, step: 1 })
  session.append('step/end', { turn: 1, step: 1 })
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
async function arm(): Promise<Delivery> {
  const loaded = await boot()
  expect(loaded.settings.get(WORKER_ESCALATION_SETTINGS_NAMESPACE)).toMatchObject({ enabled: true })
  const lead = loaded.sessions.create(SessionId('lead-session'))
  const agents = loaded.get('agents') as unknown as SnapshotAgents
  const mailbox = loaded.get('agentTeams') as unknown as SnapshotTeamMailbox
  mailbox.lead = lead
  const worker = loaded.sessions.create(SessionId('worker-snapshot'), {
    meta: { delegationDepth: 1, parentSession: lead.id },
  })
  agents.register(lead)
  agents.register(worker)
  drive(worker)
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

describe('blocked report snapshot', () => {
  it('delivers the bounded report into the Lead conversation as a team message', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const delivered = await arm()

    expect(await expectFixture('report-blocked.expected.txt', delivered.report)).toBe(delivered.report)
    expect(await expectFixture('lead-log.expected.jsonl', delivered.leadLog)).toBe(delivered.leadLog)

    // The envelope beside the compared text: one relay message on the Lead's log.
    expect(delivered.report).toContain('Worker report: blocked.')
    expect(delivered.leadLog).toContain('"kind":"team-message"')
    expect(delivered.leadLog).toContain('"surfaceOp":"append"')
    // The report is bounded by the digest cap the composition set.
    expect(delivered.report.length).toBeLessThan(4000)
  })
})
