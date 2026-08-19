/**
 * Vocabulary for the speech capability seam (`ctx.speech`). Synthesize and
 * transcribe share one seam so provider selection, cancellation, errors, and
 * product configuration have one owner, while retaining separate request and
 * result types.
 * @module @shres-code/shres-code-speech/types
 */

import { HarnessError } from '@shres-code/shres-code-llm'

/** Raster-free audio formats the seam accepts from a recorder or file. */
export const SPEECH_INPUT_MEDIA_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/mp3',
] as const

/** One accepted input media type. */
export type SpeechInputMediaType = typeof SPEECH_INPUT_MEDIA_TYPES[number]

/** Output media type produced by synthesize. Local Kokoro emits WAV. */
export type SpeechOutputMediaType = 'audio/wav' | 'audio/mpeg'

/**
 * True when `value` is one of {@link SPEECH_INPUT_MEDIA_TYPES}.
 * @param value - candidate media type, already stripped of parameters.
 * @returns whether the seam accepts it.
 */
export function isSpeechInputMediaType(value: string): value is SpeechInputMediaType {
  return (SPEECH_INPUT_MEDIA_TYPES as readonly string[]).includes(value)
}

/**
 * Drop MIME parameters (`audio/webm;codecs=opus` → `audio/webm`) so a
 * recorder's full type still matches the closed input vocabulary.
 * @param value - raw Content-Type or MediaRecorder mimeType.
 * @returns the type token before `;`, trimmed and lowercased.
 */
export function speechMediaTypeToken(value: string): string {
  const [token] = value.split(';', 1)
  return (token ?? '').trim().toLowerCase()
}

/** One catalogued TTS voice. */
export interface SpeechVoice {
  readonly id: string
  readonly name: string
  readonly language?: string
}

/** In-process synthesize request. */
export interface SpeechSynthesizeRequest {
  readonly text: string
  readonly voiceId?: string
  readonly language?: string
}

/** In-process synthesize result. */
export interface SpeechSynthesizeResult {
  readonly audio: Uint8Array
  readonly mediaType: SpeechOutputMediaType
  readonly voiceId: string
}

/** In-process transcribe request. */
export interface SpeechTranscribeRequest {
  readonly audio: Uint8Array
  readonly mediaType: SpeechInputMediaType
  readonly language?: string
}

/** In-process transcribe result. */
export interface SpeechTranscribeResult {
  readonly text: string
}

/** A TTS-capable backend. Registered with `ctx.speech.registerTtsProvider`. */
export interface SpeechTtsProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Voices this backend will accept as `voiceId`. */
  listVoices(): Promise<readonly SpeechVoice[]>
  /** Turn speakable text into audio; honor `signal` for cancellation. */
  synthesize(
    request: SpeechSynthesizeRequest,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesizeResult>
}

/** An STT-capable backend. Registered with `ctx.speech.registerSttProvider`. */
export interface SpeechSttProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Turn recorded audio into text; honor `signal` for cancellation. */
  transcribe(
    request: SpeechTranscribeRequest,
    signal?: AbortSignal,
  ): Promise<SpeechTranscribeResult>
}

/** Why one capability kind cannot run, or that it can. */
export type SpeechCapabilityStatus =
  | { readonly kind: 'ready'; readonly providerId: string }
  | { readonly kind: 'unavailable'; readonly code: string; readonly message: string }

/** Snapshot a client uses to enable or disable mic and speaker chrome. */
export interface SpeechStatus {
  readonly tts: SpeechCapabilityStatus
  readonly stt: SpeechCapabilityStatus
  readonly voices: readonly SpeechVoice[]
}

/** Wire request for Remote `synthesize`. */
export interface SpeechSynthesizeWireRequest {
  readonly text: string
  readonly voiceId?: string
  readonly language?: string
}

/** Successful audio payload for Remote `synthesize`. */
export interface SpeechSynthesizeAudioValue {
  readonly kind: 'audio'
  readonly audioBase64: string
  readonly mediaType: SpeechOutputMediaType
  readonly voiceId: string
}

/** Successful no-audio payload when the speakable script is empty. */
export interface SpeechSynthesizeEmptyValue {
  readonly kind: 'empty'
}

/** Wire failure for a Remote method. */
export interface SpeechWireFailure {
  readonly code: string
  readonly message: string
}

/** Remote `synthesize` result. */
export type SpeechSynthesizeWireResult =
  | { readonly ok: true; readonly value: SpeechSynthesizeAudioValue | SpeechSynthesizeEmptyValue }
  | { readonly ok: false; readonly error: SpeechWireFailure }

/** Wire request for Remote `transcribe`. */
export interface SpeechTranscribeWireRequest {
  readonly audioBase64: string
  readonly mediaType: string
  readonly language?: string
}

/** Remote `transcribe` result. */
export type SpeechTranscribeWireResult =
  | { readonly ok: true; readonly value: SpeechTranscribeResult }
  | { readonly ok: false; readonly error: SpeechWireFailure }

/**
 * Typed speech error with a machine-routable, open-string `code` and chained
 * `cause`. Shared codes cover unavailable, missing, unusable, ambiguous, or
 * duplicate providers, invalid wire payloads, size caps, unsupported media,
 * cancellation, and provider failure.
 */
export class SpeechError extends HarnessError {}
