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
}

/** Settings namespace the Host speech section registers. */
export const SPEECH_SETTINGS_NAMESPACE = 'speech'

/** Voice id the Host section defaults to. */
export const DEFAULT_SPEECH_VOICE_ID = 'af_heart'
