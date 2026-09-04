/**
 * Composition config and defaults for the OpenAI-compatible cloud speech
 * provider.
 * @module @shres-code/shres-code-speech-openai-compatible/config
 */

import z from '@shres-code/schemastery'
import { credentialRef } from '@shres-code/shres-code-credentials'
import type { OpenAiCompatibleComposition } from './provider.ts'
import { STT_WIRE_MODES, TTS_WIRE_MODES } from './provider.ts'
import type { SttWireMode, TtsWireMode } from './provider.ts'

/** Default endpoint base: OpenRouter's OpenAI-compatible surface. */
export const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/** Default speech-to-text model. */
export const OPENAI_COMPATIBLE_DEFAULT_STT_MODEL = 'microsoft/mai-transcribe-2'

/** Default text-to-speech model. */
export const OPENAI_COMPATIBLE_DEFAULT_TTS_MODEL = 'openai/gpt-4o-audio-preview'

/** Default text-to-speech voice. */
export const OPENAI_COMPATIBLE_DEFAULT_TTS_VOICE = 'alloy'

/** Credential reference holding the endpoint key when none is configured. */
export const OPENAI_COMPATIBLE_DEFAULT_KEY_REF = 'SPEECH_OPENAI_COMPATIBLE_API_KEY'

/** Plugin config (all optional — {@link resolveComposition} fills defaults). */
export interface Config {
  /** Endpoint base such as `https://openrouter.ai/api/v1`. */
  baseURL?: string
  /** Credential reference holding the bearer key. */
  apiKeyEnv?: string
  /** Speech-to-text model id. */
  sttModel?: string
  /** Speech-to-text wire mode. Defaults to `chat-audio`. */
  sttMode?: SttWireMode
  /** Text-to-speech model id. */
  ttsModel?: string
  /** Text-to-speech wire mode. Defaults to `chat-audio`. */
  ttsMode?: TtsWireMode
  /** Text-to-speech voice id. */
  ttsVoice?: string
  /** When false, the providers stay registered but refuse calls. Defaults to on. */
  enabled?: boolean
}

/** Loader-validated plugin config. */
export const Config: z<Config> = z.object({
  baseURL: z.string().default(OPENAI_COMPATIBLE_DEFAULT_BASE_URL),
  apiKeyEnv: z.string().default(OPENAI_COMPATIBLE_DEFAULT_KEY_REF),
  sttModel: z.string().default(OPENAI_COMPATIBLE_DEFAULT_STT_MODEL),
  sttMode: z.union([...STT_WIRE_MODES]).default('chat-audio'),
  ttsModel: z.string().default(OPENAI_COMPATIBLE_DEFAULT_TTS_MODEL),
  ttsMode: z.union([...TTS_WIRE_MODES]).default('chat-audio'),
  ttsVoice: z.string().default(OPENAI_COMPATIBLE_DEFAULT_TTS_VOICE),
  enabled: z.boolean().default(true),
})

/**
 * Fill the composition defaults and validate the credential reference at the
 * configuration boundary, so a malformed reference fails at load.
 * @param config - loader-validated plugin config.
 * @returns the composition facts {@link resolveSpec} layers the user section over.
 */
export function resolveComposition(config: Config): OpenAiCompatibleComposition {
  return {
    enabled: config.enabled !== false,
    baseURL: (config.baseURL ?? OPENAI_COMPATIBLE_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKeyRef: credentialRef(config.apiKeyEnv ?? OPENAI_COMPATIBLE_DEFAULT_KEY_REF),
    sttModel: config.sttModel ?? OPENAI_COMPATIBLE_DEFAULT_STT_MODEL,
    sttMode: config.sttMode ?? 'chat-audio',
    ttsModel: config.ttsModel ?? OPENAI_COMPATIBLE_DEFAULT_TTS_MODEL,
    ttsMode: config.ttsMode ?? 'chat-audio',
    ttsVoice: config.ttsVoice ?? OPENAI_COMPATIBLE_DEFAULT_TTS_VOICE,
  }
}
