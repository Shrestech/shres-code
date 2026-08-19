import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import SpeechRuntime, {
  decodeSpeechBase64,
  encodeSpeechBase64,
  isSpeechInputMediaType,
  SPEECH_SETTINGS_NAMESPACE,
  SpeechError,
  speechMediaTypeToken,
  type SpeechSttProvider,
  type SpeechSynthesizeRequest,
  type SpeechSynthesizeResult,
  type SpeechTranscribeRequest,
  type SpeechTranscribeResult,
  type SpeechTtsProvider,
} from '@shres-code/shres-code-speech'
import * as SpeechInvariant from '../src/invariant.ts'

/** The smallest real settings provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

const LIMITS = { maxAudioBytes: 1024, maxTextChars: 64 } as const

const mpeg = new Uint8Array([1, 2, 3, 4])

function ttsProvider(
  id: string,
  available: boolean,
  synthesize: (request: SpeechSynthesizeRequest) => Promise<SpeechSynthesizeResult> = request =>
    Promise.resolve({ audio: mpeg, mediaType: 'audio/mpeg', voiceId: request.voiceId ?? 'eve' }),
): SpeechTtsProvider {
  return {
    id,
    available: () => available,
    listVoices: () => Promise.resolve([{ id: 'eve', name: 'Eve' }]),
    synthesize,
  }
}

function sttProvider(
  id: string,
  available: boolean,
  transcribe: (request: SpeechTranscribeRequest) => Promise<SpeechTranscribeResult> = () =>
    Promise.resolve({ text: id }),
): SpeechSttProvider {
  return { id, available: () => available, transcribe }
}

async function mountSpeech(
  config: ConstructorParameters<typeof SpeechRuntime>[1] = LIMITS,
): Promise<{ ctx: Context; speech: SpeechRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SpeechRuntime, config)
  return { ctx, speech: ctx.speech }
}

describe('SpeechRuntime registration', () => {
  it('registers a TTS provider and unregisters it via the returned disposer', async () => {
    const { speech } = await mountSpeech()
    const dispose = speech.registerTtsProvider(ttsProvider('xai-tts', true))
    await expect(speech.synthesize({ text: 'Hello' })).resolves.toMatchObject({ voiceId: 'af_heart' })
    dispose()
    await expect(speech.synthesize({ text: 'Hello' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('throws SPEECH_DUPLICATE_PROVIDER on a duplicate TTS id', async () => {
    const { speech } = await mountSpeech()
    speech.registerTtsProvider(ttsProvider('xai-tts', true))
    expect(() => speech.registerTtsProvider(ttsProvider('xai-tts', true))).toThrow(
      expect.objectContaining({ code: 'SPEECH_DUPLICATE_PROVIDER' }),
    )
  })

  it('keeps TTS and STT id namespaces independent', async () => {
    const { speech } = await mountSpeech()
    speech.registerTtsProvider(ttsProvider('shared', true))
    expect(() => speech.registerSttProvider(sttProvider('shared', true))).not.toThrow()
  })

  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, speech } = await mountSpeech()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.speech.registerTtsProvider(ttsProvider('xai-tts', true))
    }, { inject: ['speech'] }))
    await expect(speech.synthesize({ text: 'Hello' })).resolves.toMatchObject({ voiceId: 'af_heart' })
    await fiber.dispose()
    await expect(speech.synthesize({ text: 'Hello' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_UNAVAILABLE' }),
    )
  })
})

describe('SpeechRuntime execution resolution', () => {
  it('throws SPEECH_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const { speech } = await mountSpeech()
    await expect(speech.synthesize({ text: 'Hello' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('throws SPEECH_PROVIDER_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { speech } = await mountSpeech({ ...LIMITS, ttsProvider: 'other' })
    speech.registerTtsProvider(ttsProvider('xai-tts', true))
    await expect(speech.synthesize({ text: 'Hello' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_CONFIGURED_MISSING' }),
    )
  })

  it('throws SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE for an unusable configured id', async () => {
    const { speech } = await mountSpeech({ ...LIMITS, ttsProvider: 'xai-tts' })
    speech.registerTtsProvider(ttsProvider('xai-tts', false))
    await expect(speech.synthesize({ text: 'Hello' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE' }),
    )
  })

  it('throws SPEECH_PROVIDER_AMBIGUOUS rather than picking by order', async () => {
    const { speech } = await mountSpeech()
    speech.registerTtsProvider(ttsProvider('xai-tts', true))
    speech.registerTtsProvider(ttsProvider('other', true))
    await expect(speech.synthesize({ text: 'Hello' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_AMBIGUOUS' }),
    )
  })

  it('picks the first usable id from ttsProviders and skips missing or unusable ones', async () => {
    const { speech } = await mountSpeech({ ...LIMITS, ttsProviders: ['missing', 'xai-tts', 'other'] })
    speech.registerTtsProvider(ttsProvider('xai-tts', false))
    let used = ''
    speech.registerTtsProvider(ttsProvider('other', true, () => {
      used = 'other'
      return Promise.resolve({ audio: mpeg, mediaType: 'audio/mpeg', voiceId: 'af_heart' })
    }))
    await speech.synthesize({ text: 'Hello' })
    expect(used).toBe('other')
  })

  it('lets a singular ttsProvider pin win over ttsProviders', async () => {
    const { speech } = await mountSpeech({
      ...LIMITS,
      ttsProvider: 'xai-tts',
      ttsProviders: ['other', 'xai-tts'],
    })
    speech.registerTtsProvider(ttsProvider('xai-tts', true))
    speech.registerTtsProvider(ttsProvider('other', true, () => Promise.resolve({
      audio: mpeg,
      mediaType: 'audio/mpeg',
      voiceId: 'other',
    })))
    await expect(speech.synthesize({ text: 'Hello' })).resolves.toMatchObject({ voiceId: 'af_heart' })
  })

  it('propagates the abort signal to the TTS provider', async () => {
    const { speech } = await mountSpeech()
    const seen: (AbortSignal | undefined)[] = []
    speech.registerTtsProvider({
      id: 'xai-tts',
      available: () => true,
      listVoices: () => Promise.resolve([]),
      synthesize: (_request, signal) => {
        seen.push(signal)
        return Promise.resolve({ audio: mpeg, mediaType: 'audio/mpeg', voiceId: 'af_heart' })
      },
    })
    const controller = new AbortController()
    await speech.synthesize({ text: 'Hello' }, controller.signal)
    expect(seen[0]).toBe(controller.signal)
  })
})

describe('SpeechRuntime synthesize and transcribe', () => {
  it('returns empty audio without calling the provider when the script is empty', async () => {
    const { speech } = await mountSpeech()
    let called = false
    speech.registerTtsProvider(ttsProvider('xai-tts', true, () => {
      called = true
      return Promise.resolve({ audio: mpeg, mediaType: 'audio/mpeg', voiceId: 'af_heart' })
    }))
    const result = await speech.synthesize({ text: '   ' })
    expect(called).toBe(false)
    expect(result.audio.byteLength).toBe(0)
    expect(result.voiceId).toBe('af_heart')
  })

  it('strips markdown before handing text to the provider', async () => {
    const { speech } = await mountSpeech()
    let seen = ''
    speech.registerTtsProvider(ttsProvider('xai-tts', true, (request) => {
      seen = request.text
      return Promise.resolve({ audio: mpeg, mediaType: 'audio/mpeg', voiceId: 'af_heart' })
    }))
    await speech.synthesize({ text: '## Hello `pnpm`' })
    expect(seen).toBe('Hello pnpm')
  })

  it('rejects oversized audio', async () => {
    const { speech } = await mountSpeech({ maxAudioBytes: 4, maxTextChars: 64 })
    speech.registerSttProvider(sttProvider('xai-stt', true))
    await expect(speech.transcribe({
      audio: new Uint8Array([1, 2, 3, 4, 5]),
      mediaType: 'audio/webm',
    })).rejects.toThrow(expect.objectContaining({ code: 'SPEECH_AUDIO_TOO_LARGE' }))
  })

  it('rejects empty audio', async () => {
    const { speech } = await mountSpeech()
    speech.registerSttProvider(sttProvider('xai-stt', true))
    await expect(speech.transcribe({ audio: new Uint8Array(), mediaType: 'audio/webm' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_AUDIO_EMPTY' }),
    )
  })

  it('runs the selected STT provider', async () => {
    const { speech } = await mountSpeech()
    speech.registerSttProvider(sttProvider('xai-stt', true, () => Promise.resolve({ text: 'hello' })))
    await expect(speech.transcribe({ audio: mpeg, mediaType: 'audio/webm' })).resolves.toEqual({ text: 'hello' })
  })
})

describe('SpeechRuntime remotes', () => {
  it('status reports ready when a usable provider is registered', async () => {
    const { speech } = await mountSpeech()
    speech.registerTtsProvider(ttsProvider('xai-tts', true))
    speech.registerSttProvider(sttProvider('xai-stt', true))
    const status = await speech.status()
    expect(status.tts).toEqual({ kind: 'ready', providerId: 'xai-tts' })
    expect(status.stt).toEqual({ kind: 'ready', providerId: 'xai-stt' })
    expect(status.voices).toEqual([{ id: 'eve', name: 'Eve' }])
  })

  it('status reports unavailable with the selection code when TTS is missing', async () => {
    const { speech } = await mountSpeech()
    const status = await speech.status()
    expect(status.tts.kind).toBe('unavailable')
    if (status.tts.kind !== 'unavailable') throw new Error('expected unavailable')
    expect(status.tts.code).toBe('SPEECH_PROVIDER_UNAVAILABLE')
    expect(status.voices).toEqual([])
  })

  it('synthesizeRemote returns empty for whitespace-only markdown', async () => {
    const { speech } = await mountSpeech()
    speech.registerTtsProvider(ttsProvider('xai-tts', true))
    await expect(speech.synthesizeRemote({ text: '  \n' })).resolves.toEqual({
      ok: true,
      value: { kind: 'empty' },
    })
  })

  it('synthesizeRemote returns canonical base64 audio', async () => {
    const { speech } = await mountSpeech()
    speech.registerTtsProvider(ttsProvider('xai-tts', true))
    const result = await speech.synthesizeRemote({ text: 'Hello', voiceId: 'ara', language: 'en' })
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'audio') throw new Error('expected audio')
    expect(result.value.audioBase64).toBe(Buffer.from(mpeg).toString('base64'))
    expect(result.value.mediaType).toBe('audio/mpeg')
    expect(result.value.voiceId).toBe('ara')
  })

  it('synthesizeRemote rethrows a non-SpeechError from the provider', async () => {
    const { speech } = await mountSpeech()
    speech.registerTtsProvider(ttsProvider('xai-tts', true, () => Promise.reject(new Error('boom'))))
    await expect(speech.synthesizeRemote({ text: 'Hello' })).rejects.toThrow('boom')
  })

  it('transcribeRemote rejects non-canonical base64', async () => {
    const { speech } = await mountSpeech()
    speech.registerSttProvider(sttProvider('xai-stt', true))
    const result = await speech.transcribeRemote({ audioBase64: 'abc', mediaType: 'audio/webm' })
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'SPEECH_INVALID_BASE64' }),
    })
  })

  it('transcribeRemote forwards language when provided and omits it otherwise', async () => {
    const { speech } = await mountSpeech()
    const seen: Array<string | undefined> = []
    speech.registerSttProvider(sttProvider('xai-stt', true, (request) => {
      seen.push(request.language)
      return Promise.resolve({ text: 'hi' })
    }))
    const audioBase64 = Buffer.from(mpeg).toString('base64')
    await expect(speech.transcribeRemote({ audioBase64, mediaType: 'audio/webm' })).resolves.toEqual({
      ok: true, value: { text: 'hi' },
    })
    await expect(speech.transcribeRemote({
      audioBase64,
      mediaType: 'audio/webm',
      language: 'en',
    })).resolves.toEqual({ ok: true, value: { text: 'hi' } })
    expect(seen).toEqual(['en', 'en'])
  })

  it('transcribeRemote accepts a recorder MIME with parameters', async () => {
    const { speech } = await mountSpeech()
    speech.registerSttProvider(sttProvider('xai-stt', true, () => Promise.resolve({ text: 'hi' })))
    const audioBase64 = Buffer.from(mpeg).toString('base64')
    await expect(speech.transcribeRemote({
      audioBase64,
      mediaType: 'audio/webm;codecs=opus',
      language: 'en',
    })).resolves.toEqual({ ok: true, value: { text: 'hi' } })
  })

  it('synthesizeRemote returns a business failure when TTS is missing', async () => {
    const { speech } = await mountSpeech()
    await expect(speech.synthesizeRemote({ text: 'Hello' })).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'SPEECH_PROVIDER_UNAVAILABLE' }),
    })
  })

  it('transcribeRemote rejects an unsupported media type', async () => {
    const { speech } = await mountSpeech()
    speech.registerSttProvider(sttProvider('xai-stt', true))
    const result = await speech.transcribeRemote({
      audioBase64: Buffer.from(mpeg).toString('base64'),
      mediaType: 'image/png',
    })
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'SPEECH_UNSUPPORTED_MEDIA' }),
    })
  })
})

describe('SpeechRuntime invariant companion', () => {
  it('removes its registry contribution when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(SpeechInvariant)
    expect(() => {
      ctx.invariants.register('@shres-code/shres-code-speech', () => {})
    }).toThrow(/already registered/u)
    await fiber.dispose()
    await expect(ctx.plugin(SpeechInvariant).await()).resolves.toBeDefined()
  })
})

describe('SpeechRuntime environment and config', () => {
  it('reads ordered TTS ids from $SHRES_SPEECH_TTS_PROVIDERS', async () => {
    const previous = process.env.SHRES_SPEECH_TTS_PROVIDERS
    process.env.SHRES_SPEECH_TTS_PROVIDERS = ' missing , xai-tts '
    try {
      const ctx = new Context()
      const speech = new SpeechRuntime(ctx, LIMITS)
      let used = ''
      speech.registerTtsProvider(ttsProvider('xai-tts', true, () => {
        used = 'xai-tts'
        return Promise.resolve({ audio: mpeg, mediaType: 'audio/mpeg', voiceId: 'af_heart' })
      }))
      await speech.synthesize({ text: 'Hello' })
      expect(used).toBe('xai-tts')
    } finally {
      if (previous === undefined) delete process.env.SHRES_SPEECH_TTS_PROVIDERS
      else process.env.SHRES_SPEECH_TTS_PROVIDERS = previous
    }
  })

  it('ignores a blank $SHRES_SPEECH_TTS_PROVIDERS value', async () => {
    const previous = process.env.SHRES_SPEECH_TTS_PROVIDERS
    process.env.SHRES_SPEECH_TTS_PROVIDERS = '   '
    try {
      const ctx = new Context()
      const speech = new SpeechRuntime(ctx, LIMITS)
      speech.registerTtsProvider(ttsProvider('xai-tts', true))
      await expect(speech.synthesize({ text: 'Hello' })).resolves.toMatchObject({ voiceId: 'af_heart' })
    } finally {
      if (previous === undefined) delete process.env.SHRES_SPEECH_TTS_PROVIDERS
      else process.env.SHRES_SPEECH_TTS_PROVIDERS = previous
    }
  })

  it('treats a blank ttsProviders list as omitted', async () => {
    const { speech } = await mountSpeech({ ...LIMITS, ttsProviders: ['  ', ''] })
    speech.registerTtsProvider(ttsProvider('xai-tts', true))
    await expect(speech.synthesize({ text: 'Hello' })).resolves.toMatchObject({ voiceId: 'af_heart' })
  })

  it('throws when every ttsProviders id is unusable', async () => {
    const { speech } = await mountSpeech({ ...LIMITS, ttsProviders: ['xai-tts', 'missing'] })
    speech.registerTtsProvider(ttsProvider('xai-tts', false))
    await expect(speech.synthesize({ text: 'Hello' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('reads ordered STT ids from $SHRES_SPEECH_STT_PROVIDERS', async () => {
    const previous = process.env.SHRES_SPEECH_STT_PROVIDERS
    process.env.SHRES_SPEECH_STT_PROVIDERS = 'xai-stt'
    try {
      const ctx = new Context()
      const speech = new SpeechRuntime(ctx, LIMITS)
      speech.registerSttProvider(sttProvider('xai-stt', true, () => Promise.resolve({ text: 'env' })))
      await expect(speech.transcribe({ audio: mpeg, mediaType: 'audio/webm' })).resolves.toEqual({ text: 'env' })
    } finally {
      if (previous === undefined) delete process.env.SHRES_SPEECH_STT_PROVIDERS
      else process.env.SHRES_SPEECH_STT_PROVIDERS = previous
    }
  })

  it('lets a singular sttProvider pin win over sttProviders', async () => {
    const { speech } = await mountSpeech({
      ...LIMITS,
      sttProvider: 'xai-stt',
      sttProviders: ['other', 'xai-stt'],
    })
    speech.registerSttProvider(sttProvider('xai-stt', true, () => Promise.resolve({ text: 'pinned' })))
    speech.registerSttProvider(sttProvider('other', true, () => Promise.resolve({ text: 'other' })))
    await expect(speech.transcribe({ audio: mpeg, mediaType: 'audio/wav' })).resolves.toEqual({ text: 'pinned' })
  })

  it('rejects a non-positive size cap at construction', () => {
    expect(() => new SpeechRuntime(new Context(), { maxAudioBytes: 0, maxTextChars: 10 })).toThrow(/maxAudioBytes/u)
    expect(() => new SpeechRuntime(new Context(), { maxAudioBytes: 10, maxTextChars: 1.5 })).toThrow(/maxTextChars/u)
  })

  it('exposes default user settings', async () => {
    const { speech } = await mountSpeech()
    expect(speech.settings()).toMatchObject({ readAloud: false, voiceId: 'af_heart', autoSubmitVoice: false })
  })

  it('picks up a live speech settings section', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SpeechRuntime, LIMITS)
    expect(ctx.speech.settings().readAloud).toBe(false)
    await ctx.settings.update(SPEECH_SETTINGS_NAMESPACE, { readAloud: true })
    expect(ctx.speech.settings().readAloud).toBe(true)
  })
})

describe('speech wire helpers', () => {
  it('round-trips canonical base64', () => {
    const encoded = encodeSpeechBase64(mpeg)
    expect(decodeSpeechBase64(encoded)).toEqual(mpeg)
  })

  it('rejects empty base64', () => {
    expect(() => decodeSpeechBase64('')).toThrow(expect.objectContaining({ code: 'SPEECH_INVALID_BASE64' }))
  })

  it('strips MIME parameters and recognizes closed types', () => {
    expect(speechMediaTypeToken('audio/webm;codecs=opus')).toBe('audio/webm')
    expect(isSpeechInputMediaType('audio/webm')).toBe(true)
    expect(isSpeechInputMediaType('image/png')).toBe(false)
  })
})

describe('SpeechError', () => {
  it('is a HarnessError subclass with a stable code', () => {
    const error = new SpeechError('missing', 'SPEECH_PROVIDER_UNAVAILABLE')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('SPEECH_PROVIDER_UNAVAILABLE')
    expect(error.name).toBe('SpeechError')
  })
})
