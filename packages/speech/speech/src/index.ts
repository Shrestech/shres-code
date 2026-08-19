/**
 * Service Definition for the speech I/O capability seam (`ctx.speech`):
 * registries and provider-selecting execution for synthesize and transcribe.
 * Duplicate ids are rejected. At execution time, a configured provider must
 * exist and be usable; without one, exactly one usable provider is required,
 * so selection never depends on registration order.
 * @module @shres-code/shres-code-speech
 */

import { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { installSettingsSection } from '@shres-code/shres-code-settings'
import { Remote, TypertRemoteService } from '@shres-code/shres-code-typert-protocol'
import { toSpeechScript } from './script.ts'
import {
  DEFAULT_SPEECH_USER_SETTINGS,
  SPEECH_SETTINGS_NAMESPACE,
  SpeechUserSettingsSchema,
} from './settings.ts'
import type { SpeechUserSettings } from './settings.ts'
import {
  isSpeechInputMediaType,
  SpeechError,
  speechMediaTypeToken,
} from './types.ts'
import type {
  SpeechCapabilityStatus,
  SpeechInputMediaType,
  SpeechStatus,
  SpeechSttProvider,
  SpeechSynthesizeRequest,
  SpeechSynthesizeResult,
  SpeechSynthesizeWireRequest,
  SpeechSynthesizeWireResult,
  SpeechTranscribeRequest,
  SpeechTranscribeResult,
  SpeechTranscribeWireRequest,
  SpeechTranscribeWireResult,
  SpeechTtsProvider,
  SpeechVoice,
} from './types.ts'
import { decodeSpeechBase64, encodeSpeechBase64 } from './wire.ts'

export {
  DEFAULT_SPEECH_LANGUAGE,
  DEFAULT_SPEECH_USER_SETTINGS,
  DEFAULT_SPEECH_VOICE_ID,
  SPEECH_SETTINGS_NAMESPACE,
  SpeechUserSettingsSchema,
} from './settings.ts'
export type { SpeechUserSettings } from './settings.ts'
export { SPEECH_TRUNCATION_CLAUSE, toSpeechScript } from './script.ts'
export {
  isSpeechInputMediaType,
  SPEECH_INPUT_MEDIA_TYPES,
  SpeechError,
  speechMediaTypeToken,
} from './types.ts'
export type {
  SpeechCapabilityStatus,
  SpeechInputMediaType,
  SpeechOutputMediaType,
  SpeechStatus,
  SpeechSttProvider,
  SpeechSynthesizeAudioValue,
  SpeechSynthesizeEmptyValue,
  SpeechSynthesizeRequest,
  SpeechSynthesizeResult,
  SpeechSynthesizeWireRequest,
  SpeechSynthesizeWireResult,
  SpeechTranscribeRequest,
  SpeechTranscribeResult,
  SpeechTranscribeWireRequest,
  SpeechTranscribeWireResult,
  SpeechTtsProvider,
  SpeechVoice,
  SpeechWireFailure,
} from './types.ts'
export { decodeSpeechBase64, encodeSpeechBase64 } from './wire.ts'

declare module '@shres-code/cordis' {
  interface Context {
    speech: SpeechRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  /** Exclusive pin; when set, fallback ids are ignored. */
  readonly configuredId?: string
  /** Ordered first-usable-wins ids. Ignored when {@link configuredId} is set. */
  readonly fallbackIds?: readonly string[]
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Config for the speech seam. `ttsProvider` / `sttProvider` pin which provider
 * wins for each capability; both are optional (a single registered usable
 * provider auto-selects). `ttsProviders` / `sttProviders` are ordered
 * fallbacks used only when the singular pin is omitted. Operational overrides
 * such as environment variables must feed these same fields rather than
 * introduce a hidden priority chain. `maxAudioBytes` and `maxTextChars` are
 * required deployment limits.
 */
export interface SpeechRuntimeConfig {
  /** Inclusive recorded-audio byte cap enforced on transcribe. */
  readonly maxAudioBytes: number
  /** Inclusive speakable-script character cap enforced on synthesize. */
  readonly maxTextChars: number
  /** Exclusive TTS provider id. Wins over {@link ttsProviders}. */
  readonly ttsProvider?: string
  /** Ordered TTS ids; the first registered and `available()` provider runs. */
  readonly ttsProviders?: string[]
  /** Exclusive STT provider id. Wins over {@link sttProviders}. */
  readonly sttProvider?: string
  /** Ordered STT ids; the first registered and `available()` provider runs. */
  readonly sttProviders?: string[]
}

/**
 * The speech I/O service. Registered as `ctx.speech` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A singular configured id that is registered and `available()` → that provider.
 * - A singular configured id not registered → `SPEECH_PROVIDER_CONFIGURED_MISSING`.
 * - A singular configured id registered but unavailable →
 *   `SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - An ordered fallback list → first listed id that is registered and usable.
 * - A fallback list whose members are all missing or unusable →
 *   `SPEECH_PROVIDER_UNAVAILABLE`.
 * - No pin, exactly one registered usable provider → that provider.
 * - No pin, multiple usable providers → `SPEECH_PROVIDER_AMBIGUOUS`.
 * - No pin, no usable provider → `SPEECH_PROVIDER_UNAVAILABLE`.
 */
export class SpeechRuntime extends TypertRemoteService {
  /**
   * Provider selection and size-cap config. Operational env overrides feed the
   * SAME pin fields: `$SHRES_SPEECH_TTS_PROVIDER` / `$SHRES_SPEECH_STT_PROVIDER`
   * are equivalent to `ttsProvider` / `sttProvider` and are NOT a hidden
   * priority chain.
   */
  static Config: z<SpeechRuntimeConfig> = z.object({
    maxAudioBytes: z.number().step(1).min(1).required(),
    maxTextChars: z.number().step(1).min(1).required(),
    ttsProvider: z.string(),
    ttsProviders: z.array(z.string()),
    sttProvider: z.string(),
    sttProviders: z.array(z.string()),
  })

  private ttsProviders = new Map<string, SpeechTtsProvider>()
  private sttProviders = new Map<string, SpeechSttProvider>()
  private readonly ttsProviderId: string | undefined
  private readonly ttsProviderFallbackIds: readonly string[] | undefined
  private readonly sttProviderId: string | undefined
  private readonly sttProviderFallbackIds: readonly string[] | undefined
  private readonly maxAudioBytes: number
  private readonly maxTextChars: number
  private userSettings: () => SpeechUserSettings = () => DEFAULT_SPEECH_USER_SETTINGS

  /**
   * @param ctx - owning Cordis context.
   * @param config - required size caps and optional provider pins.
   */
  constructor(ctx: Context, config: SpeechRuntimeConfig) {
    super(ctx, 'speech')
    this.maxAudioBytes = resolvePositiveInt(config.maxAudioBytes, 'maxAudioBytes')
    this.maxTextChars = resolvePositiveInt(config.maxTextChars, 'maxTextChars')
    this.ttsProviderId = config.ttsProvider ?? process.env.SHRES_SPEECH_TTS_PROVIDER
    this.ttsProviderFallbackIds = splitProviderList(
      config.ttsProviders ?? splitEnvList(process.env.SHRES_SPEECH_TTS_PROVIDERS),
    )
    this.sttProviderId = config.sttProvider ?? process.env.SHRES_SPEECH_STT_PROVIDER
    this.sttProviderFallbackIds = splitProviderList(
      config.sttProviders ?? splitEnvList(process.env.SHRES_SPEECH_STT_PROVIDERS),
    )
    installSettingsSection(ctx, SPEECH_SETTINGS_NAMESPACE, SpeechUserSettingsSchema, DEFAULT_SPEECH_USER_SETTINGS, {
      setSource: (source) => {
        this.userSettings = source
      },
      onChange: () => {},
    })
  }

  /**
   * Current resolved user-settings section (read-aloud, voice, language).
   * @returns the live section, including schema defaults.
   */
  settings(): SpeechUserSettings {
    return this.userSettings()
  }

  /**
   * Register a TTS provider. Throws {@link SpeechError}
   * `SPEECH_DUPLICATE_PROVIDER` if its id is already registered for TTS.
   * Returns a disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerTtsProvider(provider: SpeechTtsProvider): () => void {
    return this.registerProvider(this.ttsProviders, provider)
  }

  /**
   * Register an STT provider. Throws {@link SpeechError}
   * `SPEECH_DUPLICATE_PROVIDER` if its id is already registered for STT.
   * Returns a disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerSttProvider(provider: SpeechSttProvider): () => void {
    return this.registerProvider(this.sttProviders, provider)
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new SpeechError(
        `a speech provider with id "${provider.id}" is already registered`,
        'SPEECH_DUPLICATE_PROVIDER',
      )
    }
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'speech.registerProvider()')
    return () => void dispose()
  }

  /**
   * Convert markdown to a speakable script and synthesize it through the
   * selected TTS provider. An empty script returns zero-length audio with
   * the requested (or default) voice id; callers that must skip playback
   * inspect `audio.byteLength`.
   * @param request - markdown text plus optional voice and language.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns synthesized audio (WAV from the local Kokoro provider).
   */
  async synthesize(
    request: SpeechSynthesizeRequest,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesizeResult> {
    const settings = this.userSettings()
    const script = toSpeechScript(request.text, this.maxTextChars)
    const voiceId = request.voiceId ?? settings.voiceId
    const language = request.language ?? settings.language
    if (script.text.length === 0) {
      return { audio: new Uint8Array(), mediaType: 'audio/wav', voiceId }
    }
    const provider = this.resolveTts()
    return provider.synthesize({ text: script.text, voiceId, language }, signal)
  }

  /**
   * Transcribe recorded audio through the selected STT provider.
   * @param request - bytes and a closed media type.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the transcript.
   */
  async transcribe(
    request: SpeechTranscribeRequest,
    signal?: AbortSignal,
  ): Promise<SpeechTranscribeResult> {
    if (request.audio.byteLength > this.maxAudioBytes) {
      throw new SpeechError(
        `audio is ${String(request.audio.byteLength)} bytes; max is ${String(this.maxAudioBytes)}`,
        'SPEECH_AUDIO_TOO_LARGE',
      )
    }
    if (request.audio.byteLength === 0) {
      throw new SpeechError('audio is empty', 'SPEECH_AUDIO_EMPTY')
    }
    const settings = this.userSettings()
    const language = request.language ?? settings.language
    const provider = this.resolveStt()
    return provider.transcribe({ ...request, language }, signal)
  }

  /**
   * Probe TTS and STT selection plus the TTS voice catalog, without running a
   * synthesis or transcription.
   * @returns capability status and voices (empty when TTS is unavailable).
   */
  @Remote('status')
  async status(): Promise<SpeechStatus> {
    const tts = this.capabilityStatus(() => this.resolveTts())
    const stt = this.capabilityStatus(() => this.resolveStt())
    let voices: readonly SpeechVoice[] = []
    if (tts.kind === 'ready') {
      const provider = this.ttsProviders.get(tts.providerId)
      if (provider !== undefined) voices = await provider.listVoices()
    }
    return { tts, stt, voices }
  }

  /**
   * Remote synthesize: markdown in, canonical-base64 MPEG out (or `empty`).
   * @param request - wire payload.
   * @returns a tagged business result; transport failures stay on the carrier.
   */
  @Remote('synthesize')
  async synthesizeRemote(request: SpeechSynthesizeWireRequest): Promise<SpeechSynthesizeWireResult> {
    try {
      const result = await this.synthesize({
        text: request.text,
        ...request.voiceId === undefined ? {} : { voiceId: request.voiceId },
        ...request.language === undefined ? {} : { language: request.language },
      })
      if (result.audio.byteLength === 0) return { ok: true, value: { kind: 'empty' } }
      return {
        ok: true,
        value: {
          kind: 'audio',
          audioBase64: encodeSpeechBase64(result.audio),
          mediaType: result.mediaType,
          voiceId: result.voiceId,
        },
      }
    } catch (error) {
      return wireFailure(error)
    }
  }

  /**
   * Remote transcribe: canonical-base64 audio in, transcript out.
   * @param request - wire payload.
   * @returns a tagged business result; transport failures stay on the carrier.
   */
  @Remote('transcribe')
  async transcribeRemote(request: SpeechTranscribeWireRequest): Promise<SpeechTranscribeWireResult> {
    try {
      const mediaType = resolveInputMediaType(request.mediaType)
      const audio = decodeSpeechBase64(request.audioBase64)
      const result = await this.transcribe({
        audio,
        mediaType,
        ...request.language === undefined ? {} : { language: request.language },
      })
      return { ok: true, value: result }
    } catch (error) {
      return wireFailure(error)
    }
  }

  private resolveTts(): SpeechTtsProvider {
    return resolveProvider({
      kind: 'tts',
      providers: this.ttsProviders,
      ...this.ttsProviderId !== undefined ? { configuredId: this.ttsProviderId } : {},
      ...this.ttsProviderFallbackIds !== undefined
        ? { fallbackIds: this.ttsProviderFallbackIds }
        : {},
    })
  }

  private resolveStt(): SpeechSttProvider {
    return resolveProvider({
      kind: 'stt',
      providers: this.sttProviders,
      ...this.sttProviderId !== undefined ? { configuredId: this.sttProviderId } : {},
      ...this.sttProviderFallbackIds !== undefined
        ? { fallbackIds: this.sttProviderFallbackIds }
        : {},
    })
  }

  private capabilityStatus(resolve: () => { readonly id: string }): SpeechCapabilityStatus {
    try {
      return { kind: 'ready', providerId: resolve().id }
    } catch (error) {
      /* v8 ignore next -- resolveTts and resolveStt only throw SpeechError. */
      if (!(error instanceof SpeechError)) throw error
      return { kind: 'unavailable', code: error.code, message: error.message }
    }
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** Resolve the selected provider or throw the matching {@link SpeechError}. */
function resolveProvider<P extends ResolvableProvider>(
  selection: Selection<P> & { readonly kind: 'tts' | 'stt' },
): P {
  const { configuredId, fallbackIds, providers, kind } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new SpeechError(
        `configured ${kind} provider "${configuredId}" is not registered`,
        'SPEECH_PROVIDER_CONFIGURED_MISSING',
      )
    }
    if (!provider.available()) {
      throw new SpeechError(
        `configured ${kind} provider "${configuredId}" is registered but unavailable`,
        'SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE',
      )
    }
    return provider
  }
  if (fallbackIds !== undefined) {
    for (const id of fallbackIds) {
      const provider = providers.get(id)
      if (provider !== undefined && provider.available()) return provider
    }
    throw new SpeechError(
      `no usable ${kind} provider from [${fallbackIds.join(', ')}]`,
      'SPEECH_PROVIDER_UNAVAILABLE',
    )
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new SpeechError(`no usable ${kind} provider is registered`, 'SPEECH_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new SpeechError(
      `multiple usable ${kind} providers are registered (${ids}); configure one explicitly`,
      'SPEECH_PROVIDER_AMBIGUOUS',
    )
  }
  return single
}

/**
 * Drop blank ids from a configured fallback list.
 * @param ids - raw configured or env-split ids.
 * @returns a non-empty list, or `undefined` when nothing remains.
 */
function splitProviderList(ids: readonly string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined
  const cleaned = ids.map(id => id.trim()).filter(id => id.length > 0)
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * Split `$SHRES_SPEECH_*_PROVIDERS` (comma-separated) into ids.
 * @param value - raw environment value.
 * @returns ids, or `undefined` when the variable is unset or blank.
 */
function splitEnvList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  return value.split(',')
}

/**
 * Require a positive safe integer at the configuration boundary.
 * @param value - candidate limit.
 * @param field - config field name for the error.
 * @returns the same integer.
 */
function resolvePositiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`speech: ${field} must be a positive safe integer, got ${String(value)}`)
  }
  return value
}

/**
 * Accept a recorder MIME, including parameters, against the closed input set.
 * @param raw - wire `mediaType`.
 * @returns the closed token.
 */
function resolveInputMediaType(raw: string): SpeechInputMediaType {
  const token = speechMediaTypeToken(raw)
  if (!isSpeechInputMediaType(token)) {
    throw new SpeechError(`unsupported audio media type "${raw}"`, 'SPEECH_UNSUPPORTED_MEDIA')
  }
  return token
}

/**
 * Fold a thrown {@link SpeechError} into the Remote business-failure branch.
 * @param error - caught value.
 * @returns the failure result, or rethrows non-speech errors.
 */
function wireFailure(error: unknown): { ok: false; error: { code: string; message: string } } {
  if (error instanceof SpeechError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  throw error
}

export default SpeechRuntime
