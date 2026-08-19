/**
 * PCM16 WAV encoder for Kokoro Float32 samples.
 * @module @shres-code/shres-code-speech-kokoro/wav
 */

/** Kokoro's native sample rate. */
export const KOKORO_SAMPLE_RATE = 24_000

/**
 * Encode mono float samples as a canonical PCM16 WAV body.
 * @param samples - amplitudes in [-1, 1].
 * @param sampleRate - samples per second (Kokoro uses 24000).
 * @returns a complete WAV file.
 */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number = KOKORO_SAMPLE_RATE): Uint8Array {
  const dataSize = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (const sample of samples) {
    const clipped = Math.min(1, Math.max(-1, sample))
    view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}

/**
 * Write four ASCII bytes at `offset`.
 * @param view - target view.
 * @param offset - byte offset.
 * @param text - four-character tag.
 */
function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
}
