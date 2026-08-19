/**
 * Canonical base64 helpers for speech Remote payloads.
 * @module @shres-code/shres-code-speech/wire
 */

import { SpeechError } from './types.ts'

/**
 * Decode a Remote audio payload while rejecting non-canonical base64 forms.
 * @param data - caller-supplied base64.
 * @returns the decoded bytes.
 */
export function decodeSpeechBase64(data: string): Uint8Array {
  if (data.length === 0) {
    throw new SpeechError('Audio upload is empty.', 'SPEECH_INVALID_BASE64')
  }
  const decoded = Buffer.from(data, 'base64')
  if (decoded.toString('base64') !== data) {
    throw new SpeechError('Audio upload is not canonical base64.', 'SPEECH_INVALID_BASE64')
  }
  return new Uint8Array(decoded)
}

/**
 * Encode audio bytes as canonical base64 for a Remote response.
 * @param audio - synthesized bytes.
 * @returns the canonical base64 string.
 */
export function encodeSpeechBase64(audio: Uint8Array): string {
  return Buffer.from(audio).toString('base64')
}
