/**
 * PCM16 WAV decoder for Whisper input.
 * @module @shres-code/shres-code-speech-whisper/wav
 */

import { SpeechError } from '@shres-code/shres-code-speech'

/** Whisper tiny.en feature-extractor rate. Transformers 3.8 does not resample a Float32Array. */
export const WHISPER_SAMPLE_RATE = 16_000

/** Pad to at least one second so a short mic tap is not classified as no-speech. */
export const WHISPER_MIN_SAMPLES = WHISPER_SAMPLE_RATE

/** Peak below this is treated as silence. */
export const WHISPER_SILENCE_PEAK = 1e-4

/** Target peak after gain so a quiet mic still crosses Whisper's no-speech gate. */
export const WHISPER_TARGET_PEAK = 0.8

const BLANK_TRANSCRIPT = /^(?:\[(?:BLANK_AUDIO|silence|inaudible)\]|blank audio)$/iu

/** Samples plus the WAV sample rate. */
export interface PcmWav {
  readonly samples: Float32Array
  readonly sampleRate: number
}

/**
 * Linearly resample PCM to `toRate`. Identity when the rates already match.
 * @param samples - mono float samples.
 * @param fromRate - source sample rate in Hz.
 * @param toRate - target sample rate in Hz.
 * @returns samples at `toRate`.
 */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0 || !Number.isFinite(fromRate) || !Number.isFinite(toRate)) {
    throw new SpeechError('WAV sample rate is not a positive finite Hz value', 'SPEECH_UNSUPPORTED_MEDIA')
  }
  if (samples.length === 0 || fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const out = new Float32Array(Math.max(1, Math.round(samples.length / ratio)))
  const last = samples.length - 1
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio
    const i0 = Math.min(Math.floor(src), last)
    const i1 = Math.min(i0 + 1, last)
    const frac = src - i0
    const a = samples[i0] ?? 0
    const b = samples[i1] ?? 0
    out[i] = a + (b - a) * frac
  }
  return out
}

/**
 * Peak of absolute samples.
 * @param samples - mono float PCM.
 * @returns max |sample|.
 */
export function peakAmplitude(samples: Float32Array): number {
  let peak = 0
  for (const sample of samples) {
    const magnitude = Math.abs(sample)
    if (magnitude > peak) peak = magnitude
  }
  return peak
}

/**
 * Resample to 16 kHz, raise a quiet clip to {@link WHISPER_TARGET_PEAK}, and
 * pad to {@link WHISPER_MIN_SAMPLES}. Empty when the source is silence.
 * @param samples - mono float PCM at `fromRate`.
 * @param fromRate - source sample rate in Hz.
 * @returns 16 kHz samples, or an empty buffer when there is no speech energy.
 */
export function prepareWhisperSamples(samples: Float32Array, fromRate: number): Float32Array {
  const resampled = resampleLinear(samples, fromRate, WHISPER_SAMPLE_RATE)
  const peak = peakAmplitude(resampled)
  if (resampled.length === 0 || peak < WHISPER_SILENCE_PEAK) return new Float32Array(0)
  const gain = peak < WHISPER_TARGET_PEAK ? WHISPER_TARGET_PEAK / peak : 1
  const length = Math.max(resampled.length, WHISPER_MIN_SAMPLES)
  const out = new Float32Array(length)
  if (gain === 1 && resampled.length === length) return resampled
  for (let i = 0; i < resampled.length; i++) out[i] = (resampled[i] ?? 0) * gain
  return out
}

/**
 * Drop Whisper's no-speech tokens so they never reach the composer.
 * @param text - raw pipeline transcript.
 * @returns trimmed speech, or empty when the model reported silence.
 */
export function stripWhisperTranscript(text: string): string {
  const trimmed = text.trim()
  return BLANK_TRANSCRIPT.test(trimmed) ? '' : trimmed
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
