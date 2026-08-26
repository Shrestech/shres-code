import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import SpeechRuntime from '@shres-code/shres-code-speech'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import {
  cacheIsWarm,
  decodePcm16Wav,
  prepareWhisperSamples,
  resampleLinear,
  resolveOptions,
  stripWhisperTranscript,
  WHISPER_MIN_SAMPLES,
  WHISPER_SAMPLE_RATE,
  WHISPER_STT_PROVIDER_ID,
  WHISPER_TARGET_PEAK,
  WhisperSttProvider,
} from '../src/index.ts'
import * as plugin from '../src/index.ts'
import type { WhisperLoader } from '../src/provider.ts'

const samples = new Float32Array([0, 0.25, -0.25, 0.5])

/** Minimal PCM16 WAV for decode/transcribe tests. */
function encodePcm16Wav(pcm: Float32Array, sampleRate: number, channels = 1): Uint8Array {
  const frameSize = 2 * channels
  const dataSize = (pcm.length / channels) * frameSize
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * frameSize, true)
  view.setUint16(32, frameSize, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (const sample of pcm) {
    const clipped = Math.min(1, Math.max(-1, sample))
    view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}

/** RIFF/WAVE with a data chunk and no fmt. */
function wavWithoutFmt(): Uint8Array {
  const buffer = new ArrayBuffer(44)
  const view = new DataView(buffer)
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36, true)
  tag(8, 'WAVE')
  tag(12, 'data')
  view.setUint32(16, 0, true)
  return new Uint8Array(buffer)
}

/** Valid PCM16 header whose dataSize overruns the buffer. */
function wavWithOverrun(): Uint8Array {
  const wav = encodePcm16Wav(samples, 16_000)
  const copy = new Uint8Array(wav)
  new DataView(copy.buffer).setUint32(40, 1_000_000, true)
  return copy
}

const wav = encodePcm16Wav(samples, 16_000)

const loadOk: WhisperLoader = () => Promise.resolve(async () => ({ text: ' hello pnpm ' }))

describe('decodePcm16Wav', () => {
  it('round-trips PCM16 mono', () => {
    const decoded = decodePcm16Wav(wav)
    expect(decoded.sampleRate).toBe(16_000)
    expect(decoded.samples.length).toBe(samples.length)
    expect(decoded.samples[1]).toBeCloseTo(0.25, 2)
  })

  it('rejects a non-WAV payload', () => {
    expect(() => decodePcm16Wav(new Uint8Array([1, 2, 3, 4]))).toThrow(
      expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    )
  })

  it('rejects a RIFF payload that is not WAVE', () => {
    const bytes = new Uint8Array(44)
    bytes.set([0x52, 0x49, 0x46, 0x46], 0)
    bytes.set([0x41, 0x56, 0x49, 0x20], 8)
    expect(() => decodePcm16Wav(bytes)).toThrow(
      expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    )
  })

  it('averages stereo PCM16 to mono', () => {
    const stereo = new Float32Array([0.5, -0.5, 0.25, 0.25])
    const decoded = decodePcm16Wav(encodePcm16Wav(stereo, 8_000, 2))
    expect(decoded.sampleRate).toBe(8_000)
    expect(decoded.samples).toHaveLength(2)
    expect(decoded.samples[0]).toBeCloseTo(0, 2)
    expect(decoded.samples[1]).toBeCloseTo(0.25, 2)
  })

  it('rejects a WAV with no fmt chunk', () => {
    expect(() => decodePcm16Wav(wavWithoutFmt())).toThrow(
      expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    )
  })

  it('rejects a data chunk that overruns the buffer', () => {
    expect(() => decodePcm16Wav(wavWithOverrun())).toThrow(
      expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    )
  })

  it('rejects a truncated fmt chunk', () => {
    const bytes = new Uint8Array(44)
    const view = new DataView(bytes.buffer)
    const tag = (offset: number, text: string): void => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
    }
    tag(0, 'RIFF')
    view.setUint32(4, 36, true)
    tag(8, 'WAVE')
    tag(12, 'JUNK')
    view.setUint32(16, 8, true)
    tag(28, 'fmt ')
    view.setUint32(32, 16, true)
    expect(() => decodePcm16Wav(bytes)).toThrow(
      expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    )
  })

  it('rejects non-PCM16 encodings', () => {
    const wav8 = encodePcm16Wav(samples, 16_000)
    new DataView(wav8.buffer).setUint16(34, 8, true)
    expect(() => decodePcm16Wav(wav8)).toThrow(
      expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    )
  })

  it('rejects a fmt-only WAV with no data chunk', () => {
    const bytes = encodePcm16Wav(samples, 16_000).slice(0, 36)
    const copy = new Uint8Array(44)
    copy.set(bytes)
    expect(() => decodePcm16Wav(copy)).toThrow(
      expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    )
  })

  it('rejects a RIFF WAVE with neither fmt nor data', () => {
    const bytes = new Uint8Array(44)
    bytes.set([0x52, 0x49, 0x46, 0x46], 0)
    bytes.set([0x57, 0x41, 0x56, 0x45], 8)
    expect(() => decodePcm16Wav(bytes)).toThrow(
      expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    )
  })
})

describe('cacheIsWarm', () => {
  it('is false when the path is a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shres-whisper-file-'))
    const file = join(dir, 'not-a-dir')
    try {
      await writeFile(file, 'x')
      expect(cacheIsWarm(file)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('resampleLinear', () => {
  it('returns the same buffer when the rates match', () => {
    const pcm = new Float32Array([0, 0.5, -0.5])
    expect(resampleLinear(pcm, 16_000, WHISPER_SAMPLE_RATE)).toBe(pcm)
  })

  it('returns an empty buffer unchanged', () => {
    const pcm = new Float32Array(0)
    expect(resampleLinear(pcm, 8_000, WHISPER_SAMPLE_RATE)).toBe(pcm)
  })

  it('doubles length from 8 kHz to 16 kHz', () => {
    const pcm = new Float32Array([0, 1])
    const out = resampleLinear(pcm, 8_000, WHISPER_SAMPLE_RATE)
    expect(out).toHaveLength(4)
    expect(out[0]).toBeCloseTo(0)
    expect(out[out.length - 1]).toBeCloseTo(1)
  })

  it('rejects a non-positive sample rate', () => {
    expect(() => resampleLinear(new Float32Array([0]), 0, WHISPER_SAMPLE_RATE)).toThrow(
      expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    )
    expect(() => resampleLinear(new Float32Array([0]), 16_000, Number.NaN)).toThrow(
      expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    )
  })
})

describe('prepareWhisperSamples', () => {
  it('returns empty for a silent buffer', () => {
    expect(prepareWhisperSamples(new Float32Array(32), 16_000)).toHaveLength(0)
  })

  it('raises a quiet clip and pads to one second', () => {
    const out = prepareWhisperSamples(new Float32Array([0.1, -0.1]), 16_000)
    expect(out).toHaveLength(WHISPER_MIN_SAMPLES)
    expect(Math.max(...out)).toBeCloseTo(WHISPER_TARGET_PEAK)
  })

  it('returns a loud full-second clip unchanged', () => {
    const pcm = new Float32Array(WHISPER_MIN_SAMPLES).fill(0.9)
    expect(prepareWhisperSamples(pcm, 16_000)).toBe(pcm)
  })
})

describe('stripWhisperTranscript', () => {
  it('drops the no-speech token', () => {
    expect(stripWhisperTranscript(' [BLANK_AUDIO] ')).toBe('')
    expect(stripWhisperTranscript('hello')).toBe('hello')
  })
})

describe('WhisperSttProvider', () => {
  it('is unavailable when downloads are forbidden and the cache is cold', () => {
    const provider = new WhisperSttProvider(() => resolveOptions({
      allowDownload: false,
      cacheDir: join(tmpdir(), 'shres-missing-whisper-cache'),
    }, loadOk))
    expect(provider.available()).toBe(false)
    expect(provider.id).toBe(WHISPER_STT_PROVIDER_ID)
  })

  it('returns empty text when the engine omits it', async () => {
    const load: WhisperLoader = () => Promise.resolve(async () => ({}))
    const provider = new WhisperSttProvider(() => resolveOptions({ allowDownload: true }, load))
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/wav' })).resolves.toEqual({ text: '' })
  })

  it('transcribes WAV and trims the text', async () => {
    const provider = new WhisperSttProvider(() => resolveOptions({ allowDownload: true }, loadOk))
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/wav' })).resolves.toEqual({
      text: 'hello pnpm',
    })
  })

  it('returns empty text without loading when the WAV is silent', async () => {
    let loads = 0
    const load: WhisperLoader = () => {
      loads += 1
      return Promise.resolve(async () => ({ text: 'nope' }))
    }
    const provider = new WhisperSttProvider(() => resolveOptions({ allowDownload: true }, load))
    const silence = encodePcm16Wav(new Float32Array(32), 16_000)
    await expect(provider.transcribe({ audio: silence, mediaType: 'audio/wav' })).resolves.toEqual({ text: '' })
    expect(loads).toBe(0)
  })

  it('strips [BLANK_AUDIO] from the engine transcript', async () => {
    const load: WhisperLoader = () => Promise.resolve(async () => ({ text: ' [BLANK_AUDIO] ' }))
    const provider = new WhisperSttProvider(() => resolveOptions({ allowDownload: true }, load))
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/wav' })).resolves.toEqual({ text: '' })
  })

  it('passes a 16 kHz Float32Array to the engine, not a raw/sampling_rate object', async () => {
    const seen: unknown[] = []
    const load: WhisperLoader = () => Promise.resolve(async (audio) => {
      seen.push(audio)
      return { text: 'ok' }
    })
    const provider = new WhisperSttProvider(() => resolveOptions({ allowDownload: true }, load))
    const high = encodePcm16Wav(new Float32Array([0.5, 1, 0.5, 1]), 48_000)
    await provider.transcribe({ audio: high, mediaType: 'audio/wav' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(Float32Array)
    expect((seen[0] as Float32Array).length).toBeGreaterThan(0)
  })

  it('rejects webm', async () => {
    const provider = new WhisperSttProvider(() => resolveOptions({ allowDownload: true }, loadOk))
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/webm' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    )
  })

  it('wraps engine failures', async () => {
    const load: WhisperLoader = () => Promise.resolve(async () => {
      throw new Error('onnx')
    })
    const provider = new WhisperSttProvider(() => resolveOptions({ allowDownload: true }, load))
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/wav' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_ERROR' }),
    )
  })

  it('throws when unavailable', async () => {
    const provider = new WhisperSttProvider(() => resolveOptions({
      allowDownload: false,
      cacheDir: join(tmpdir(), 'shres-missing-whisper-cache'),
    }, loadOk))
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/wav' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('shares one in-flight load across concurrent transcribes', async () => {
    let loads = 0
    let release!: (engine: Awaited<ReturnType<WhisperLoader>>) => void
    const load: WhisperLoader = () => {
      loads += 1
      return new Promise((resolve) => { release = resolve })
    }
    const provider = new WhisperSttProvider(() => resolveOptions({ allowDownload: true }, load))
    const first = provider.transcribe({ audio: wav, mediaType: 'audio/wav' })
    const second = provider.transcribe({ audio: wav, mediaType: 'audio/wav' })
    release(async () => ({ text: 'shared' }))
    await expect(Promise.all([first, second])).resolves.toEqual([{ text: 'shared' }, { text: 'shared' }])
    expect(loads).toBe(1)
  })

  it('clears a failed load so the next transcribe retries', async () => {
    let loads = 0
    const load: WhisperLoader = () => {
      loads += 1
      if (loads === 1) return Promise.reject(new Error('cold'))
      return Promise.resolve(async () => ({ text: 'ok' }))
    }
    const provider = new WhisperSttProvider(() => resolveOptions({ allowDownload: true }, load))
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/wav' })).rejects.toThrow('cold')
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/wav' })).resolves.toEqual({ text: 'ok' })
    expect(loads).toBe(2)
  })

  it('loads the engine once across transcribes', async () => {
    let loads = 0
    const load: WhisperLoader = () => {
      loads += 1
      return Promise.resolve(async () => ({ text: 'ok' }))
    }
    const provider = new WhisperSttProvider(() => resolveOptions({ allowDownload: true }, load))
    await provider.transcribe({ audio: wav, mediaType: 'audio/wav' })
    await provider.transcribe({ audio: wav, mediaType: 'audio/x-wav' })
    expect(loads).toBe(1)
  })

  it('forwards allowDownload to the loader request', async () => {
    const seen: boolean[] = []
    const load: WhisperLoader = (request) => {
      seen.push(request.allowDownload)
      return Promise.resolve(async () => ({ text: 'ok' }))
    }
    const dir = await mkdtemp(join(tmpdir(), 'shres-whisper-warm-'))
    try {
      await writeFile(join(dir, 'marker'), 'x')
      const off = new WhisperSttProvider(() => resolveOptions({ allowDownload: false, cacheDir: dir }, load))
      await off.transcribe({ audio: wav, mediaType: 'audio/wav' })
      const on = new WhisperSttProvider(() => resolveOptions({ allowDownload: true, cacheDir: dir }, load))
      await on.transcribe({ audio: wav, mediaType: 'audio/wav' })
      expect(seen).toEqual([false, true])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('passes a multilingual language kwarg and reloads when the checkpoint changes', async () => {
    const seen: Array<{ modelId: string; language?: string }> = []
    const load: WhisperLoader = request => Promise.resolve(async (_audio, options) => {
      seen.push({
        modelId: request.modelId,
        ...(options?.language === undefined ? {} : { language: options.language }),
      })
      return { text: 'ok' }
    })
    const current = { language: 'en' }
    const provider = new WhisperSttProvider(() => resolveOptions({
      allowDownload: true,
      language: current.language,
    }, load))
    await provider.transcribe({ audio: wav, mediaType: 'audio/wav' })
    current.language = 'es'
    await provider.transcribe({ audio: wav, mediaType: 'audio/wav' })
    expect(seen).toEqual([
      { modelId: 'Xenova/whisper-tiny.en' },
      { modelId: 'Xenova/whisper-tiny', language: 'spanish' },
    ])
  })
})

describe('resolveOptions', () => {
  it('derives the checkpoint from language unless modelId is pinned', () => {
    expect(resolveOptions({ language: 'en' }).modelId).toBe('Xenova/whisper-tiny.en')
    expect(resolveOptions({ language: 'ja' }).modelId).toBe('Xenova/whisper-tiny')
    expect(resolveOptions({ language: 'ja', modelId: 'Xenova/whisper-tiny.en' }).modelId).toBe(
      'Xenova/whisper-tiny.en',
    )
  })
})


describe('speech-whisper plugin', () => {
  it('registers whisper-tiny-en on ctx.speech', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime, { maxAudioBytes: 1024, maxTextChars: 64 })
    await ctx.plugin(plugin, { allowDownload: true })
    const status = await ctx.speech.status()
    expect(status.stt).toEqual({ kind: 'ready', providerId: WHISPER_STT_PROVIDER_ID })
  })

  it('unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime, { maxAudioBytes: 1024, maxTextChars: 64 })
    const fiber = await ctx.plugin(plugin, { allowDownload: true })
    expect((await ctx.speech.status()).stt.kind).toBe('ready')
    await fiber.dispose()
    expect((await ctx.speech.status()).stt.kind).toBe('unavailable')
  })
})
