/**
 * Live speech capability snapshot the mic, speaker, and settings rows share.
 * @module @shres-code/shres-code-client-ui-speech/client/status
 */

import type { SpeechVoice } from '@shres-code/shres-code-speech/types'

/** Client-side projection of Remote `status()`. */
export interface SpeechClientStatus {
  /** Selected TTS provider is usable. */
  readonly ttsReady: boolean
  /** Selected STT provider is usable. */
  readonly sttReady: boolean
  /** Voices from the ready TTS provider, empty when TTS is unavailable. */
  readonly voices: readonly SpeechVoice[]
}

/** Initial status before the first successful `status()` call. */
export const INITIAL_SPEECH_CLIENT_STATUS: SpeechClientStatus = {
  ttsReady: false,
  sttReady: false,
  voices: [],
}
