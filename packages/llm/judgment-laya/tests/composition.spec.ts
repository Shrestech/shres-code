import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import AgentRegistry from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import AgentDefaultModel from '@shres-code/shres-code-agent-default-model'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import CommandRuntime from '@shres-code/shres-code-commands'
import type { CommandResult } from '@shres-code/shres-code-commands'
import JudgmentDispatch from '@shres-code/shres-code-judgment-dispatch'
import LlmRuntime, { createUserMessage } from '@shres-code/shres-code-llm'
import * as DeepSeekPlugin from '@shres-code/shres-code-llm-deepseek'
import { startMockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import type { MockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import ModelRoutingController from '@shres-code/shres-code-model-router'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent } from '@shres-code/shres-code-session'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import LocalSubprocessRuntime from '@shres-code/shres-code-subprocess-local'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import { LAYA_COMMAND, LAYA_ENGINE_ID, LayaJudgmentEngine } from '../src/index.ts'
import { cleanup, fakeInstallation, MODEL_ID, REPO, REVISION, tempRuntime, until, writeBehavior } from './helpers.ts'
import type { FakeInstallation } from './helpers.ts'

// laya-mlx is Apple-silicon only; the fake gateway is not, so the host check
// is pinned for this process-level composition.
vi.mock('../src/installation.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/installation.ts')>(),
  currentHost: () => ({ platform: 'darwin', arch: 'arm64' }),
}))

/**
 * REAL composition of `@shres-code/shres-code-judgment-laya`: the shipping
 * agent spine, command registry, subprocess runtime, judgment dispatcher
 * selecting `laya`, model router, and a real
 * DeepSeek adapter pointed at the loopback stub server, booted from a
 * test-only `cordis.yml` through the real Loader. Only the external model
 * provider and the Python gateway are substituted (by the mock LLM server and
 * a fake gateway process); install, launch supervision, the Shield wire, and
 * routing are the shipped code paths.
 */

const PROVIDER = 'deepseek-official'
const MANUAL_MODEL = 'deepseek-v4-pro'
const CANDIDATE_ID = 'flash'
const CANDIDATE_MODEL = 'deepseek-v4-flash'
const COMPOSITION_TIMEOUT_MS = 60_000
const JUDGMENT_SPECIFIER = '@shres-code/shres-code-judgment-laya'
const DISPATCH_SPECIFIER = '@shres-code/shres-code-judgment-dispatch'

let root: string
let fake: FakeInstallation
let context: Context | undefined
let server: MockLlmServer | undefined
let previousApiKey: string | undefined

beforeEach(async () => {
  previousApiKey = process.env['DEEPSEEK_API_KEY']
  process.env['DEEPSEEK_API_KEY'] = 'judgment-laya-composition-key'
  root = await tempRuntime()
  fake = await fakeInstallation(root)
  await writeBehavior(join(root, 'runtime'), {
    manifestSha256: fake.manifestSha256,
    choice: CANDIDATE_ID,
    recordRequestsTo: join(root, 'requests.jsonl'),
  })
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await server?.close()
  server = undefined
  if (previousApiKey === undefined) delete process.env['DEEPSEEK_API_KEY']
  else process.env['DEEPSEEK_API_KEY'] = previousApiKey
  await cleanup(root)
})

/** Boot the test-only cordis.yml through the real Loader. */
async function boot(extraJudgmentRows: readonly string[] = [], startupTimeoutMs = 10_000): Promise<Context> {
  server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: 'LOCAL_OK' })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@shres-code/shres-code-llm'",
    "- name: '@shres-code/shres-code-session'",
    "- name: '@shres-code/shres-code-system-prompt'",
    "- name: '@shres-code/shres-code-tools'",
    "- name: '@shres-code/shres-code-agent'",
    "- name: '@shres-code/shres-code-commands'",
    "- name: '@shres-code/shres-code-session-projection'",
    "- name: '@shres-code/shres-code-subprocess-local'",
    "- name: '@shres-code/shres-code-agent-default-model'",
    '  config:',
    `    provider: ${PROVIDER}`,
    `    model: ${MANUAL_MODEL}`,
    "- name: '@shres-code/shres-code-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@shres-code/shres-code-llm-deepseek'",
    '  config:',
    `    baseURL: '${server.baseURL}/v1'`,
    `- name: '${DISPATCH_SPECIFIER}'`,
    '  config:',
    '    defaultEngine: laya',
    `- name: '${JUDGMENT_SPECIFIER}'`,
    '  config:',
    '    model:',
    `      repo: ${REPO}`,
    `      revision: '${REVISION}'`,
    `      manifestSha256: '${fake.manifestSha256}'`,
    '    checkpointContext: 1024',
    `    runtimeDir: '${join(root, 'runtime')}'`,
    `    gatewayProject: '${fake.gatewayProject}'`,
    `    uvPath: '${fake.uvPath}'`,
    `    startupTimeoutMs: ${startupTimeoutMs}`,
    '    requestTimeoutMs: 5000',
    '    shutdownGraceMs: 500',
    '    installTimeoutMs: 10000',
    ...extraJudgmentRows,
    "- name: '@shres-code/shres-code-model-router'",
    '  config:',
    '    initialMode: on',
    '    candidates:',
    `      - id: ${CANDIDATE_ID}`,
    `        provider: ${PROVIDER}`,
    `        model: ${CANDIDATE_MODEL}`,
    '        description: a small, well-scoped change in familiar code',
    '    routeFrom:',
    `      - { provider: ${PROVIDER}, model: ${MANUAL_MODEL}, objective: dollars }`,
    '    downgradeThreshold: 0.7',
    '    downgradeMargin: 0.5',
    '    routeInstructions: Pick the cheapest route that can finish this turn.',
    '    difficultyInstructions: Rate how much reasoning this turn needs.',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-llm', LlmRuntime],
    ['@shres-code/shres-code-session', SessionStore],
    ['@shres-code/shres-code-system-prompt', SystemPrompt],
    ['@shres-code/shres-code-tools', ToolRuntime],
    ['@shres-code/shres-code-agent', AgentRegistry],
    ['@shres-code/shres-code-commands', CommandRuntime],
    ['@shres-code/shres-code-session-projection', SessionProjectionRegistry],
    ['@shres-code/shres-code-subprocess-local', LocalSubprocessRuntime],
    ['@shres-code/shres-code-agent-default-model', AgentDefaultModel],
    ['@shres-code/shres-code-agent-loop', AgentLoop],
    ['@shres-code/shres-code-llm-deepseek', DeepSeekPlugin],
    [DISPATCH_SPECIFIER, JudgmentDispatch],
    [JUDGMENT_SPECIFIER, LayaJudgmentEngine],
    ['@shres-code/shres-code-model-router', ModelRoutingController],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

/** The mounted Laya provider, as registered in the dispatcher's engine registry. */
function laya(loaded: Context): LayaJudgmentEngine {
  const engine = loaded.judgmentEngines.get(LAYA_ENGINE_ID)?.engine
  if (!(engine instanceof LayaJudgmentEngine)) throw new Error('the laya engine is not registered')
  return engine
}

/** Create one root agent on the manual route. */
function createAgent(loaded: Context, id: string): Agent {
  const agent = loaded.agentLoop.create(SessionId(id), { provider: PROVIDER, model: MANUAL_MODEL })
  loaded.agentDefaultModel.selectionFor(agent)
  return agent
}

/** Run one slash command and return its settled text. */
async function command(loaded: Context, agent: Agent, line: string): Promise<CommandResult> {
  const execution = await loaded.commands.execute(agent, line, new AbortController().signal)
  if (execution === undefined) throw new Error(`${line} did not resolve to a command`)
  return execution.result
}

/** One judgment request the fake gateway recorded. */
interface RecordedJudgment {
  path: string
  body: { model: string; states?: string[]; questions: Array<{ id: string; options?: Array<{ option: string }> }> }
}

/** Events of one type from a session log, in log order. */
function eventsOfType<T extends SessionEvent['type']>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }>[] {
  return events.flatMap(event => event.type === type ? [event as Extract<SessionEvent, { type: T }>] : [])
}

describe('judgment-laya real Loader composition', () => {
  it('installs through /laya, then routes a turn with the local gateway behind ctx.judgment', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('judgment')).toBeInstanceOf(JudgmentDispatch)
    const engine = laya(loaded)
    const agent = createAgent(loaded, 'laya-routing')

    await until(() => engine.status().state === 'not-installed')
    expect(await command(loaded, agent, `/${LAYA_COMMAND}`)).toEqual({
      kind: 'success',
      text: `Laya ${MODEL_ID} (float16, 1024 tokens): not-installed — Laya is not installed; run /laya install`,
    })
    const installed = await command(loaded, agent, `/${LAYA_COMMAND} install`)
    expect(installed).toEqual({ kind: 'success', text: `Installed ${MODEL_ID} into ${engine.config.modelDir}; the gateway is starting.` })
    await until(() => engine.status().state === 'ready')
    expect(await command(loaded, agent, `/${LAYA_COMMAND} status`)).toEqual({
      kind: 'success',
      text: `Laya ${MODEL_ID} (float16, 1024 tokens): ready`,
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Rename total to sum in utils.py.' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const [decision] = eventsOfType(agent.session.events, 'model-routing/decision')
    expect(decision?.data).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      selection: { candidateId: CANDIDATE_ID, provider: PROVIDER, model: CANDIDATE_MODEL },
      engine: 'shield',
      model: MODEL_ID,
    })
    const [header] = eventsOfType(agent.session.events, 'request/header')
    expect(header?.data.header.config).toMatchObject({ provider: PROVIDER, model: CANDIDATE_MODEL })

    const requests = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as RecordedJudgment)
    const routed = requests.find(request => request.path === '/v1/judgments/fitted')
    expect(routed?.body.model).toBe(MODEL_ID)
    expect(routed?.body.states?.[0]).toContain('Rename total to sum in utils.py.')
    expect(routed?.body.questions[0]?.options?.map(option => option.option)).toEqual(['keep-current', CANDIDATE_ID])
    expect((await loaded.judgment.ask({ state: 's', questions: [] })).engineId).toBe('laya')
  })

  it('keeps the manual model when the local gateway is not installed', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    const engine = laya(loaded)
    await until(() => engine.status().state === 'not-installed')
    const agent = createAgent(loaded, 'laya-absent')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Rename total to sum.' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const [decision] = eventsOfType(agent.session.events, 'model-routing/decision')
    expect(decision?.data).toMatchObject({ outcome: 'kept-strong' })
    const [header] = eventsOfType(agent.session.events, 'request/header')
    expect(header?.data.header.config).toMatchObject({ provider: PROVIDER, model: MANUAL_MODEL })
  })

  it('answers /laya restart and rejects an unknown subcommand', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    const agent = createAgent(loaded, 'laya-commands')
    await until(() => laya(loaded).status().state === 'not-installed')

    expect(await command(loaded, agent, `/${LAYA_COMMAND} restart`)).toEqual({ kind: 'success', text: 'Restarting the local Laya gateway.' })
    expect(await command(loaded, agent, `/${LAYA_COMMAND} reboot`)).toEqual({
      kind: 'error',
      text: 'Unknown /laya subcommand "reboot"; use status, install, or restart.',
    })
  })

  it('reports a failed install through /laya and the last exit through status', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    await writeFile(join(root, 'runtime', 'uv-sync-exit'), '3')
    const loaded = await boot()
    const agent = createAgent(loaded, 'laya-install-failure')
    await until(() => laya(loaded).status().state === 'not-installed')

    expect(await command(loaded, agent, `/${LAYA_COMMAND} install`)).toEqual({
      kind: 'error',
      text: 'Laya install failed: uv sync failed (exit 3): uv sync: resolution failed',
    })
  })

  it('names the last gateway exit in /laya status', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    await writeBehavior(join(root, 'runtime'), { manifestSha256: fake.manifestSha256, exitBeforeReady: 4 })
    const loaded = await boot(['    restart:', '      maxRestarts: 1', '      windowMs: 60000', '      backoffMs: 10', '      maxBackoffMs: 10'])
    const agent = createAgent(loaded, 'laya-exit')
    await command(loaded, agent, `/${LAYA_COMMAND} install`)
    await until(() => /exhausted/.test(laya(loaded).status().detail ?? ''))

    const status = await command(loaded, agent, `/${LAYA_COMMAND} status`)
    expect(status.text).toMatch(/: unavailable — .*exhausted; run \/laya restart\nLast exit: code 4\.$/)
  })

  it('names a startup timeout in /laya status', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    await writeBehavior(join(root, 'runtime'), { manifestSha256: fake.manifestSha256, noReadiness: true })
    const loaded = await boot(['    restart:', '      maxRestarts: 1', '      windowMs: 60000', '      backoffMs: 10', '      maxBackoffMs: 10'], 300)
    const agent = createAgent(loaded, 'laya-timeout')
    await command(loaded, agent, `/${LAYA_COMMAND} install`)
    await until(() => /exhausted/.test(laya(loaded).status().detail ?? ''))

    const status = await command(loaded, agent, `/${LAYA_COMMAND} status`)
    expect(status.text).toMatch(/no readiness line within startupTimeoutMs 300/)
    expect(status.text).toMatch(/\nLast exit: SIGTERM after the startup deadline\.$/)
  })

  it('withdraws the laya engine and /laya when the Loader entry fiber disposes', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const loaded = await boot()
    await until(() => laya(loaded).status().state === 'not-installed')
    const entry = [...loaded.loader.entries()].find(candidate => candidate.options.name === JUDGMENT_SPECIFIER)
    expect(entry?.fiber).toBeDefined()

    await entry?.fiber?.dispose()

    expect(loaded.judgmentEngines.get(LAYA_ENGINE_ID)).toBeUndefined()
    await expect(loaded.judgment.ask({ state: 's', questions: [] })).rejects.toMatchObject({ code: 'UNCONFIGURED' })
    const agent = createAgent(loaded, 'laya-withdrawn')
    expect(loaded.commands.find(agent, LAYA_COMMAND)).toBeUndefined()
  })
})
