/**
 * Settings constants this plugin shares with the Host speech section.
 * Spelled here: the client must not import the Host package at runtime
 * (the bundle purity gate rejects cross-plugin value imports);
 * `tests/controls.client.spec.tsx` asserts these match the Host values.
 */

/** Stored speech settings the Host section registers. */
export interface SpeechUserSettings {
  /** When true, the Web client synthesizes each live-closing assistant turn. */
  readAloud?: boolean
  /** Provider voice id passed to synthesize. */
  voiceId?: string
  /** When true, a finished transcription submits the draft immediately. */
  autoSubmitVoice?: boolean
  /** Language tag forwarded to TTS and STT. */
  language?: string
  /** When true, the talk surface replaces typing and requires confirm-to-send. */
  talkMode?: boolean
  /** User-layer STT pin; empty resolves through the composition config. */
  sttProvider?: string
  /** User-layer TTS pin, with the same precedence as {@link sttProvider}. */
  ttsProvider?: string
  /** OpenAI-compatible endpoint profile; empty fields inherit composition config. */
  cloud?: {
    /** Endpoint base; empty inherits. */
    baseURL?: string
    /** STT model id; empty inherits. */
    sttModel?: string
    /** STT wire mode; empty inherits. */
    sttMode?: string
    /** TTS model id; empty inherits. */
    ttsModel?: string
    /** TTS wire mode; empty inherits. */
    ttsMode?: string
    /** TTS voice id; empty inherits. */
    ttsVoice?: string
    /** Credential reference holding the endpoint key; empty inherits. */
    apiKeyEnv?: string
  }
}

/** Settings namespace the Host speech section registers. */
export const SPEECH_SETTINGS_NAMESPACE = 'speech'

/** Voice id the Host section defaults to. */
export const DEFAULT_SPEECH_VOICE_ID = 'af_heart'

/** BCP-47 tag the Host section defaults to. */
export const DEFAULT_SPEECH_LANGUAGE = 'en'

/** Credential reference the cloud speech provider defaults to. */
export const DEFAULT_SPEECH_CLOUD_KEY_REF = 'SPEECH_OPENAI_COMPATIBLE_API_KEY'
