import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import SpeechRuntime from '@shres-code/shres-code-speech'
import {
  audioToWav,
  cacheIsWarm,
  encodePcm16Wav,
  KOKORO_TTS_PROVIDER_ID,
  KokoroTtsProvider,
  loadKokoroJs,
  resolveOptions,
} from '../src/index.ts'
import * as plugin from '../src/index.ts'
import type { KokoroEngine, KokoroLoader, KokoroLoadRequest } from '../src/provider.ts'

const pcm = new Float32Array([0, 0.5, -0.5, 1])

function fakeEngine(overrides: Partial<KokoroEngine> = {}): KokoroEngine {
  return {
    list_voices: () => ['af_heart'],
    generate: () => Promise.resolve({
      audio: pcm,
      sampling_rate: 24000,
    }),
    ...overrides,
  }
}

function loader(engine: KokoroEngine): KokoroLoader {
  return () => Promise.resolve(engine)
}

describe('encodePcm16Wav / audioToWav', () => {
  it('encodes a WAV header and PCM16 samples', () => {
    const wav = encodePcm16Wav(pcm, 24000)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(wav.byteLength).toBe(44 + pcm.length * 2)
  })

  it('prefers toWav when present', async () => {
    const body = new Uint8Array([1, 2, 3])
    const wav = await audioToWav({ toWav: () => body })
    expect(wav).toEqual(body)
  })

  it('accepts an ArrayBuffer from toWav', async () => {
    const wav = await audioToWav({ toWav: () => new Uint8Array([9, 8, 7]).buffer })
    expect(wav).toEqual(new Uint8Array([9, 8, 7]))
  })

  it('encodes Float32 audio when toWav is absent', async () => {
    const wav = await audioToWav({ audio: pcm, sampling_rate: 24000 })
    expect(wav.byteLength).toBeGreaterThan(44)
  })

  it('throws when generate returned nothing', async () => {
    await expect(audioToWav({})).rejects.toThrow(expect.objectContaining({ code: 'SPEECH_PROVIDER_ERROR' }))
  })
})

describe('cacheIsWarm', () => {
  it('is false for a missing directory', () => {
    expect(cacheIsWarm(join(tmpdir(), 'shres-missing-kokoro-cache'))).toBe(false)
  })

  it('is true when the directory has a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shres-kokoro-'))
    try {
      await writeFile(join(dir, 'marker'), 'x')
      expect(cacheIsWarm(dir)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is false when the path is a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shres-kokoro-file-'))
    const file = join(dir, 'not-a-dir')
    try {
      await writeFile(file, 'x')
      expect(cacheIsWarm(file)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('KokoroTtsProvider', () => {
  it('is unavailable when downloads are forbidden and the cache is cold', () => {
    const provider = new KokoroTtsProvider(() => resolveOptions({
      allowDownload: false,
      cacheDir: join(tmpdir(), 'shres-missing-kokoro-cache'),
    }, loader(fakeEngine())))
    expect(provider.available()).toBe(false)
    expect(provider.id).toBe(KOKORO_TTS_PROVIDER_ID)
  })

  it('is available from a warm cache when downloads are forbidden', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shres-kokoro-warm-'))
    try {
      await writeFile(join(dir, 'marker'), 'x')
      const provider = new KokoroTtsProvider(() => resolveOptions({
        allowDownload: false,
        cacheDir: dir,
      }, loader(fakeEngine())))
      expect(provider.available()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is unavailable when disabled', () => {
    const provider = new KokoroTtsProvider(() => resolveOptions({
      enabled: false,
      allowDownload: true,
    }, loader(fakeEngine())))
    expect(provider.available()).toBe(false)
  })

  it('is available when downloads are allowed', () => {
    const provider = new KokoroTtsProvider(() => resolveOptions({
      allowDownload: true,
      cacheDir: join(tmpdir(), 'shres-missing-kokoro-cache'),
    }, loader(fakeEngine())))
    expect(provider.available()).toBe(true)
  })

  it('forwards the requested voice and returns WAV', async () => {
    let seen = ''
    const engine = fakeEngine({
      generate: (_text, options) => {
        seen = options.voice
        return Promise.resolve({ audio: pcm })
      },
    })
    const provider = new KokoroTtsProvider(() => resolveOptions({}, loader(engine)))
    const result = await provider.synthesize({ text: 'Hello', voiceId: 'am_michael' })
    expect(seen).toBe('am_michael')
    expect(result.mediaType).toBe('audio/wav')
    expect(result.voiceId).toBe('am_michael')
    expect(result.audio.byteLength).toBeGreaterThan(44)
  })

  it('defaults the voice to af_heart', async () => {
    let seen = ''
    const engine = fakeEngine({
      generate: (_text, options) => {
        seen = options.voice
        return Promise.resolve({ audio: pcm })
      },
    })
    const provider = new KokoroTtsProvider(() => resolveOptions({}, loader(engine)))
    await provider.synthesize({ text: 'Hello' })
    expect(seen).toBe('af_heart')
  })

  it('lists the 28 English voices without loading weights', async () => {
    const provider = new KokoroTtsProvider(() => resolveOptions({}, loader(fakeEngine())))
    const voices = await provider.listVoices()
    expect(voices).toHaveLength(28)
    expect(voices.some(voice => voice.id === 'af_heart')).toBe(true)
    expect(voices.some(voice => voice.id === 'bm_lewis')).toBe(true)
  })

  it('wraps generate failures', async () => {
    const engine = fakeEngine({
      generate: () => Promise.reject(new Error('onnx')),
    })
    const provider = new KokoroTtsProvider(() => resolveOptions({}, loader(engine)))
    await expect(provider.synthesize({ text: 'Hello' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_ERROR' }),
    )
  })

  it('throws when unavailable', async () => {
    const provider = new KokoroTtsProvider(() => resolveOptions({
      allowDownload: false,
      cacheDir: join(tmpdir(), 'shres-missing-kokoro-cache'),
    }, loader(fakeEngine())))
    await expect(provider.synthesize({ text: 'Hello' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('loads the engine once across synthesizes', async () => {
    let loads = 0
    const load: KokoroLoader = () => {
      loads += 1
      return Promise.resolve(fakeEngine())
    }
    const provider = new KokoroTtsProvider(() => resolveOptions({}, load))
    await provider.synthesize({ text: 'one' })
    await provider.synthesize({ text: 'two' })
    expect(loads).toBe(1)
  })

  it('shares one in-flight load across concurrent synthesizes', async () => {
    let loads = 0
    let release!: (engine: KokoroEngine) => void
    const load: KokoroLoader = () => {
      loads += 1
      return new Promise((resolve) => { release = resolve })
    }
    const provider = new KokoroTtsProvider(() => resolveOptions({}, load))
    const first = provider.synthesize({ text: 'one' })
    const second = provider.synthesize({ text: 'two' })
    release(fakeEngine())
    await Promise.all([first, second])
    expect(loads).toBe(1)
  })

  it('retries the load after a failure', async () => {
    let loads = 0
    const load: KokoroLoader = () => {
      loads += 1
      if (loads === 1) return Promise.reject(new Error('cold'))
      return Promise.resolve(fakeEngine())
    }
    const provider = new KokoroTtsProvider(() => resolveOptions({}, load))
    await expect(provider.synthesize({ text: 'one' })).rejects.toThrow('cold')
    await expect(provider.synthesize({ text: 'two' })).resolves.toMatchObject({ mediaType: 'audio/wav' })
    expect(loads).toBe(2)
  })

  it('forwards allowDownload to the loader request', async () => {
    const seen: boolean[] = []
    const load: KokoroLoader = (request) => {
      seen.push(request.allowDownload)
      return Promise.resolve(fakeEngine())
    }
    const dir = await mkdtemp(join(tmpdir(), 'shres-kokoro-warm-'))
    try {
      await writeFile(join(dir, 'marker'), 'x')
      const off = new KokoroTtsProvider(() => resolveOptions({ allowDownload: false, cacheDir: dir }, load))
      await off.synthesize({ text: 'Hello' })
      const on = new KokoroTtsProvider(() => resolveOptions({ allowDownload: true, cacheDir: dir }, load))
      await on.synthesize({ text: 'Hello' })
      expect(seen).toEqual([false, true])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('loadKokoroJs', () => {
  it('releases the env lock when the transformers import rejects', async () => {
    const request: KokoroLoadRequest = {
      modelId: 'test/model',
      dtype: 'q8',
      device: 'cpu',
      cacheDir: join(tmpdir(), 'shres-missing-kokoro-cache'),
      allowDownload: false,
      importTransformers: () => Promise.reject(new Error('transformers missing')),
    }
    await expect(loadKokoroJs(request)).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_ERROR' }),
    )
    // A held lock would hang this second attempt; it must reject the same way.
    await expect(loadKokoroJs(request)).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_ERROR' }),
    )
  })
})

describe('speech-kokoro Config', () => {
  it('accepts a closed dtype and device', () => {
    expect(plugin.Config({ dtype: 'q4', device: 'cpu' })).toMatchObject({ dtype: 'q4', device: 'cpu' })
  })

  it('rejects an unknown dtype at load', () => {
    expect(() => plugin.Config({ dtype: 'q16' as never })).toThrow()
  })

  it('rejects an unknown device at load', () => {
    expect(() => plugin.Config({ device: 'cuda' as never })).toThrow()
  })
})

describe('speech-kokoro plugin', () => {
  it('registers kokoro-tts on ctx.speech', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime, { maxAudioBytes: 1024, maxTextChars: 64 })
    await ctx.plugin(plugin, { allowDownload: true })
    const status = await ctx.speech.status()
    expect(status.tts).toEqual({ kind: 'ready', providerId: KOKORO_TTS_PROVIDER_ID })
  })

  it('unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime, { maxAudioBytes: 1024, maxTextChars: 64 })
    const fiber = await ctx.plugin(plugin, { allowDownload: true })
    expect((await ctx.speech.status()).tts.kind).toBe('ready')
    await fiber.dispose()
    expect((await ctx.speech.status()).tts.kind).toBe('unavailable')
  })
})
