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
}

/** Schema defaults used as the composition entry when no user layer exists. */
export const DEFAULT_SPEECH_USER_SETTINGS: SpeechUserSettings = {
  readAloud: false,
  voiceId: DEFAULT_SPEECH_VOICE_ID,
  autoSubmitVoice: false,
  language: DEFAULT_SPEECH_LANGUAGE,
}

/** Durable speech schema; also the wire envelope the browser scope validates against. */
export const SpeechUserSettingsSchema: z<SpeechUserSettings> = z.object({
  readAloud: z.boolean().default(false),
  voiceId: z.string().default(DEFAULT_SPEECH_VOICE_ID),
  autoSubmitVoice: z.boolean().default(false),
  language: z.string().default(DEFAULT_SPEECH_LANGUAGE),
})
