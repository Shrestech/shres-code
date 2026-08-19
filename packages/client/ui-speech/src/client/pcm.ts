/**
 * Browser PCM16 WAV helpers for the mic path.
 * @module @shres-code/shres-code-client-ui-speech/client/pcm
 */

/**
 * Encode a Web Audio buffer as mono PCM16 WAV at the buffer's sample rate.
 * @param buffer - decoded recording.
 * @returns a complete WAV file.
 */
export function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const sampleRate = buffer.sampleRate
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let mix = 0
    for (let c = 0; c < channels; c += 1) {
      const sample = buffer.getChannelData(c)[i]
      mix += sample === undefined ? 0 : sample
    }
    samples[i] = mix / channels
  }
  const dataSize = frames * 2
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)
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
  return new Uint8Array(out)
}

/**
 * Encode bytes as canonical base64 for the speech Remote.
 * @param bytes - WAV body.
 * @returns standard base64.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Write four ASCII bytes.
 * @param view - target.
 * @param offset - byte offset.
 * @param text - four-character tag.
 */
function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
}
