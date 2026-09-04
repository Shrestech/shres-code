import { describe, expect, it } from 'vitest'
import { credentialRef } from '@shres-code/shres-code-credentials'
import { SpeechError } from '@shres-code/shres-code-speech'
import type { SpeechCloudSettings } from '@shres-code/shres-code-speech'
import {
  OpenAiCompatibleSttProvider,
  OpenAiCompatibleTtsProvider,
  resolveSpec,
} from '../src/provider.ts'
import type { FetchFn, OpenAiCompatibleComposition } from '../src/provider.ts'

const COMPOSITION: OpenAiCompatibleComposition = {
  enabled: true,
  baseURL: 'https://openrouter.ai/api/v1',
  apiKeyRef: credentialRef('SPEECH_OPENAI_COMPATIBLE_API_KEY'),
  sttModel: 'microsoft/mai-transcribe-2',
  sttMode: 'chat-audio',
  ttsModel: 'openai/gpt-4o-audio-preview',
  ttsMode: 'chat-audio',
  ttsVoice: 'alloy',
}

const wav = new Uint8Array([1, 2, 3, 4])

/** A fake transport recording the calls it sees. */
function fetchReply(reply: (url: string, init: RequestInit) => Response): {
  fetchFn: FetchFn
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  return {
    calls,
    fetchFn: ((url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(reply(url, init))
    }) as unknown as FetchFn,
  }
}

/** The JSON body one recorded call sent; postJson always sends the string it built. */
function sentBody(call: { init: RequestInit } | undefined): Record<string, unknown> {
  const body = call?.init.body
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/** The named field of the multipart body this request carried. */
function formField(request: RequestInit, name: string): FormDataEntryValue | null {
  return (request.body as FormData).get(name)
}

describe('resolveSpec', () => {
  it('inherits every composition field when the section is absent or empty', () => {
    expect(resolveSpec(COMPOSITION, undefined)).toEqual({
      enabled: true,
      baseURL: 'https://openrouter.ai/api/v1',
      apiKeyRef: COMPOSITION.apiKeyRef,
      stt: { model: 'microsoft/mai-transcribe-2', mode: 'chat-audio' },
      tts: { model: 'openai/gpt-4o-audio-preview', mode: 'chat-audio', voice: 'alloy' },
    })
    expect(resolveSpec(COMPOSITION, {
      baseURL: '', sttModel: '', sttMode: '', ttsModel: '', ttsMode: '', ttsVoice: '', apiKeyEnv: '',
    }).stt.model).toBe('microsoft/mai-transcribe-2')
  })

  it('lets non-empty section fields win and strips a trailing slash from the base', () => {
    const spec = resolveSpec(COMPOSITION, {
      baseURL: 'https://gw.example/v1/',
      sttModel: 'custom-stt',
      sttMode: 'transcriptions',
      ttsModel: 'custom-tts',
      ttsMode: 'speech',
      ttsVoice: 'nova',
      apiKeyEnv: 'CUSTOM_KEY',
    })
    expect(spec.baseURL).toBe('https://gw.example/v1')
    expect(spec.stt).toEqual({ model: 'custom-stt', mode: 'transcriptions' })
    expect(spec.tts).toEqual({ model: 'custom-tts', mode: 'speech', voice: 'nova' })
    expect(spec.apiKeyRef).toBe('CUSTOM_KEY')
  })

  it('fails loud on a wire mode or credential reference no schema should have stored', () => {
    expect(() => resolveSpec(COMPOSITION, {
      ...emptyCloud(), sttMode: 'carrier-pigeon',
    } as unknown as SpeechCloudSettings)).toThrow(expect.objectContaining({ code: 'SPEECH_PROVIDER_CONFIG' }))
    expect(() => resolveSpec(COMPOSITION, {
      ...emptyCloud(), apiKeyEnv: '1BAD REF',
    })).toThrow(expect.objectContaining({ code: 'SPEECH_PROVIDER_CONFIG' }))
  })
})

describe('OpenAiCompatibleSttProvider', () => {
  it('is usable exactly while the composition enables it, and refuses calls when not', async () => {
    const disabledSpec = (): ReturnType<typeof resolveSpec> => ({ ...resolveSpec(COMPOSITION, undefined), enabled: false })
    const stt = new OpenAiCompatibleSttProvider({
      spec: disabledSpec,
      resolveKey: () => Promise.resolve(undefined),
    })
    expect(stt.available()).toBe(false)
    await expect(stt.transcribe({ audio: wav, mediaType: 'audio/wav' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_UNAVAILABLE' }),
    )
    const tts = new OpenAiCompatibleTtsProvider({
      spec: disabledSpec,
      resolveKey: () => Promise.resolve(undefined),
    })
    expect(tts.available()).toBe(false)
    await expect(tts.synthesize({ text: 'Hello' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('sends an input_audio chat part in chat-audio mode and trims the transcript', async () => {
    const { fetchFn, calls } = fetchReply(() => jsonResponse({
      choices: [{ message: { content: '  hello there ' } }],
    }))
    const provider = new OpenAiCompatibleSttProvider({
      spec: () => resolveSpec(COMPOSITION, undefined),
      resolveKey: () => Promise.resolve('k-1'),
      fetchFn,
    })
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/wav' })).resolves.toEqual({ text: 'hello there' })
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> }
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers.authorization).toBe('Bearer k-1')
    const body = sentBody(calls[0]) as {
      model: string
      messages: ReadonlyArray<{ content: ReadonlyArray<Record<string, unknown>> }>
    }
    expect(body.model).toBe('microsoft/mai-transcribe-2')
    const audio = body.messages[0]?.content[1]?.input_audio as { data: string; format: string }
    expect(audio).toEqual({ data: Buffer.from(wav).toString('base64'), format: 'wav' })
  })

  it('joins text parts when the reply content is an array', async () => {
    const { fetchFn } = fetchReply(() => jsonResponse({
      choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }],
    }))
    const provider = new OpenAiCompatibleSttProvider({
      spec: () => resolveSpec(COMPOSITION, undefined),
      resolveKey: () => Promise.resolve(undefined),
      fetchFn,
    })
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/webm' })).resolves.toEqual({ text: 'ab' })
  })

  it('posts multipart form data in transcriptions mode', async () => {
    const { fetchFn, calls } = fetchReply(() => jsonResponse({ text: ' from the server ' }))
    const provider = new OpenAiCompatibleSttProvider({
      spec: () => resolveSpec(COMPOSITION, { ...emptyCloud(), sttMode: 'transcriptions' }),
      resolveKey: () => Promise.resolve('k-2'),
      fetchFn,
    })
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/wav' })).resolves.toEqual({ text: 'from the server' })
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
    expect(formField(calls[0]?.init as RequestInit, 'model')).toBe('microsoft/mai-transcribe-2')
    const file = formField(calls[0]?.init as RequestInit, 'file')
    expect(file).toBeInstanceOf(Blob)
    expect((file as Blob).type).toBe('audio/wav')
  })

  it('maps refusals, unreachable endpoints, and cancellation to coded errors', async () => {
    const refused = new OpenAiCompatibleSttProvider({
      spec: () => resolveSpec(COMPOSITION, undefined),
      resolveKey: () => Promise.resolve(undefined),
      fetchFn: fetchReply(() => new Response('bad key', { status: 401 })).fetchFn,
    })
    const failure = await refused.transcribe({ audio: wav, mediaType: 'audio/wav' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SpeechError)
    expect((failure as SpeechError).code).toBe('SPEECH_PROVIDER_ERROR')
    expect((failure as SpeechError).message).toContain('401')
    // A refusal whose body cannot be read still carries the status line.
    const unreadable = new OpenAiCompatibleSttProvider({
      spec: () => resolveSpec(COMPOSITION, undefined),
      resolveKey: () => Promise.resolve(undefined),
      fetchFn: fetchReply(() => new Response(new ReadableStream<Uint8Array>({
        start(controller): void { controller.error(new Error('broken body')) },
      }), { status: 500 })).fetchFn,
    })
    const unreadableFailure = await unreadable.transcribe({ audio: wav, mediaType: 'audio/wav' }).catch((error: unknown) => error)
    expect((unreadableFailure as SpeechError).code).toBe('SPEECH_PROVIDER_ERROR')
    expect((unreadableFailure as SpeechError).message).toMatch(/answered 500/u)
    const controller = new AbortController()
    controller.abort()
    const aborted = new OpenAiCompatibleSttProvider({
      spec: () => resolveSpec(COMPOSITION, undefined),
      resolveKey: () => Promise.resolve(undefined),
      fetchFn: () => Promise.reject(new Error('gone')),
    })
    await expect(aborted.transcribe({ audio: wav, mediaType: 'audio/wav' }, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_CANCELLED' }),
    )
  })

  it('fails loud when a chat reply carries no transcript content', async () => {
    const { fetchFn } = fetchReply(() => jsonResponse({ choices: [{ message: {} }] }))
    const provider = new OpenAiCompatibleSttProvider({
      spec: () => resolveSpec(COMPOSITION, undefined),
      resolveKey: () => Promise.resolve(undefined),
      fetchFn,
    })
    const failure = await provider.transcribe({ audio: wav, mediaType: 'audio/wav' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SpeechError)
    expect((failure as SpeechError).message).toMatch(/no transcript/u)
  })

  it('reads a transcriptions reply without a text field as empty', async () => {
    const { fetchFn } = fetchReply(() => jsonResponse({}))
    const provider = new OpenAiCompatibleSttProvider({
      spec: () => resolveSpec(COMPOSITION, { ...emptyCloud(), sttMode: 'transcriptions' }),
      resolveKey: () => Promise.resolve(undefined),
      fetchFn,
    })
    await expect(provider.transcribe({ audio: wav, mediaType: 'audio/wav' })).resolves.toEqual({ text: '' })
  })
})

describe('OpenAiCompatibleTtsProvider', () => {
  it('exposes exactly the profile voice and falls back to it for foreign voice ids', async () => {
    const provider = new OpenAiCompatibleTtsProvider({
      spec: () => resolveSpec(COMPOSITION, undefined),
      resolveKey: () => Promise.resolve(undefined),
    })
    await expect(provider.listVoices()).resolves.toEqual([{ id: 'alloy', name: 'alloy' }])
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.from([1]).toString('base64') } } }] })}\n\n`
    const { fetchFn, calls } = fetchReply(() => sseResponse([frame, 'data: [DONE]\n\n']))
    const speaking = new OpenAiCompatibleTtsProvider({
      spec: () => resolveSpec(COMPOSITION, undefined),
      resolveKey: () => Promise.resolve(undefined),
      fetchFn,
    })
    const result = await speaking.synthesize({ text: 'Hi', voiceId: 'af_heart' }, undefined)
    expect(result.voiceId).toBe('alloy')
    const body = sentBody(calls[0]) as { audio: { voice: string } }
    expect(body.audio.voice).toBe('alloy')
  })

  it('collects SSE audio deltas in chat-audio mode', async () => {
    const frame = (data: string): string => `data: ${JSON.stringify({ choices: [{ delta: { audio: { data } } }] })}\n\n`
    const { fetchFn, calls } = fetchReply(() => sseResponse([
      frame(Buffer.from([1, 2]).toString('base64')),
      'data: :keepalive\n\n',
      frame(Buffer.from([3]).toString('base64')),
      'data: [DONE]\n\n',
    ]))
    const provider = new OpenAiCompatibleTtsProvider({
      spec: () => resolveSpec(COMPOSITION, undefined),
      resolveKey: () => Promise.resolve('k-3'),
      fetchFn,
    })
    const controller = new AbortController()
    const result = await provider.synthesize({ text: 'Hello' }, controller.signal)
    expect(result).toMatchObject({ mediaType: 'audio/wav', voiceId: 'alloy' })
    expect((calls[0]?.init as RequestInit).signal).toBe(controller.signal)
    expect([...result.audio]).toEqual([1, 2, 3])
    const body = sentBody(calls[0]) as {
      modalities: string[]
      audio: { voice: string; format: string }
      stream: boolean
    }
    expect(body.modalities).toEqual(['text', 'audio'])
    expect(body.audio).toEqual({ voice: 'alloy', format: 'wav' })
    expect(body.stream).toBe(true)
  })

  it('posts an /audio/speech body in speech mode and returns the raw bytes', async () => {
    const { fetchFn, calls } = fetchReply(() => new Response(new Uint8Array([7, 8]), { status: 200 }))
    const provider = new OpenAiCompatibleTtsProvider({
      spec: () => resolveSpec(COMPOSITION, { ...emptyCloud(), ttsMode: 'speech' }),
      resolveKey: () => Promise.resolve(undefined),
      fetchFn,
    })
    await expect(provider.synthesize({ text: 'Hi', voiceId: 'alloy' })).resolves.toMatchObject({
      mediaType: 'audio/wav',
      voiceId: 'alloy',
    })
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/audio/speech')
    const body = sentBody(calls[0])
    expect(body).toMatchObject({ model: 'openai/gpt-4o-audio-preview', input: 'Hi', voice: 'alloy', response_format: 'wav' })
  })

  it('fails loud when the stream carries no audio', async () => {
    const { fetchFn } = fetchReply(() => sseResponse(['data: [DONE]\n\n']))
    const provider = new OpenAiCompatibleTtsProvider({
      spec: () => resolveSpec(COMPOSITION, undefined),
      resolveKey: () => Promise.resolve(undefined),
      fetchFn,
    })
    await expect(provider.synthesize({ text: 'Hello' })).rejects.toThrow(
      expect.objectContaining({ code: 'SPEECH_PROVIDER_ERROR' }),
    )
  })
})

/** An all-inheriting section. */
function emptyCloud(): {
  baseURL: string
  sttModel: string
  sttMode: ''
  ttsModel: string
  ttsMode: ''
  ttsVoice: string
  apiKeyEnv: string
} {
  return { baseURL: '', sttModel: '', sttMode: '', ttsModel: '', ttsMode: '', ttsVoice: '', apiKeyEnv: '' }
}
