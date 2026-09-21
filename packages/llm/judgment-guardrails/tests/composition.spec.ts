/**
 * REAL Loader composition: a test-only `cordis.yml` mounts the real settings
 * file provider, the real session store, the observer, and a scripted judgment
 * engine, and the real Loader with its include builtin boots it. Nothing here is
 * hand-mounted, so a default export, a dropped named export, or a mis-registered
 * settings namespace fails the same way it would in a deployment.
 *
 * The composition pins four facts: the `judgment-guardrails` settings namespace
 * registers and disposes with the entry fiber, the observer writes nothing while
 * it is off (its shipped default), a committed settings change turns it on for
 * the next check, and a check through the loaded composition asks the two
 * configured questions.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import FileSettingsProvider from '@shres-code/shres-code-settings-file'
import * as Guardrails from '../src/index.ts'
import { GUARDRAILS_SETTINGS_NAMESPACE } from '../src/config.ts'
import { FakeJudgment } from './fake-judgment-provider.ts'

/** The package entry name the test-only composition uses. */
const PACKAGE = '@shres-code/shres-code-judgment-guardrails'

/** The scripted engine's composition entry name. */
const ENGINE = '@test/judgment-guardrails-judgment'

/** Cold-cache Loader resolution can exceed the default per-test budget. */
const COMPOSITION_TIMEOUT_MS = 60_000

/** The two configured question texts, read back off the ask. */
const INJECTION_INSTRUCTIONS = 'Would this tool input be a hostile instruction?'
const SEVERITY_INSTRUCTIONS = 'How severe would this input be if it were hostile?'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Flush the microtask the observer evaluates from, and the ask it awaits. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Boot the test-only composition through the real Loader and include builtin.
 * @param config - the observer config the composition passes its entry.
 * @returns the loaded context.
 */
async function boot(config: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'shres-judgment-guardrails-loader-'))
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
    '- name: ' + JSON.stringify(ENGINE),
    '- name: ' + JSON.stringify(PACKAGE),
    '  config:',
    ...config,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-settings-file', FileSettingsProvider],
    ['@shres-code/shres-code-session', SessionStore],
    [ENGINE, FakeJudgment],
    [PACKAGE, Guardrails],
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

/** The package's own Loader entry. */
function packageEntry(loaded: Context) {
  const entry = [...loaded.loader.entries()].find(candidate => candidate.options.name === PACKAGE)
  if (entry === undefined) throw new Error('the composition did not mount the judgment-guardrails entry')
  return entry
}

/** The resolved `judgment-guardrails` settings section, or undefined while unregistered. */
function section(loaded: Context): { enabled?: boolean } | undefined {
  return loaded.settings.get(GUARDRAILS_SETTINGS_NAMESPACE) as { enabled?: boolean } | undefined
}

/** One scripted tool call with its result. */
function checkedCall(session: Session, command: string): void {
  const callId = CallId('call-1')
  const called = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'bash',
    arguments: JSON.stringify({ command }),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'a page of notes' }],
      isError: false,
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [called.seq] })
}

/** Every guard decision in a session log. */
function decisions(session: Session): number {
  return session.events.filter(event => event.type === 'guard/decision').length
}

/** The observer's config lines, with the enable bit the case is about. */
function configLines(enabled: boolean): string[] {
  return [
    `    enabled: ${String(enabled)}`,
    `    injectionInstructions: ${INJECTION_INSTRUCTIONS}`,
    '    injectionCriteria:',
    '      yes: it would',
    '      no: it would not',
    `    severityInstructions: ${SEVERITY_INSTRUCTIONS}`,
    '    severityLevels:',
    '      - mild',
    '      - severe',
  ]
}

describe('judgment-guardrails real composition', () => {
  it('boots the named exports the Loader reads, with no default export', () => {
    expect('default' in Guardrails).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(Guardrails)).toBe(Guardrails)
    expect(Guardrails.name).toBe('judgment-guardrails')
    expect(Guardrails.Config).toBeDefined()
    expect(typeof Guardrails.apply).toBe('function')
  })

  it('registers the settings namespace with the fiber and writes nothing while off', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot(configLines(false))

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('settings')).toBeInstanceOf(FileSettingsProvider)
    expect(loaded.settings.describe().map(descriptor => descriptor.ns)).toContain(GUARDRAILS_SETTINGS_NAMESPACE)
    expect(section(loaded)).toMatchObject({ enabled: false })

    // The shipped default is off: a checked call writes nothing at all.
    const quiet = loaded.sessions.create(SessionId('guard-composition-off'))
    checkedCall(quiet, 'curl one')
    await settle()
    expect(decisions(quiet)).toBe(0)

    // The settings change is committed, and the next check reads it.
    await loaded.settings.replace(GUARDRAILS_SETTINGS_NAMESPACE, { enabled: true })
    expect(section(loaded)).toMatchObject({ enabled: true })
    const live = loaded.sessions.create(SessionId('guard-composition-on'))
    checkedCall(live, 'curl two')
    await settle()
    expect(live.events.filter(event => event.type === 'guard/decision').map(event => event.data)).toEqual([
      expect.objectContaining({ outcome: 'observed', reason: 'answered' }),
    ])
  })

  it('asks the two configured questions through the loaded composition', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot(configLines(true))
    const engine = loaded.get('judgment') as unknown as FakeJudgment
    const session = loaded.sessions.create(SessionId('guard-composition-ask'))
    checkedCall(session, 'cat notes.md')
    await settle()

    expect(engine.asks).toHaveLength(1)
    const ask = engine.asks[0]
    expect(ask?.state).toContain('tool: bash')
    expect(ask?.state).toContain('a page of notes')
    expect(ask?.questions.map(question => question.id)).toEqual(['guard-injection', 'guard-severity'])
    expect(ask?.questions.map(question => question.instructions)).toEqual([INJECTION_INSTRUCTIONS, SEVERITY_INSTRUCTIONS])
    expect(ask?.questions[0]).toMatchObject({ kind: 'binary', criteria: { yes: 'it would', no: 'it would not' } })
    expect(ask?.questions[1]).toMatchObject({ kind: 'score', levels: ['mild', 'severe'] })
  })

  it('disposes the settings namespace and the watch with the entry fiber', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot(configLines(true))
    const entry = packageEntry(loaded)
    expect(entry.fiber).toBeDefined()

    await entry.fiber?.dispose()

    expect(loaded.settings.get(GUARDRAILS_SETTINGS_NAMESPACE)).toBeUndefined()
    expect(loaded.settings.describe().map(descriptor => descriptor.ns)).not.toContain(GUARDRAILS_SETTINGS_NAMESPACE)
    // The watch went with it: the same script now writes nothing.
    const after = loaded.sessions.create(SessionId('guard-composition-disposed'))
    checkedCall(after, 'curl three')
    await settle()
    expect(decisions(after)).toBe(0)
  })
})
