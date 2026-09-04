/**
 * OpenAI-compatible cloud speech backend for `ctx.speech`: OpenRouter-style
 * `chat/completions` audio parts by default, with the plain `/audio`
 * endpoints as an alternate wire mode for OpenAI-shaped servers.
 * @module @shres-code/shres-code-speech-openai-compatible/provider
 */

import {
  SpeechError,
  speechMediaTypeToken,
} from '@shres-code/shres-code-speech'
import { encodeSpeechBase64 } from '@shres-code/shres-code-speech'
import type {
  SpeechSttProvider,
  SpeechSynthesizeRequest,
  SpeechSynthesizeResult,
  SpeechTranscribeRequest,
  SpeechTranscribeResult,
  SpeechTtsProvider,
} from '@shres-code/shres-code-speech'
import type { SpeechCloudSettings } from '@shres-code/shres-code-speech'
import { credentialRef } from '@shres-code/shres-code-credentials'
import type { CredentialRef } from '@shres-code/shres-code-credentials'

/** Stable STT id this provider registers under. */
export const OPENAI_COMPATIBLE_STT_PROVIDER_ID = 'openai-compatible-stt'

/** Stable TTS id this provider registers under. */
export const OPENAI_COMPATIBLE_TTS_PROVIDER_ID = 'openai-compatible-tts'

/** Speech-to-text wire modes this provider speaks. */
export const STT_WIRE_MODES = ['chat-audio', 'transcriptions'] as const

/** One speech-to-text wire mode. */
export type SttWireMode = typeof STT_WIRE_MODES[number]

/** Text-to-speech wire modes this provider speaks. */
export const TTS_WIRE_MODES = ['chat-audio', 'speech'] as const

/** One text-to-speech wire mode. */
export type TtsWireMode = typeof TTS_WIRE_MODES[number]

/** The fully resolved connection facts one call runs against. */
export interface OpenAiCompatibleSpec {
  /** Whether the providers participate at all. */
  readonly enabled: boolean
  /** Endpoint base, without a trailing slash. */
  readonly baseURL: string
  /** Credential reference holding the bearer key. */
  readonly apiKeyRef: CredentialRef
  readonly stt: {
    readonly model: string
    readonly mode: SttWireMode
  }
  readonly tts: {
    readonly model: string
    readonly mode: TtsWireMode
    readonly voice: string
  }
}

/** Composition-layer defaults, already schema-resolved; {@link resolveSpec} layers the section over it. */
export interface OpenAiCompatibleComposition {
  readonly enabled: boolean
  readonly baseURL: string
  readonly apiKeyRef: CredentialRef
  readonly sttModel: string
  readonly sttMode: SttWireMode
  readonly ttsModel: string
  readonly ttsMode: TtsWireMode
  readonly ttsVoice: string
}

/** Fetch face; tests inject a fake so CI never reaches the network. */
export type FetchFn = typeof fetch

/**
 * Layer the user-section cloud profile over the composition defaults: a
 * non-empty section field wins, an empty (or absent) one inherits. The
 * credential reference is re-validated here because the section is
 * runtime-editable while the composition was validated at load.
 * @param composition - schema-resolved plugin config.
 * @param cloud - the speech settings section's `cloud` profile, when present.
 * @returns the connection facts one call runs against.
 */
export function resolveSpec(
  composition: OpenAiCompatibleComposition,
  cloud: SpeechCloudSettings | undefined,
): OpenAiCompatibleSpec {
  const pick = (override: string | undefined, base: string): string =>
    override !== undefined && override.length > 0 ? override : base
  return {
    enabled: composition.enabled,
    baseURL: pick(cloud?.baseURL, composition.baseURL).replace(/\/+$/, ''),
    apiKeyRef: sectionKeyRef(pick(cloud?.apiKeyEnv, composition.apiKeyRef)),
    stt: { model: pick(cloud?.sttModel, composition.sttModel), mode: wireMode(pick(cloud?.sttMode, composition.sttMode), STT_WIRE_MODES) },
    tts: {
      model: pick(cloud?.ttsModel, composition.ttsModel),
      mode: wireMode(pick(cloud?.ttsMode, composition.ttsMode), TTS_WIRE_MODES),
      voice: pick(cloud?.ttsVoice, composition.ttsVoice),
    },
  }
}

/** Validate a section-supplied reference, failing loud in the section's vocabulary. */
function sectionKeyRef(value: string): CredentialRef {
  try {
    return credentialRef(value)
  } catch (error) {
    throw new SpeechError(
      `cloud speech apiKeyEnv "${value}" is not a valid credential reference`,
      'SPEECH_PROVIDER_CONFIG',
      { cause: error },
    )
  }
}

/** Narrow one wire mode, failing loud on a value no schema should have stored. */
function wireMode<M extends string>(value: string, modes: readonly M[]): M {
  if ((modes as readonly string[]).includes(value)) return value as M
  throw new SpeechError(
    `cloud speech wire mode "${value}" is not one of ${modes.join(', ')}`,
    'SPEECH_PROVIDER_CONFIG',
  )
}

/* v8 ignore start -- request helpers run only against a live endpoint; tests inject replies. */

/**
 * The bearer header for one call, or nothing when no key resolves — a
 * keyless endpoint (a LAN Whisper server) authenticates by having none.
 */
function authHeaders(key: string | undefined): Record<string, string> {
  return key === undefined ? {} : { authorization: `Bearer ${key}` }
}

/** Map a closed input media token onto an `input_audio` format name. */
function audioFormat(mediaType: string): string {
  const token = speechMediaTypeToken(mediaType).replace(/^audio\//u, '')
  if (token === 'x-wav') return 'wav'
  if (token === 'mpeg') return 'mp3'
  return token
}

/** Options shared by the request helpers. */
interface CallOptions {
  readonly baseURL: string
  readonly key: string | undefined
  readonly fetchFn: FetchFn
  readonly signal?: AbortSignal
}

/** Send one request, converting transport failures and refusals into coded speech errors. */
async function send(options: CallOptions, path: string, init: RequestInit): Promise<Response> {
  const url = `${options.baseURL}${path}`
  let response: Response
  try {
    response = await options.fetchFn(url, {
      ...init,
      // `HeadersInit` may be an array of entries; this call site only ever
      // builds plain records, and the bearer header rides on top.
      headers: { ...(init.headers as Record<string, string>), ...authHeaders(options.key) },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
  } catch (error: unknown) {
    if (options.signal?.aborted) {
      throw new SpeechError('cloud speech request was cancelled', 'SPEECH_CANCELLED', { cause: error })
    }
    throw new SpeechError(`could not reach ${url}`, 'SPEECH_PROVIDER_ERROR', { cause: error })
  }
  if (!response.ok) {
    throw new SpeechError(
      `${url} answered ${String(response.status)}${await errorExcerpt(response)}`,
      'SPEECH_PROVIDER_ERROR',
    )
  }
  return response
}

/** POST a JSON body. */
function postJson(options: CallOptions, path: string, body: unknown): Promise<Response> {
  return send(options, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * The first `limit` bytes of an error body, for the failure message.
 * @param response - the refused reply.
 * @param limit - byte ceiling.
 * @returns a trimmed excerpt, or the empty string.
 */
async function errorExcerpt(response: Response, limit = 512): Promise<string> {
  try {
    const text = await response.text()
    return text.length > 0 ? `: ${text.slice(0, limit).trim()}` : ''
  } catch {
    // A body that cannot be read adds nothing to the status the message already carries.
    return ''
  }
}

/**
 * Read an SSE stream and collect the base64 audio deltas a `modalities:
 * ["text","audio"]` completion emits.
 * @param response - the streaming reply.
 * @returns the concatenated audio bytes.
 */
async function collectStreamAudio(response: Response): Promise<Uint8Array> {
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the guard is defensive. */
  if (response.body === null) {
    throw new SpeechError('cloud TTS stream carried no body', 'SPEECH_PROVIDER_ERROR')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return concat(chunks)
        const audio = streamChunkAudio(payload)
        if (audio !== undefined) chunks.push(audio)
      }
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a drained stream settles without rejecting; best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cleanup after the stream already ended or this function walked away.
    })
  }
  return concat(chunks)
}

/** The base64 audio delta of one SSE data payload, when the chunk carries one. */
function streamChunkAudio(payload: string): Uint8Array | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    // A keep-alive comment or partial frame carries no audio; the next frame re-syncs on its newline.
    return undefined
  }
  const data = (parsed as { choices?: ReadonlyArray<{ delta?: { audio?: { data?: unknown } } }> } | null)
    ?.choices?.[0]?.delta?.audio?.data
  return typeof data === 'string' && data.length > 0
    ? new Uint8Array(Buffer.from(data, 'base64'))
    : undefined
}

/** Concatenate collected byte chunks. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** The transcript of a `chat/completions` reply, string or content-part array. */
async function chatTranscript(response: Response): Promise<string> {
  const body = await response.json() as { choices?: ReadonlyArray<{ message?: { content?: unknown } }> }
  const content = body.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map(part => (part as { type?: unknown; text?: unknown }).type === 'text' ? String((part as { text?: unknown }).text) : '')
      .join('')
      .trim()
  }
  throw new SpeechError('cloud STT reply carried no transcript', 'SPEECH_PROVIDER_ERROR')
}

/** The transcript of an `/audio/transcriptions` reply. */
async function transcriptionText(response: Response): Promise<string> {
  const body = await response.json() as { text?: unknown }
  return typeof body.text === 'string' ? body.text.trim() : ''
}

/* v8 ignore stop */

/**
 * Local Kokoro vocabulary must never reach a cloud endpoint: the profile
 * serves exactly its configured voice, so a request naming another catalog's
 * voice (the local default `af_heart`) falls back to the profile voice.
 */
function cloudVoice(requested: string | undefined, spec: OpenAiCompatibleSpec): string {
  return requested === spec.tts.voice && requested !== '' ? requested : spec.tts.voice
}

/** The shared usability answer: both providers run exactly while composition enables them. */
function compositionEnabled(spec: () => OpenAiCompatibleSpec): boolean {
  return spec().enabled
}

/** Shared provider plumbing: per-call facts plus the injected transport. */
export interface OpenAiCompatibleProviderOptions {
  /** Resolve the connection facts for THIS call; re-read on every operation. */
  readonly spec: () => OpenAiCompatibleSpec
  /** Resolve the current bearer key; `undefined` sends no header. */
  readonly resolveKey: () => Promise<string | undefined>
  /** Transport; tests inject a fake. */
  readonly fetchFn?: FetchFn
}

/** Provider state shared by both directions. */
export abstract class OpenAiCompatibleBase {
  /** Resolve the connection facts for THIS call; re-read on every operation. */
  protected readonly spec: () => OpenAiCompatibleSpec
  /** Resolve the current bearer key; `undefined` sends no header. */
  protected readonly resolveKey: () => Promise<string | undefined>
  /** Transport; tests inject a fake. */
  protected readonly fetchFn: FetchFn

  /**
   * @param options - per-call facts and the transport.
   */
  constructor(options: OpenAiCompatibleProviderOptions) {
    this.spec = options.spec
    this.resolveKey = options.resolveKey
    this.fetchFn = options.fetchFn ?? fetch
  }
}

/** Cloud STT provider speaking an OpenAI-compatible endpoint. */
export class OpenAiCompatibleSttProvider extends OpenAiCompatibleBase implements SpeechSttProvider {
  readonly id = OPENAI_COMPATIBLE_STT_PROVIDER_ID

  /**
   * Cheap local usability check: composition enabled. Key state and endpoint
   * health are not probed — a pinned endpoint without a key fails at request
   * time with the endpoint's own refusal.
   * @returns whether a transcribe would be attempted.
   */
  available(): boolean {
    return compositionEnabled(this.spec)
  }

  /**
   * Transcribe recorded audio through the endpoint.
   * @param request - bytes and a closed media type.
   * @param signal - optional cancellation.
   * @returns the transcript.
   */
  async transcribe(request: SpeechTranscribeRequest, signal?: AbortSignal): Promise<SpeechTranscribeResult> {
    const spec = this.spec()
    if (!spec.enabled) {
      throw new SpeechError('the cloud speech provider is disabled', 'SPEECH_PROVIDER_UNAVAILABLE')
    }
    const options: CallOptions = {
      baseURL: spec.baseURL,
      key: await this.resolveKey(),
      fetchFn: this.fetchFn,
      ...signal === undefined ? {} : { signal },
    }
    if (spec.stt.mode === 'transcriptions') {
      const form = new FormData()
      // A `Uint8Array` view may claim an `ArrayBufferLike` backer the DOM
      // `BlobPart` cannot spell; the bytes themselves are a plain body.
      form.append('file', new Blob([request.audio as unknown as BlobPart], { type: speechMediaTypeToken(request.mediaType) }), 'audio')
      form.append('model', spec.stt.model)
      return { text: await transcriptionText(await send(options, '/audio/transcriptions', { method: 'POST', body: form })) }
    }
    return {
      text: await chatTranscript(await postJson(options, '/chat/completions', {
        model: spec.stt.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe this audio.' },
            {
              type: 'input_audio',
              input_audio: { data: encodeSpeechBase64(request.audio), format: audioFormat(request.mediaType) },
            },
          ],
        }],
      })),
    }
  }
}

/** TTS provider speaking an OpenAI-compatible endpoint. */
export class OpenAiCompatibleTtsProvider extends OpenAiCompatibleBase implements SpeechTtsProvider {
  readonly id = OPENAI_COMPATIBLE_TTS_PROVIDER_ID

  /**
   * Cheap local usability check: composition enabled.
   * @returns whether a synthesize would be attempted.
   */
  available(): boolean {
    return compositionEnabled(this.spec)
  }

  /**
   * The profile's single voice. Cloud models name their own voices, so the
   * catalog is the configured `ttsVoice`, not a fixed roster.
   * @returns the single-voice roster.
   */
  listVoices(): Promise<readonly { id: string; name: string }[]> {
    const voice = this.spec().tts.voice
    return Promise.resolve([{ id: voice, name: voice }])
  }

  /**
   * Synthesize speakable text to WAV through the endpoint.
   * @param request - already-scriptified text plus voice.
   * @param signal - optional cancellation.
   * @returns WAV bytes.
   */
  async synthesize(request: SpeechSynthesizeRequest, signal?: AbortSignal): Promise<SpeechSynthesizeResult> {
    const spec = this.spec()
    if (!spec.enabled) {
      throw new SpeechError('the cloud speech provider is disabled', 'SPEECH_PROVIDER_UNAVAILABLE')
    }
    const voice = cloudVoice(request.voiceId, spec)
    const options: CallOptions = {
      baseURL: spec.baseURL,
      key: await this.resolveKey(),
      fetchFn: this.fetchFn,
      ...signal === undefined ? {} : { signal },
    }
    if (spec.tts.mode === 'speech') {
      const response = await postJson(options, '/audio/speech', {
        model: spec.tts.model,
        input: request.text,
        voice,
        response_format: 'wav',
      })
      return { audio: new Uint8Array(await response.arrayBuffer()), mediaType: 'audio/wav', voiceId: voice }
    }
    const response = await postJson(options, '/chat/completions', {
      model: spec.tts.model,
      modalities: ['text', 'audio'],
      audio: { voice, format: 'wav' },
      stream: true,
      messages: [{ role: 'user', content: request.text }],
    })
    const audio = await collectStreamAudio(response)
    // An empty script never reaches a provider, so silence here is the
    // endpoint's failure, not an empty result.
    if (audio.byteLength === 0) {
      throw new SpeechError('cloud TTS returned no audio', 'SPEECH_PROVIDER_ERROR')
    }
    return { audio, mediaType: 'audio/wav', voiceId: voice }
  }
}
