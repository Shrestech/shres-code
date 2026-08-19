/**
 * Built-in Kokoro JS/ONNX English voices. The picker uses this catalog so
 * Settings can list voices before the 82M weights are loaded.
 * @module @shres-code/shres-code-speech-kokoro/voices
 */

import type { SpeechVoice } from '@shres-code/shres-code-speech'

/** Default Kokoro voice (highest-graded American English female). */
export const KOKORO_DEFAULT_VOICE_ID = 'af_heart'

/** English voices shipped with onnx-community/Kokoro-82M-v1.0-ONNX. */
export const KOKORO_VOICES: readonly SpeechVoice[] = Object.freeze([
  { id: 'af_heart', name: 'Heart', language: 'en-US' },
  { id: 'af_bella', name: 'Bella', language: 'en-US' },
  { id: 'af_nicole', name: 'Nicole', language: 'en-US' },
  { id: 'af_alloy', name: 'Alloy', language: 'en-US' },
  { id: 'af_aoede', name: 'Aoede', language: 'en-US' },
  { id: 'af_jessica', name: 'Jessica', language: 'en-US' },
  { id: 'af_kore', name: 'Kore', language: 'en-US' },
  { id: 'af_nova', name: 'Nova', language: 'en-US' },
  { id: 'af_river', name: 'River', language: 'en-US' },
  { id: 'af_sarah', name: 'Sarah', language: 'en-US' },
  { id: 'af_sky', name: 'Sky', language: 'en-US' },
  { id: 'am_adam', name: 'Adam', language: 'en-US' },
  { id: 'am_echo', name: 'Echo', language: 'en-US' },
  { id: 'am_eric', name: 'Eric', language: 'en-US' },
  { id: 'am_fenrir', name: 'Fenrir', language: 'en-US' },
  { id: 'am_liam', name: 'Liam', language: 'en-US' },
  { id: 'am_michael', name: 'Michael', language: 'en-US' },
  { id: 'am_onyx', name: 'Onyx', language: 'en-US' },
  { id: 'am_puck', name: 'Puck', language: 'en-US' },
  { id: 'am_santa', name: 'Santa', language: 'en-US' },
  { id: 'bf_alice', name: 'Alice', language: 'en-GB' },
  { id: 'bf_emma', name: 'Emma', language: 'en-GB' },
  { id: 'bf_isabella', name: 'Isabella', language: 'en-GB' },
  { id: 'bf_lily', name: 'Lily', language: 'en-GB' },
  { id: 'bm_daniel', name: 'Daniel', language: 'en-GB' },
  { id: 'bm_fable', name: 'Fable', language: 'en-GB' },
  { id: 'bm_george', name: 'George', language: 'en-GB' },
  { id: 'bm_lewis', name: 'Lewis', language: 'en-GB' },
])
