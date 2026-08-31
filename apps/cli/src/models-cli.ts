/**
 * `shres models` / `shres providers` — product CLI over the same settings,
 * credentials, and llm services the Web Settings → Models page uses.
 *
 * @module @shres-code/shres-code/models-cli
 */

import { Context } from '@shres-code/cordis'
import type {} from '@shres-code/shres-code-credentials'
import type {} from '@shres-code/shres-code-llm'
import type {} from '@shres-code/shres-code-settings'
import AgentDefaultModelConfig from '@shres-code/shres-code-agent-default-model'
import type { ModelPurpose } from '@shres-code/shres-code-agent-default-model'
import { MODEL_PURPOSES } from '@shres-code/shres-code-agent-default-model'
import { validateSelection } from '@shres-code/shres-code-agent-default-model'
import { credentialRef } from '@shres-code/shres-code-credentials'
import CredentialsLocal from '@shres-code/shres-code-credentials-local'
import { deriveKeyRef, readLine, readSecret } from '@shres-code/shres-code-first-run-setup'
import type { CliIo } from '@shres-code/shres-code-first-run-setup'
import LlmRuntime from '@shres-code/shres-code-llm'
import { ReasoningEffortId } from '@shres-code/shres-code-llm'
import * as LlmDeepseek from '@shres-code/shres-code-llm-deepseek'
import * as LlmCliBridge from '@shres-code/shres-code-llm-cli-bridge'
import * as LlmGrokSession from '@shres-code/shres-code-llm-grok-session'
import * as LlmXaiApiKey from '@shres-code/shres-code-llm-xai-apikey'
import * as LlmPiAi from '@shres-code/shres-code-llm-pi-ai'
import { settingsNamespace } from '@shres-code/shres-code-settings'
import SettingsFile from '@shres-code/shres-code-settings-file'

const PI_AI = settingsNamespace('llm-pi-ai')

/** Shipped template ids `shres providers add --template` accepts. */
export const PROVIDER_TEMPLATES = [
  'ollama-local',
  'ollama-cloud',
  'openai',
  'anthropic',
  'xai',
  'moonshotai',
  'openrouter',
  'groq',
  'zai',
  'custom',
] as const

/** One shipped template id. */
export type ProviderTemplate = (typeof PROVIDER_TEMPLATES)[number]

/** Parsed `shres models` / `shres providers` invocation. */
export type ModelsCliCommand =
  | { kind: 'models-list' }
  | { kind: 'models-set'; provider: string; model: string; effort?: string; purpose?: ModelPurpose }
  | { kind: 'models-discover'; provider: string; baseURL?: string; add: boolean }
  | { kind: 'providers-list' }
  | {
    kind: 'providers-add'
    template?: ProviderTemplate
    baseURL?: string
    apiKeyEnv?: string
    provider?: string
    model?: string
  }
  | { kind: 'providers-remove'; provider: string }

/** Default pi-ai routes matching the base bundle. */
const SHIPPED_PI_AI_PROVIDERS: Record<string, {
  displayName?: string
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  models?: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[]
}> = {
  'ollama-local': {
    displayName: 'Ollama (local)',
    api: 'openai-completions',
    baseURL: 'http://localhost:11434/v1',
    headers: { Authorization: 'Bearer ollama' },
    models: [{ id: 'llama3.2', name: 'Llama 3.2' }],
  },
  'ollama-cloud': {
    displayName: 'Ollama Cloud',
    api: 'openai-completions',
    baseURL: 'https://ollama.com/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    models: [
      { id: 'deepseek-v4-flash:cloud', name: 'DeepSeek V4 Flash (cloud)', contextWindow: 1048576, maxTokens: 32768 },
      { id: 'deepseek-v4-pro:cloud', name: 'DeepSeek V4 Pro (cloud)', contextWindow: 1048576, maxTokens: 32768 },
    ],
  },
  openai: { apiKeyEnv: 'OPENAI_API_KEY' },
  anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
  xai: { apiKeyEnv: 'XAI_API_KEY' },
  moonshotai: { apiKeyEnv: 'MOONSHOT_API_KEY' },
  openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' },
  groq: { apiKeyEnv: 'GROQ_API_KEY' },
  zai: { apiKeyEnv: 'ZAI_API_KEY' },
}

/** Shipped `llm-pi-ai` route ids, used to refuse a silent remove of a composition route. */
export const SHIPPED_PI_AI_PROVIDER_IDS: readonly string[] = Object.keys(SHIPPED_PI_AI_PROVIDERS)

interface TemplateDefaults {
  displayName: string
  apiKeyEnv?: string
  baseURL?: string
  api?: string
  models?: { id: string }[]
  headers?: Record<string, string>
}

const TEMPLATE_DEFAULTS: Record<Exclude<ProviderTemplate, 'custom'>, TemplateDefaults> = {
  'ollama-local': {
    displayName: 'Ollama (local)',
    api: 'openai-completions',
    baseURL: 'http://localhost:11434/v1',
    headers: { Authorization: 'Bearer ollama' },
    models: [{ id: 'llama3.2' }],
  },
  'ollama-cloud': {
    displayName: 'Ollama Cloud',
    api: 'openai-completions',
    baseURL: 'https://ollama.com/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    models: [{ id: 'deepseek-v4-flash:cloud' }, { id: 'deepseek-v4-pro:cloud' }],
  },
  openai: { displayName: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY' },
  anthropic: { displayName: 'Anthropic (Claude)', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  xai: { displayName: 'xAI (Grok)', apiKeyEnv: 'XAI_API_KEY' },
  moonshotai: { displayName: 'Moonshot (Kimi)', apiKeyEnv: 'MOONSHOT_API_KEY' },
  openrouter: { displayName: 'OpenRouter', apiKeyEnv: 'OPENROUTER_API_KEY' },
  groq: { displayName: 'Groq', apiKeyEnv: 'GROQ_API_KEY' },
  zai: { displayName: 'Z.AI (GLM)', apiKeyEnv: 'ZAI_API_KEY' },
}

/** Process streams; tests substitute captures. */
export interface ModelsCliIo extends CliIo {
  /** Exit the process after a failing command. */
  exit(code: number): void
}

/** Production stdin/stdout pair. */
export function processIo(): ModelsCliIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY:  process.stdin.isTTY &&  process.stderr.isTTY,
    exit: (code) => { process.exitCode = code },
  }
}

/**
 * Boot the settings + credentials + llm composition the Models page uses.
 * @param shresHome - harness home; omitted uses `$SHRES_HOME` / `~/.shres`.
 * @returns a live context. The caller must dispose it.
 */
export async function bootModelsCli(shresHome?: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SettingsFile, { ...shresHome === undefined ? {} : { shresHome }, watch: false })
  await ctx.plugin(CredentialsLocal, { ...shresHome === undefined ? {} : { shresHome }, watch: false })
  await ctx.plugin(AgentDefaultModelConfig, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  await ctx.plugin(LlmDeepseek)
  await ctx.plugin(LlmPiAi, { providers: SHIPPED_PI_AI_PROVIDERS })
  await ctx.plugin(LlmCliBridge)
  await ctx.plugin(LlmGrokSession)
  await ctx.plugin(LlmXaiApiKey)
  return ctx
}

/**
 * Run one models/providers command and print the transcript.
 * @param command - parsed invocation.
 * @param io - streams and exit.
 * @param shresHome - optional harness home for tests.
 * @returns the process exit code.
 */
export async function runModelsCli(
  command: ModelsCliCommand,
  io: ModelsCliIo = processIo(),
  shresHome?: string,
): Promise<number> {
  const ctx = await bootModelsCli(shresHome)
  try {
    const text = await dispatch(ctx, command, io)
    if (text.length > 0) io.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
    return 0
  } catch (error: unknown) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
    return 1
  } finally {
    await ctx.fiber.dispose()
  }
}

async function dispatch(ctx: Context, command: ModelsCliCommand, io: ModelsCliIo): Promise<string> {
  switch (command.kind) {
    case 'models-list':
    case 'providers-list':
      return formatProviderList(ctx)
    case 'models-set':
      return setModel(ctx, command)
    case 'models-discover':
      return discoverModels(ctx, command)
    case 'providers-add':
      return addProvider(ctx, command, io)
    case 'providers-remove':
      return removeProvider(ctx, command.provider)
    /* v8 ignore next 4 -- closed-union exhaustiveness only */
    default: {
      const _never: never = command
      throw new Error(`shres: unexpected models command ${JSON.stringify(_never)}`)
    }
  }
}

interface ProviderRow {
  provider: string
  displayName: string
  active: boolean
  usable: boolean
  delegated: boolean
  models: string[]
}

function mergeProviderRows(ctx: Context): ProviderRow[] {
  const directory = ctx.llm.listConfigurableProviders()
  const live = new Set(ctx.llm.listProviders().map(provider => provider.id))
  const seen = new Set<string>()
  const rows: ProviderRow[] = []
  for (const entry of directory) {
    seen.add(entry.provider)
    rows.push({
      provider: entry.provider,
      displayName: entry.displayName,
      active: live.has(entry.provider),
      usable: true,
      delegated: entry.kind === 'delegated',
      models: [],
    })
  }
  for (const provider of ctx.llm.listProviders()) {
    if (seen.has(provider.id)) continue
    rows.push({
      provider: provider.id,
      displayName: provider.name,
      active: true,
      usable: true,
      delegated: provider.kind === 'delegated',
      models: [],
    })
  }
  return rows
}

async function hydrateRows(ctx: Context, rows: ProviderRow[]): Promise<ProviderRow[]> {
  return Promise.all(rows.map(async (row) => {
    const models = row.active ? (await ctx.llm.listModels(row.provider)).map(model => model.id) : []
    const usable = await providerUsable(ctx, row.provider)
    return { ...row, models, usable }
  }))
}

/**
 * Format providers, models, the default, and missing-key flags.
 * @param ctx - booted models composition.
 * @returns printable transcript.
 */
export async function formatProviderList(ctx: Context): Promise<string> {
  const selected = ctx.agentDefaultModel.currentSelection()
  const lines = [`Default: ${selected.provider} ${selected.model}${effortSuffix(selected.reasoningEffort)}`]
  const purposes = ctx.agentDefaultModel.purposeSelections()
  for (const purpose of MODEL_PURPOSES) {
    const override = purposes[purpose]
    if (override !== undefined) {
      lines.push(`Purpose ${purpose}: ${override.provider} ${override.model}${effortSuffix(override.reasoningEffort)}`)
    }
  }
  lines.push('', 'Providers:')
  const rows = await hydrateRows(ctx, mergeProviderRows(ctx))
  for (const row of rows) {
    const flags = [
      ...row.active ? ['active'] : ['dormant'],
      ...row.provider === selected.provider ? ['default'] : [],
      ...row.delegated ? ['delegated'] : [],
      ...row.usable ? [] : ['unusable until keyed'],
    ]
    lines.push(`  ${row.provider}  ${row.displayName}  [${flags.join(', ')}]`)
    if (row.models.length === 0) {
      lines.push('    (no advertised models)')
      continue
    }
    for (const model of row.models) {
      const mark = row.provider === selected.provider && model === selected.model ? '  (default)' : ''
      lines.push(`    ${model}${mark}`)
    }
  }
  return lines.join('\n')
}

function effortSuffix(effort: string | undefined): string {
  return effort === undefined ? '' : ` effort=${effort}`
}

async function providerUsable(ctx: Context, provider: string): Promise<boolean> {
  const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === provider)
  const live = ctx.llm.listProviders().find(candidate => candidate.id === provider)
  if (entry?.kind === 'delegated' || live?.kind === 'delegated') return false
  const apiKeyEnv = apiKeyEnvOf(ctx, entry?.settingsNs, entry?.settingsPath)
  if (apiKeyEnv === undefined) return live !== undefined
  const info = await ctx.credentials.describe(credentialRef(apiKeyEnv))
  return info.configured
}

function apiKeyEnvOf(
  ctx: Context,
  settingsNs: string | undefined,
  settingsPath: readonly string[] | undefined,
): string | undefined {
  if (settingsNs === undefined) return undefined
  const descriptor = ctx.settings.describe().find(entry => entry.ns === settingsNs)
  if (descriptor === undefined) return undefined
  let cursor: unknown = descriptor.value
  for (const segment of settingsPath ?? []) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  if (typeof cursor !== 'object' || cursor === null) return undefined
  const ref = (cursor as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

async function setModel(ctx: Context, command: Extract<ModelsCliCommand, { kind: 'models-set' }>): Promise<string> {
  const known = new Set([
    ...ctx.llm.listConfigurableProviders().map(entry => entry.provider),
    ...ctx.llm.listProviders().map(provider => provider.id),
  ])
  if (!known.has(command.provider)) {
    throw new Error(`shres models set: unknown provider "${command.provider}"`)
  }
  const requested = {
    provider: command.provider,
    model: command.model,
    ...command.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(command.effort) },
  }
  const selected = await validateSelection(ctx.agentDefaultModel, requested)
  await ctx.agentDefaultModel.saveSelection(
    selected,
    command.purpose === undefined ? {} : { purpose: command.purpose },
  )
  const label = command.purpose === undefined ? 'Default' : `Purpose ${command.purpose}`
  return `${label}: ${selected.provider} ${selected.model}${effortSuffix(selected.reasoningEffort)}`
}

async function discoverModels(
  ctx: Context,
  command: Extract<ModelsCliCommand, { kind: 'models-discover' }>,
): Promise<string> {
  const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === command.provider)
  const settingsNs = entry?.settingsNs ?? 'llm-pi-ai'
  let existing: Record<string, unknown>[] | undefined
  if (command.add) {
    if (entry === undefined) {
      throw new Error(`shres models discover: cannot --add models for unknown provider "${command.provider}"`)
    }
    existing = storedModelRows(ctx, entry.settingsNs, entry.settingsPath, command.provider)
  }
  const models = await ctx.llm.discoverModels(settingsNs, {
    provider: command.provider,
    ...command.baseURL === undefined ? {} : { baseURL: command.baseURL },
  })
  if (existing !== undefined && models.length > 0 && entry !== undefined) {
    const seen = new Set(existing.map(row => row.id))
    const merged: Record<string, unknown>[] = [...existing]
    for (const model of models) {
      if (seen.has(model.id)) continue
      merged.push({
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      })
    }
    await ctx.settings.mutate(settingsNamespace(entry.settingsNs), [{
      op: 'set',
      path: [...entry.settingsPath, 'models'],
      value: merged,
    }])
  }
  if (models.length === 0) return `${command.provider}: (no models advertised)`
  return [`${command.provider}:`, ...models.map(model => `  ${model.id}`)].join('\n')
}

/**
 * Read the resolved stored model objects for one route.
 * @param ctx - booted models composition.
 * @param settingsNs - namespace that owns the route.
 * @param settingsPath - path from the section root to the profile.
 * @param provider - route id, for error text.
 * @returns the existing model objects, unmodified.
 */
function storedModelRows(
  ctx: Context,
  settingsNs: string,
  settingsPath: readonly string[],
  provider: string,
): Record<string, unknown>[] {
  const descriptor = ctx.settings.describe().find(entry => entry.ns === settingsNs)
  if (descriptor === undefined) {
    throw new Error(`shres models discover: cannot --add models; settings namespace "${settingsNs}" is not registered`)
  }
  const userModels = declaredModelList(descriptor.user, settingsPath)
  const baseModels = declaredModelList(descriptor.base, settingsPath)
  const models = userModels ?? (baseModels !== undefined && baseModels.length > 0 ? baseModels : undefined)
  if (models === undefined) {
    throw new Error(`shres models discover: cannot --add models; "${provider}" has no stored model list`)
  }
  return models.map((row, index) => {
    if (typeof row !== 'object' || row === null || typeof (row as { id?: unknown }).id !== 'string') {
      throw new Error(`shres models discover: cannot --add models; "${provider}" model list entry ${String(index)} is not a model object`)
    }
    return { ...(row as Record<string, unknown>) }
  })
}

/** Read a declared `models` array from a settings layer, or undefined when absent. */
function declaredModelList(root: unknown, settingsPath: readonly string[]): unknown[] | undefined {
  if (typeof root !== 'object' || root === null) return undefined
  let cursor: unknown = root
  for (const segment of settingsPath) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  if (typeof cursor !== 'object' || cursor === null) return undefined
  const models = (cursor as { models?: unknown }).models
  return Array.isArray(models) ? models : undefined
}

async function addProvider(
  ctx: Context,
  command: Extract<ModelsCliCommand, { kind: 'providers-add' }>,
  io: ModelsCliIo,
): Promise<string> {
  const template = command.template ?? await promptTemplate(io)
  if (template === 'custom') return addCustom(ctx, command, io)
  const defaults = TEMPLATE_DEFAULTS[template]
  const baseURL = command.baseURL ?? defaults.baseURL
  const apiKeyEnv = command.apiKeyEnv ?? defaults.apiKeyEnv
  const profile: Record<string, unknown> = {
    displayName: defaults.displayName,
    ...defaults.api === undefined ? {} : { api: defaults.api },
    ...baseURL === undefined ? {} : { baseURL },
    ...apiKeyEnv === undefined ? {} : { apiKeyEnv },
    ...defaults.headers === undefined ? {} : { headers: defaults.headers },
    ...defaults.models === undefined ? {} : { models: defaults.models },
  }
  await ctx.settings.mutate(PI_AI, [{ op: 'set', path: ['providers', template], value: profile }])
  if (apiKeyEnv !== undefined) await maybeStoreKey(ctx, io, apiKeyEnv, template)
  return `Provider ${template} saved.`
}

async function addCustom(
  ctx: Context,
  command: Extract<ModelsCliCommand, { kind: 'providers-add' }>,
  io: ModelsCliIo,
): Promise<string> {
  const provider = command.provider ?? await prompt(io, 'Provider ID (lowercase, e.g. acme-gateway):')
  if (!/^[a-z][a-z0-9-]*$/.test(provider)) {
    throw new Error('shres providers add: Provider ID must start with a lowercase letter and use lowercase letters, digits, and dashes')
  }
  const baseURL = command.baseURL ?? await prompt(io, 'Base URL (OpenAI-compatible, including /v1):')
  if (baseURL.length === 0) throw new Error('shres providers add: a custom provider needs a base URL')
  const model = command.model ?? await prompt(io, 'Model ID:')
  if (model.length === 0) throw new Error('shres providers add: a custom provider needs a model id')
  const apiKeyEnv = command.apiKeyEnv ?? deriveKeyRef(provider)
  const profile = {
    api: 'openai-completions',
    baseURL,
    apiKeyEnv,
    models: [{ id: model }],
  }
  await ctx.settings.mutate(PI_AI, [{ op: 'set', path: ['providers', provider], value: profile }])
  await maybeStoreKey(ctx, io, apiKeyEnv, provider)
  return `Provider ${provider} saved.`
}

async function removeProvider(ctx: Context, provider: string): Promise<string> {
  const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === provider)
  if (entry === undefined) throw new Error(`shres providers remove: unknown provider "${provider}"`)
  if (entry.settingsNs !== 'llm-pi-ai') {
    throw new Error(`shres providers remove: "${provider}" is not a user-owned pi-ai route`)
  }
  const shipped = SHIPPED_PI_AI_PROVIDER_IDS.includes(provider)
  if (shipped && !userLayerHasProvider(ctx, provider)) {
    throw new Error(
      `shres providers remove: "${provider}" is a shipped route; there is no user override to clear`,
    )
  }
  await ctx.settings.mutate(PI_AI, [{ op: 'unset', path: ['providers', provider] }])
  if (shipped) {
    return `Cleared the user override for ${provider}; the shipped route remains.`
  }
  return `Provider ${provider} removed.`
}

/** Whether the user layer of `llm-pi-ai` names this route. */
function userLayerHasProvider(ctx: Context, provider: string): boolean {
  const descriptor = ctx.settings.describe().find(entry => entry.ns === PI_AI)
  const user = descriptor?.user
  if (typeof user !== 'object' || user === null) return false
  const providers = (user as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null) return false
  return Object.hasOwn(providers, provider)
}

async function maybeStoreKey(ctx: Context, io: ModelsCliIo, ref: string, provider: string): Promise<void> {
  write(io.stdout, `Enter API key for ${provider} (${ref}), or leave blank to skip:\n`)
  const value = await readSecret(io)
  if (value.length === 0) return
  await ctx.credentials.set(credentialRef(ref), value)
}

async function promptTemplate(io: ModelsCliIo): Promise<ProviderTemplate> {
  write(io.stdout, `Template (${PROVIDER_TEMPLATES.join(', ')}):\n`)
  const value = await prompt(io, '')
  if (!(PROVIDER_TEMPLATES as readonly string[]).includes(value)) {
    throw new Error(`shres providers add: unknown template "${value}"`)
  }
  return value as ProviderTemplate
}

async function prompt(io: ModelsCliIo, label: string): Promise<string> {
  if (label.length > 0) write(io.stdout, `${label}\n`)
  return readLine(io.stdin)
}

function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text)
}
