/**
 * Persist a first-run choice: `agent-default-model`, optional credential, and
 * an optional hand-declared pi-ai route.
 *
 * @module @roos-code/roos-code-first-run-setup/apply-choice
 */

import type { Context } from '@roos-code/cordis'
import { credentialRef } from '@roos-code/roos-code-credentials'
import { settingsNamespace } from '@roos-code/roos-code-settings'
import type { FirstRunChoice } from './types.ts'
import { TEMPLATE_ROUTES } from './options.ts'

const PI_AI = settingsNamespace('llm-pi-ai')

/**
 * Derive `<ROUTE>_API_KEY` the same way the Models page does.
 * @param provider - provider route id.
 * @returns the conventional credential reference.
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Write the default model, and any key or custom route the choice carries.
 * @param ctx - context carrying agentDefaultModel plus optional settings/credentials.
 * @param choice - the picker outcome.
 */
export async function applyChoice(ctx: Context, choice: FirstRunChoice): Promise<void> {
  switch (choice.kind) {
    case 'ollama-local':
      await saveDefault(ctx, 'ollama-local', choice.model)
      return
    case 'template': {
      const template = TEMPLATE_ROUTES.find(route => route.provider === choice.provider)
      if (template === undefined) {
        throw new Error(`first-run-setup: unknown template provider "${choice.provider}"`)
      }
      if (choice.apiKey !== undefined && choice.apiKey.length > 0) {
        /* v8 ignore next -- every shipped template names apiKeyEnv */
        await storeKey(ctx, template.apiKeyEnv ?? deriveKeyRef(choice.provider), choice.apiKey)
      }
      const model = choice.model ?? await firstListedModel(ctx, choice.provider) ?? template.defaultModel
      await saveDefault(ctx, choice.provider, model)
      return
    }
    case 'custom': {
      const api = choice.api ?? 'openai-completions'
      const apiKeyEnv = choice.apiKey !== undefined && choice.apiKey.length > 0
        ? deriveKeyRef(choice.provider)
        : undefined
      const settings = ctx.get('settings')
      if (settings === undefined) {
        throw new Error('first-run-setup: a settings provider is required to store a custom route')
      }
      await settings.update(PI_AI, {
        providers: {
          [choice.provider]: {
            ...choice.displayName === undefined ? {} : { displayName: choice.displayName },
            ...apiKeyEnv === undefined ? {} : { apiKeyEnv },
            api,
            baseURL: choice.baseURL,
            models: [{ id: choice.model }],
          },
        },
      })
      if (choice.apiKey !== undefined && choice.apiKey.length > 0 && apiKeyEnv !== undefined) {
        await storeKey(ctx, apiKeyEnv, choice.apiKey)
      }
      await saveDefault(ctx, choice.provider, choice.model)
      return
    }
    /* v8 ignore next 4 -- closed-union exhaustiveness only */
    default: {
      const _never: never = choice
      throw new Error(`first-run-setup: unexpected choice ${JSON.stringify(_never)}`)
    }
  }
}

/** Persist the default Agent model selection. */
async function saveDefault(ctx: Context, provider: string, model: string): Promise<void> {
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel === undefined) {
    throw new Error('first-run-setup: agentDefaultModel is required to save a selection')
  }
  await defaultModel.saveSelection({ provider, model })
}

/** Store one credential, or fail if the seam is absent. */
async function storeKey(ctx: Context, ref: string, value: string): Promise<void> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error(`first-run-setup: a credentials provider is required to store ${ref}`)
  }
  await credentials.set(credentialRef(ref), value)
}

/** First advertised model for a live adapter route, when any. */
async function firstListedModel(ctx: Context, provider: string): Promise<string | undefined> {
  const llm = ctx.get('llm')
  if (llm === undefined) return undefined
  const models = await llm.listModels(provider)
  return models[0]?.id
}
