/**
 * User-settings section owned by the speech seam.
 * @module @shres-code/shres-code-speech/settings
 */

import z from '@shres-code/schemastery'
import { settingsNamespace } from '@shres-code/shres-code-settings'

/** Settings namespace for read-aloud, voice, language, and auto-submit. */
export const SPEECH_SETTINGS_NAMESPACE = settingsNamespace('speech')

/** Default TTS voice id when the user has not chosen one. */
export const DEFAULT_SPEECH_VOICE_ID = 'af_heart'

/** Default BCP-47 language tag for TTS and STT. */
export const DEFAULT_SPEECH_LANGUAGE = 'en'

/** Credential reference holding the cloud endpoint key when none is configured. */
export const DEFAULT_SPEECH_CLOUD_KEY_REF = 'SPEECH_OPENAI_COMPATIBLE_API_KEY'

/**
 * OpenAI-compatible endpoint profile the `speech-openai-compatible` provider
 * consumes. Empty fields inherit the provider's composition config, so this
 * section only overrides what the user actually set from a configuration
 * surface.
 */
export interface SpeechCloudSettings {
  /** Endpoint base such as `https://openrouter.ai/api/v1`; empty inherits. */
  baseURL: string
  /** Speech-to-text model id; empty inherits. */
  sttModel: string
  /** Speech-to-text wire mode; empty inherits. */
  sttMode: '' | 'chat-audio' | 'transcriptions'
  /** Text-to-speech model id; empty inherits. */
  ttsModel: string
  /** Text-to-speech wire mode; empty inherits. */
  ttsMode: '' | 'chat-audio' | 'speech'
  /** Text-to-speech voice id; empty inherits. */
  ttsVoice: string
  /** Credential reference holding the endpoint key; empty inherits. */
  apiKeyEnv: string
}

/** Schema defaults for {@link SpeechCloudSettings}: everything inherits. */
export const DEFAULT_SPEECH_CLOUD_SETTINGS: SpeechCloudSettings = {
  baseURL: '',
  sttModel: '',
  sttMode: '',
  ttsModel: '',
  ttsMode: '',
  ttsVoice: '',
  apiKeyEnv: '',
}

/** Durable speech section shared by the Host schema and the browser scope. */
export interface SpeechUserSettings {
  /** When true, the Web client synthesizes each live-closing assistant turn. */
  readAloud: boolean
  /** Provider voice id passed to synthesize. */
  voiceId: string
  /** When true, a finished transcription submits the draft immediately. */
  autoSubmitVoice: boolean
  /** Language tag forwarded to TTS and STT. */
  language: string
  /**
   * When true, the composer is replaced by the talk surface. Transcripts
   * require explicit confirm before they reach the coding agent.
   */
  talkMode: boolean
  /**
   * User-layer STT pin. Empty resolves through the composition config
   * (`sttProvider` / `sttProviders`); a non-empty id must be a registered
   * provider and wins over every composition selection field.
   */
  sttProvider: string
  /** User-layer TTS pin, with the same precedence as {@link sttProvider}. */
  ttsProvider: string
  /** OpenAI-compatible endpoint profile; empty fields inherit composition config. */
  cloud: SpeechCloudSettings
}

/** Schema defaults used as the composition entry when no user layer exists. */
export const DEFAULT_SPEECH_USER_SETTINGS: SpeechUserSettings = {
  readAloud: false,
  voiceId: DEFAULT_SPEECH_VOICE_ID,
  autoSubmitVoice: false,
  language: DEFAULT_SPEECH_LANGUAGE,
  talkMode: false,
  sttProvider: '',
  ttsProvider: '',
  cloud: { ...DEFAULT_SPEECH_CLOUD_SETTINGS },
}

/** Durable speech schema; also the wire envelope the browser scope validates against. */
export const SpeechUserSettingsSchema: z<SpeechUserSettings> = z.object({
  readAloud: z.boolean().default(false),
  voiceId: z.string().default(DEFAULT_SPEECH_VOICE_ID),
  autoSubmitVoice: z.boolean().default(false),
  language: z.string().default(DEFAULT_SPEECH_LANGUAGE),
  talkMode: z.boolean().default(false),
  sttProvider: z.string().default(''),
  ttsProvider: z.string().default(''),
  cloud: z.object({
    baseURL: z.string().default(''),
    sttModel: z.string().default(''),
    sttMode: z.union(['', 'chat-audio', 'transcriptions']).default(''),
    ttsModel: z.string().default(''),
    ttsMode: z.union(['', 'chat-audio', 'speech']).default(''),
    ttsVoice: z.string().default(''),
    apiKeyEnv: z.string().default(''),
  }).default(DEFAULT_SPEECH_CLOUD_SETTINGS),
})
