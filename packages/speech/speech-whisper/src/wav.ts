/**
 * PCM16 WAV decoder for Whisper input.
 * @module @shres-code/shres-code-speech-whisper/wav
 */

import { SpeechError } from '@shres-code/shres-code-speech'

/** Samples plus the WAV sample rate. */
export interface PcmWav {
  readonly samples: Float32Array
  readonly sampleRate: number
}

/**
 * Decode a canonical PCM16 mono or stereo WAV into float samples.
 * Stereo is averaged to mono. Other encodings are rejected.
 * @param bytes - complete WAV file.
 * @returns float samples in [-1, 1] and the file sample rate.
 */
export function decodePcm16Wav(bytes: Uint8Array): PcmWav {
  if (bytes.byteLength < 44) {
    throw new SpeechError('WAV body is too small', 'SPEECH_UNSUPPORTED_MEDIA')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new SpeechError('audio is not a WAV file', 'SPEECH_UNSUPPORTED_MEDIA')
  }
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let dataOffset = -1
  let dataSize = 0
  let sawFmt = false
  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (id === 'fmt ') {
      if (start + 16 > view.byteLength) {
        throw new SpeechError('WAV fmt chunk is truncated', 'SPEECH_UNSUPPORTED_MEDIA')
      }
      const format = view.getUint16(start, true)
      channels = view.getUint16(start + 2, true)
      sampleRate = view.getUint32(start + 4, true)
      const bits = view.getUint16(start + 14, true)
      if (format !== 1 || (channels !== 1 && channels !== 2) || bits !== 16) {
        throw new SpeechError('WAV must be PCM16 mono or stereo', 'SPEECH_UNSUPPORTED_MEDIA')
      }
      sawFmt = true
    } else if (id === 'data') {
      if (!sawFmt) {
        throw new SpeechError('WAV data chunk appeared before fmt', 'SPEECH_UNSUPPORTED_MEDIA')
      }
      dataOffset = start
      dataSize = size
      break
    }
    offset = start + size + (size % 2)
  }
  if (!sawFmt) throw new SpeechError('WAV has no fmt chunk', 'SPEECH_UNSUPPORTED_MEDIA')
  if (dataOffset < 0) throw new SpeechError('WAV has no data chunk', 'SPEECH_UNSUPPORTED_MEDIA')
  if (dataOffset + dataSize > view.byteLength) {
    throw new SpeechError('WAV data chunk extends past the buffer', 'SPEECH_UNSUPPORTED_MEDIA')
  }
  const sampleCount = Math.floor(dataSize / (2 * channels))
  const samples = new Float32Array(sampleCount)
  let cursor = dataOffset
  for (let i = 0; i < sampleCount; i += 1) {
    if (channels === 1) {
      samples[i] = view.getInt16(cursor, true) / 0x8000
      cursor += 2
    } else {
      const left = view.getInt16(cursor, true) / 0x8000
      const right = view.getInt16(cursor + 2, true) / 0x8000
      samples[i] = (left + right) / 2
      cursor += 4
    }
  }
  return { samples, sampleRate }
}

/**
 * Read ASCII from a DataView.
 * @param view - source.
 * @param offset - byte offset.
 * @param length - character count.
 * @returns the decoded string.
 */
function readAscii(view: DataView, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i))
  return out
}
