/**
 * Template routes offered by the first-run picker, plus the user-layer
 * and credential checks that decide whether setup is required.
 *
 * @module @roos-code/roos-code-first-run-setup/options
 */

import { credentialRef } from '@roos-code/roos-code-credentials'
import type { Context } from '@roos-code/cordis'
import { AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE } from '@roos-code/roos-code-agent-default-model'
import type { LocalOllamaStatus, PickerOption, TemplateRoute } from './types.ts'

/** Shipped template routes. A named `apiKeyEnv` is unusable until stored. */
export const TEMPLATE_ROUTES: readonly TemplateRoute[] = [
  { provider: 'ollama-cloud', label: 'Ollama Cloud', apiKeyEnv: 'OLLAMA_API_KEY', defaultModel: 'deepseek-v4-flash:cloud' },
  { provider: 'openai', label: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4.1' },
  { provider: 'anthropic', label: 'Anthropic (Claude)', apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-5' },
  { provider: 'xai', label: 'xAI (Grok)', apiKeyEnv: 'XAI_API_KEY', defaultModel: 'grok-3' },
  { provider: 'moonshotai', label: 'Moonshot (Kimi)', apiKeyEnv: 'MOONSHOT_API_KEY', defaultModel: 'kimi-k2.5' },
  { provider: 'openrouter', label: 'OpenRouter', apiKeyEnv: 'OPENROUTER_API_KEY', defaultModel: 'openai/gpt-4o' },
  { provider: 'groq', label: 'Groq', apiKeyEnv: 'GROQ_API_KEY', defaultModel: 'llama-3.3-70b-versatile' },
  { provider: 'deepseek-official', label: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-v4-flash' },
]

/**
 * Whether the user layer of `agent-default-model` names a provider and model.
 * @param ctx - context that may carry a settings provider.
 * @returns true only when the stored user section has both fields.
 */
export function hasUserSelection(ctx: Context): boolean {
  const settings = ctx.get('settings')
  if (settings === undefined) return false
  const descriptor = settings.describe().find(entry => entry.ns === AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE)
  const user = descriptor?.user
  if (typeof user !== 'object' || user === null) return false
  const provider = (user as { provider?: unknown }).provider
  const model = (user as { model?: unknown }).model
  return typeof provider === 'string' && provider.length > 0
    && typeof model === 'string' && model.length > 0
}

/**
 * Whether one named credential currently resolves.
 * @param ctx - context that may carry a credentials provider.
 * @param ref - environment-variable-style reference.
 * @returns true when the seam or the process environment supplies a value.
 */
export async function credentialConfigured(ctx: Context, ref: string): Promise<boolean> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const info = await credentials.describe(credentialRef(ref))
    return info.configured
  }
  const value = process.env[ref]
  return typeof value === 'string' && value.length > 0
}

/**
 * Whether the current composition/settings default can serve a request.
 * Local Ollama counts only while the probe succeeds; a named key counts only
 * while it is stored.
 * @param ctx - context carrying the default-model service and optional credentials.
 * @param ollama - latest local-Ollama probe.
 * @returns whether `currentSelection()` is usable as-is.
 */
export async function isDefaultUsable(ctx: Context, ollama: LocalOllamaStatus): Promise<boolean> {
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel === undefined) return false
  const selection = defaultModel.currentSelection()
  if (selection.provider === 'ollama-local') return ollama.reachable
  const listed = ctx.get('llm')?.listConfigurableProviders() ?? []
  const entry = listed.find(candidate => candidate.provider === selection.provider)
  const apiKeyEnv = apiKeyEnvOf(ctx, entry?.settingsNs, entry?.settingsPath)
    ?? TEMPLATE_ROUTES.find(route => route.provider === selection.provider)?.apiKeyEnv
  if (apiKeyEnv === undefined) {
    return ctx.get('llm')?.listProviders().some(provider => provider.id === selection.provider)
      /* v8 ignore next -- listProviders is always present on a mounted llm service */
      ?? false
  }
  return credentialConfigured(ctx, apiKeyEnv)
}

/** The credential reference a resolved profile names, when one does. */
function apiKeyEnvOf(
  ctx: Context,
  settingsNs: string | undefined,
  settingsPath: readonly string[] | undefined,
): string | undefined {
  if (settingsNs === undefined) return undefined
  const descriptor = ctx.get('settings')?.describe().find(entry => entry.ns === settingsNs)
  /* v8 ignore next -- a directory entry whose namespace is not registered has no profile to read */
  if (descriptor === undefined) return undefined
  let cursor: unknown = descriptor.value
  /* v8 ignore next -- directory entries always carry a settings path, possibly empty */
  const path = settingsPath ?? []
  for (const segment of path) {
    /* v8 ignore next -- a broken settings path is treated as no named credential */
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  /* v8 ignore next -- a profile that is not an object names no credential */
  if (typeof cursor !== 'object' || cursor === null) return undefined
  const ref = (cursor as { apiKeyEnv?: unknown }).apiKeyEnv
  /* v8 ignore next -- an empty apiKeyEnv string is treated as unnamed */
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/**
 * Build the CLI menu: detected local models, then template routes, then custom.
 * @param ollama - latest local-Ollama probe.
 * @returns picker options in print order.
 */
export function listPickerOptions(ollama: LocalOllamaStatus): readonly PickerOption[] {
  const local: PickerOption[] = ollama.reachable
    ? ollama.models.map(model => ({
      kind: 'ollama-local',
      provider: 'ollama-local',
      model: model.id,
      name: model.name ?? model.id,
    }))
    : []
  const templates: PickerOption[] = TEMPLATE_ROUTES.map(route => ({
    kind: 'template',
    provider: route.provider,
    label: route.label,
    /* v8 ignore next -- shipped templates all name apiKeyEnv; keep the spread for a future keyless one */
    ...route.apiKeyEnv === undefined ? {} : { apiKeyEnv: route.apiKeyEnv },
    defaultModel: route.defaultModel,
  }))
  return [...local, ...templates, { kind: 'custom' }]
}

/**
 * Loud failure when no TTY can collect a choice.
 * @returns an Error naming how to configure a provider without the picker.
 */
export function noProviderError(): Error {
  return new Error(
    'first-run-setup: no usable model provider and no agent-default-model selection. '
    + 'Store a provider key (Settings → Models, or the matching *_API_KEY), write '
    + 'agent-default-model in $ROOS_HOME/settings.yaml, or run on a TTY to use the picker. '
    + 'Roos Code does not silently default to a vendor.',
  )
}
