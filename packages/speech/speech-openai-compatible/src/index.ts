/**
 * Register OpenAI-compatible cloud speech providers on `ctx.speech`: STT and
 * TTS over one configurable endpoint (OpenRouter by default). Key resolution
 * goes through the credential seam once per operation; connection facts are
 * re-read on every call so a settings-section edit lands on the next request.
 * @module @shres-code/shres-code-speech-openai-compatible
 */

import type { Context } from '@shres-code/cordis'
import { SPEECH_SETTINGS_NAMESPACE } from '@shres-code/shres-code-speech'
import type { SpeechUserSettings } from '@shres-code/shres-code-speech'
import { credentialRef } from '@shres-code/shres-code-credentials'
import type { Config } from './config.ts'
import { resolveComposition } from './config.ts'
import type { FetchFn, OpenAiCompatibleSpec } from './provider.ts'
import { OpenAiCompatibleSttProvider, OpenAiCompatibleTtsProvider, resolveSpec } from './provider.ts'
import type {} from '@shres-code/shres-code-speech'
import type {} from '@shres-code/shres-code-credentials'
import type {} from '@shres-code/shres-code-settings'

export {
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_KEY_REF,
  OPENAI_COMPATIBLE_DEFAULT_STT_MODEL,
  OPENAI_COMPATIBLE_DEFAULT_TTS_MODEL,
  OPENAI_COMPATIBLE_DEFAULT_TTS_VOICE,
} from './config.ts'
export { Config } from './config.ts'
export {
  OPENAI_COMPATIBLE_STT_PROVIDER_ID,
  OPENAI_COMPATIBLE_TTS_PROVIDER_ID,
  resolveSpec,
  STT_WIRE_MODES,
  TTS_WIRE_MODES,
} from './provider.ts'
export type {
  FetchFn,
  OpenAiCompatibleComposition,
  OpenAiCompatibleProviderOptions,
  OpenAiCompatibleSpec,
  SttWireMode,
  TtsWireMode,
} from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'speech-openai-compatible'

/** The speech seam, the credential seam for key resolution, and settings for the cloud profile. */
export const inject = ['speech', 'credentials', 'settings']

/**
 * Register the cloud STT and TTS providers with `ctx.speech`.
 * @param ctx - Cordis context carrying the speech, credentials, and settings services.
 * @param config - plugin config.
 * @param fetchFn - transport override; tests inject a fake so CI never reaches the network.
 */
export function registerCloudProviders(ctx: Context, config: Config, fetchFn?: FetchFn): void {
  const composition = resolveComposition(config)
  // The services are captured once, at registration: the closures outlive the
  // contributing fiber (a disposed fiber must not take the providers' fact
  // sources down with it), while the providers themselves unregister with it.
  const settings = ctx.settings
  const credentials = ctx.credentials
  const spec = (): OpenAiCompatibleSpec => {
    const section = settings.get(SPEECH_SETTINGS_NAMESPACE) as Partial<SpeechUserSettings> | undefined
    return resolveSpec(composition, section?.cloud)
  }
  const resolveKey = async (): Promise<string | undefined> => {
    const resolved = await credentials.resolve(credentialRef(spec().apiKeyRef))
    return resolved?.value
  }
  ctx.speech.registerTtsProvider(new OpenAiCompatibleTtsProvider({
    spec,
    resolveKey,
    ...fetchFn === undefined ? {} : { fetchFn },
  }))
  ctx.speech.registerSttProvider(new OpenAiCompatibleSttProvider({
    spec,
    resolveKey,
    ...fetchFn === undefined ? {} : { fetchFn },
  }))
}

/**
 * Register the cloud STT and TTS providers with `ctx.speech`.
 * @param ctx - Cordis context carrying the speech, credentials, and settings services.
 * @param config - plugin config; every field has a default.
 */
export function apply(ctx: Context, config: Config = {}): void {
  registerCloudProviders(ctx, config)
}
