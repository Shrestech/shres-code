/**
 * Local Kokoro-82M TTS backend for `ctx.speech`.
 * @module @shres-code/shres-code-speech-kokoro/provider
 */

import { existsSync, readdirSync } from 'node:fs'
import { SpeechError } from '@shres-code/shres-code-speech'
import type {
  SpeechSynthesizeRequest,
  SpeechSynthesizeResult,
  SpeechTtsProvider,
  SpeechVoice,
} from '@shres-code/shres-code-speech'
import { KOKORO_DEFAULT_VOICE_ID, KOKORO_VOICES } from './voices.ts'
import { encodePcm16Wav, KOKORO_SAMPLE_RATE } from './wav.ts'

/** Stable TTS id this provider registers under. */
export const KOKORO_TTS_PROVIDER_ID = 'kokoro-tts'

/** Default Hugging Face model id. */
export const KOKORO_DEFAULT_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

/** Quantization ids `kokoro-js` accepts. */
export const KOKORO_DTYPES = ['fp32', 'fp16', 'q8', 'q4', 'q4f16'] as const

/** One `kokoro-js` dtype. */
export type KokoroDtype = typeof KOKORO_DTYPES[number]

/** ONNX devices this Node provider accepts. */
export const KOKORO_DEVICES = ['cpu'] as const

/** One ONNX device id this provider will run. */
export type KokoroDevice = typeof KOKORO_DEVICES[number]

/** Audio object returned by `KokoroTTS.generate`. */
export interface KokoroAudio {
  toWav?: () => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>
  audio?: Float32Array
  sampling_rate?: number
}

/** Minimal engine face used by the provider; tests inject a fake. */
export interface KokoroEngine {
  list_voices(): unknown
  generate(text: string, options: { voice: string }): Promise<KokoroAudio>
}

/** The `@huggingface/transformers` module face whose `env` a load pins. */
export interface TransformersModule {
  env: {
    cacheDir: string
    allowRemoteModels: boolean
  }
}

/** Options for {@link KokoroLoader}. */
export interface KokoroLoadRequest {
  readonly modelId: string
  readonly dtype: KokoroDtype
  readonly device: KokoroDevice
  readonly cacheDir: string
  /** When false, the load must resolve from the local cache without downloading. */
  readonly allowDownload: boolean
  /** Transformers import; tests inject a fake so CI never loads the native runtime. */
  readonly importTransformers?: () => Promise<TransformersModule>
}

/**
 * Load one Kokoro engine. Production uses {@link loadKokoroJs}; tests inject
 * a fake so CI never downloads weights.
 */
export type KokoroLoader = (request: KokoroLoadRequest, signal?: AbortSignal) => Promise<KokoroEngine>

/** Connection facts the plugin projects per call. */
export interface KokoroTtsOptions {
  readonly enabled: boolean
  readonly allowDownload: boolean
  readonly modelId: string
  readonly dtype: KokoroDtype
  readonly device: KokoroDevice
  readonly cacheDir: string
  readonly load: KokoroLoader
}

/* v8 ignore start -- default loader talks to Hugging Face; unit tests inject a fake engine. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SpeechError('Kokoro load was cancelled', 'SPEECH_CANCELLED')
  }
}

function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  if (signal === undefined) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new SpeechError('Kokoro load was cancelled', 'SPEECH_CANCELLED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function importTransformers(): Promise<TransformersModule> {
  return await import('@huggingface/transformers')
}

let envLock: Promise<void> = Promise.resolve()

async function withTransformersEnv<T>(
  importModule: () => Promise<TransformersModule>,
  cacheDir: string,
  allowDownload: boolean,
  work: () => Promise<T>,
): Promise<T> {
  const previousLock = envLock
  let release!: () => void
  envLock = new Promise((resolve) => { release = resolve })
  await previousLock
  try {
    const transformers = await importModule()
    const previousDir = transformers.env.cacheDir
    const previousAllowRemote = transformers.env.allowRemoteModels
    transformers.env.cacheDir = cacheDir
    if (!allowDownload) transformers.env.allowRemoteModels = false
    try {
      return await work()
    } finally {
      transformers.env.cacheDir = previousDir
      transformers.env.allowRemoteModels = previousAllowRemote
    }
  } finally {
    release()
  }
}

/**
 * Default loader: dynamic-import `kokoro-js` and pin the transformers cache
 * directory to `cacheDir` for the duration of the load. When the request
 * forbids download, the load runs with `env.allowRemoteModels` off, so a cold
 * cache fails instead of fetching.
 * @param request - model, dtype, device, cache, download policy.
 * @param signal - optional cancellation around the download.
 * @returns the loaded engine.
 */
export async function loadKokoroJs(
  request: KokoroLoadRequest,
  signal?: AbortSignal,
): Promise<KokoroEngine> {
  throwIfAborted(signal)
  try {
    return await withTransformersEnv(
      request.importTransformers ?? importTransformers,
      request.cacheDir,
      request.allowDownload,
      async () => {
        const mod = await import('kokoro-js') as {
          KokoroTTS: { from_pretrained: (id: string, options: object) => Promise<KokoroEngine> }
        }
        return await raceAbort(mod.KokoroTTS.from_pretrained(request.modelId, {
          dtype: request.dtype,
          device: request.device,
        }), signal)
      },
    )
  } catch (error) {
    if (error instanceof SpeechError) throw error
    throw new SpeechError('failed to load local Kokoro TTS', 'SPEECH_PROVIDER_ERROR', { cause: error })
  }
}
/* v8 ignore stop */

/**
 * True when `cacheDir` already contains at least one file, so a download is
 * not required.
 * @param cacheDir - provider cache root.
 * @returns whether the directory looks warm.
 */
export function cacheIsWarm(cacheDir: string): boolean {
  if (!existsSync(cacheDir)) return false
  try {
    return readdirSync(cacheDir).length > 0
  } catch {
    // readdirSync throws when cacheDir exists but is not a readable directory.
    return false
  }
}

/** Local Kokoro TTS provider. */
export class KokoroTtsProvider implements SpeechTtsProvider {
  readonly id = KOKORO_TTS_PROVIDER_ID
  private engine: KokoroEngine | undefined
  private loading: Promise<KokoroEngine> | undefined

  /**
   * @param options - thunk returning the currently authoritative connection facts.
   */
  constructor(private readonly options: () => KokoroTtsOptions) {}

  /**
   * Cheap local usability check: enabled, and either a download is allowed or
   * the cache is already warm. Must not load weights.
   * @returns whether a synthesize would be attempted.
   */
  available(): boolean {
    const options = this.options()
    return options.enabled && (options.allowDownload || cacheIsWarm(options.cacheDir))
  }

  /**
   * Return the built-in English catalog. Does not load weights.
   * @returns the frozen roster.
   */
  listVoices(): Promise<readonly SpeechVoice[]> {
    return Promise.resolve(KOKORO_VOICES)
  }

  /**
   * Synthesize speakable text to WAV.
   * @param request - already-scriptified text plus voice.
   * @param signal - optional cancellation (checked around load).
   * @returns WAV bytes.
   */
  async synthesize(request: SpeechSynthesizeRequest, signal?: AbortSignal): Promise<SpeechSynthesizeResult> {
    if (!this.available()) {
      throw new SpeechError('local Kokoro TTS is unavailable', 'SPEECH_PROVIDER_UNAVAILABLE')
    }
    const options = this.options()
    const voiceId = request.voiceId ?? KOKORO_DEFAULT_VOICE_ID
    const engine = await this.ensureEngine(options, signal)
    let generated: KokoroAudio
    try {
      generated = await engine.generate(request.text, { voice: voiceId })
    } catch (error) {
      throw new SpeechError('Kokoro TTS generate failed', 'SPEECH_PROVIDER_ERROR', { cause: error })
    }
    const audio = await audioToWav(generated)
    return { audio, mediaType: 'audio/wav', voiceId }
  }

  private ensureEngine(options: KokoroTtsOptions, signal?: AbortSignal): Promise<KokoroEngine> {
    if (this.engine !== undefined) return Promise.resolve(this.engine)
    if (this.loading !== undefined) return this.loading
    this.loading = options.load({
      modelId: options.modelId,
      dtype: options.dtype,
      device: options.device,
      cacheDir: options.cacheDir,
      allowDownload: options.allowDownload,
    }, signal).then((engine) => {
      this.engine = engine
      this.loading = undefined
      return engine
    }, (error) => {
      this.loading = undefined
      throw error
    })
    return this.loading
  }
}

/**
 * Prefer `toWav()` when the engine provides it; otherwise encode Float32 PCM.
 * @param audio - generate() result.
 * @returns WAV bytes.
 */
export async function audioToWav(audio: KokoroAudio): Promise<Uint8Array> {
  if (audio.toWav !== undefined) {
    const wav = await audio.toWav()
    return wav instanceof Uint8Array ? wav : new Uint8Array(wav)
  }
  if (audio.audio !== undefined) {
    return encodePcm16Wav(audio.audio, audio.sampling_rate ?? KOKORO_SAMPLE_RATE)
  }
  throw new SpeechError('Kokoro generate returned no audio', 'SPEECH_PROVIDER_ERROR')
}
