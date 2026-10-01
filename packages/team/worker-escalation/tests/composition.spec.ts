/**
 * REAL Loader composition: a test-only `cordis.yml` mounts the real settings
 * file provider, the real session store, and this package, and the real Loader
 * with its include builtin boots it. Nothing here is hand-mounted, so a default
 * export, a dropped named export, or a mis-registered settings namespace fails
 * the same way it would in a deployment.
 *
 * The composition pins three facts: the `worker-escalation` settings namespace
 * registers and disposes with the entry fiber, the ladder writes nothing while
 * it is off (its shipped default), and a committed settings change turns it on
 * for the next decision.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import { CallId, MessageId } from '@shres-code/shres-code-llm'
import type { ToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import FileSettingsProvider from '@shres-code/shres-code-settings-file'
import * as WorkerEscalation from '../src/index.ts'
import { WORKER_ESCALATION_SETTINGS_NAMESPACE } from '../src/config.ts'

/** The package entry name the test-only composition uses. */
const PACKAGE = '@shres-code/shres-code-worker-escalation'

/** Cold-cache Loader resolution can exceed the default per-test budget. */
const COMPOSITION_TIMEOUT_MS = 60_000

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Flush the microtask the ladder evaluates from. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Boot the test-only composition through the real Loader and include builtin. */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'shres-worker-escalation-loader-'))
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
    `- name: '${PACKAGE}'`,
    '  config:',
    '    enabled: false',
    "    progressInstructions: 'Is this worker going to finish without help?'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-settings-file', FileSettingsProvider],
    ['@shres-code/shres-code-session', SessionStore],
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

/** The package's own Loader entry. */
function packageEntry(loaded: Context) {
  const entry = [...loaded.loader.entries()].find(candidate => candidate.options.name === PACKAGE)
  if (entry === undefined) throw new Error('the composition did not mount the worker-escalation entry')
  return entry
}

/** The resolved `worker-escalation` settings section, or undefined while unregistered. */
function section(loaded: Context): { enabled?: boolean } | undefined {
  return loaded.settings.get(WORKER_ESCALATION_SETTINGS_NAMESPACE) as { enabled?: boolean } | undefined
}

/** One worker session of the loaded composition. */
function worker(loaded: Context, id: string): Session {
  return loaded.sessions.create(SessionId(id), { meta: { delegationDepth: 1 } })
}

/** One failing tool call and its errored result. */
function failing(session: Session, index: number): void {
  const callId = CallId('call-' + String(index))
  const called = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'bash',
    arguments: JSON.stringify({ command: 'a' + String(index) }),
  })
  const message: ToolResultMessage = {
    id: MessageId('result-' + String(index)),
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'boom' }], isError: true }],
  }
  session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append', sourceEventSeqs: [called.seq] })
}

/** One finished step, which is the unit the cooldown counts. */
function completeStep(session: Session, step: number): void {
  session.append('step/start', { turn: 1, step })
  session.append('step/end', { turn: 1, step })
}

/** Drive one firing script: two failed approaches and the completed steps the cooldown needs. */
function drive(session: Session): void {
  failing(session, 1)
  failing(session, 2)
  completeStep(session, 1)
  completeStep(session, 2)
}

/** Every ladder decision in a session log. */
function decisions(session: Session): number {
  return session.events.filter(event => event.type === 'escalation/decision').length
}

describe('worker-escalation real composition', () => {
  it('boots the named exports the Loader reads, with no default export', () => {
    expect('default' in WorkerEscalation).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(WorkerEscalation)).toBe(WorkerEscalation)
    expect(WorkerEscalation.name).toBe('worker-escalation')
    expect(WorkerEscalation.Config).toBeDefined()
    expect(typeof WorkerEscalation.apply).toBe('function')
  })

  it('registers the settings namespace with the fiber and writes nothing while off', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('settings')).toBeInstanceOf(FileSettingsProvider)
    expect(loaded.settings.describe().map(descriptor => descriptor.ns)).toContain(WORKER_ESCALATION_SETTINGS_NAMESPACE)
    expect(section(loaded)).toMatchObject({ enabled: false })
    // The ask-to-escalate switch is part of the section, off by default.
    expect(section(loaded)).toMatchObject({ askToEscalate: false })

    // The shipped default is off: a firing script writes nothing at all.
    const quiet = worker(loaded, 'worker-composition-off')
    drive(quiet)
    await settle()
    expect(decisions(quiet)).toBe(0)

    // The settings change is committed, and the next decision reads it.
    await loaded.settings.replace(WORKER_ESCALATION_SETTINGS_NAMESPACE, { enabled: true })
    expect(section(loaded)).toMatchObject({ enabled: true })
    const live = worker(loaded, 'worker-composition-on')
    drive(live)
    await settle()
    expect(live.events.filter(event => event.type === 'escalation/decision').map(event => event.data)).toEqual([
      expect.objectContaining({ trigger: 'errorBurst', choice: 'continue', engine: 'absent' }),
    ])
  })

  it('disposes the settings namespace and the committed-event watch with the entry fiber', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    await loaded.settings.replace(WORKER_ESCALATION_SETTINGS_NAMESPACE, { enabled: true })
    const entry = packageEntry(loaded)
    expect(entry.fiber).toBeDefined()

    await entry.fiber?.dispose()

    expect(loaded.settings.get(WORKER_ESCALATION_SETTINGS_NAMESPACE)).toBeUndefined()
    expect(loaded.settings.describe().map(descriptor => descriptor.ns)).not.toContain(WORKER_ESCALATION_SETTINGS_NAMESPACE)
    // The watch went with it: the same firing script now writes nothing.
    const after = worker(loaded, 'worker-composition-disposed')
    drive(after)
    await settle()
    expect(decisions(after)).toBe(0)
  })
})
