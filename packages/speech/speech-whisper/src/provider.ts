/**
 * Local Whisper tiny.en STT backend for `ctx.speech`.
 * @module @shres-code/shres-code-speech-whisper/provider
 */

import { existsSync, readdirSync } from 'node:fs'
import { SpeechError, speechMediaTypeToken } from '@shres-code/shres-code-speech'
import type {
  SpeechSttProvider,
  SpeechTranscribeRequest,
  SpeechTranscribeResult,
} from '@shres-code/shres-code-speech'
import { whisperLanguageName } from '@shres-code/shres-code-speech'
import { decodePcm16Wav, prepareWhisperSamples, stripWhisperTranscript } from './wav.ts'

/** Stable STT id this provider registers under. */
export const WHISPER_STT_PROVIDER_ID = 'whisper-tiny-en'

/** Default Hugging Face model id. */
export const WHISPER_DEFAULT_MODEL_ID = 'Xenova/whisper-tiny.en'

/** Result of one local ASR call. */
export interface WhisperAsrResult {
  readonly text?: string
}

/** Optional ASR generation kwargs. */
export interface WhisperEngineOptions {
  /** Transformers Whisper language name for the multilingual checkpoint. */
  readonly language?: string
}

/** Minimal ASR face; tests inject a fake. Transformers 3.8 takes a Float32Array, not a `{ raw }` object. */
export interface WhisperEngine {
  (audio: Float32Array, options?: WhisperEngineOptions): Promise<WhisperAsrResult>
}

/** Options for {@link WhisperLoader}. */
export interface WhisperLoadRequest {
  readonly modelId: string
  readonly cacheDir: string
  /** When false, the pipeline loads local cache files only and never downloads. */
  readonly allowDownload: boolean
}

/**
 * Load one ASR engine. Production uses {@link loadWhisperJs}; tests inject
 * a fake so CI never downloads weights.
 */
export type WhisperLoader = (request: WhisperLoadRequest, signal?: AbortSignal) => Promise<WhisperEngine>

/** Connection facts the plugin projects per call. */
export interface WhisperSttOptions {
  readonly enabled: boolean
  readonly allowDownload: boolean
  readonly modelId: string
  readonly cacheDir: string
  readonly load: WhisperLoader
  /** BCP-47 tag from speech settings; selects checkpoint and pipeline language. */
  readonly language: string
}

/* v8 ignore start -- default loader talks to Hugging Face; unit tests inject a fake engine. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SpeechError('Whisper load was cancelled', 'SPEECH_CANCELLED')
  }
}

function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  if (signal === undefined) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new SpeechError('Whisper load was cancelled', 'SPEECH_CANCELLED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        /* v8 ignore start -- engine abort rejects with Error */
        reject(error instanceof Error ? error : new Error(String(error)))
        /* v8 ignore stop */
      },
    )
  })
}

/**
 * Default loader: `@huggingface/transformers` automatic-speech-recognition.
 * When the request forbids download, the pipeline runs `local_files_only`, so
 * a cold cache fails instead of fetching.
 * @param request - model, cache, download policy.
 * @param signal - optional cancellation around the download.
 * @returns the loaded pipeline.
 */
export async function loadWhisperJs(
  request: WhisperLoadRequest,
  signal?: AbortSignal,
): Promise<WhisperEngine> {
  throwIfAborted(signal)
  try {
    const mod = await import('@huggingface/transformers') as {
      pipeline: (task: string, model: string, options: object) => Promise<WhisperEngine>
    }
    return await raceAbort(mod.pipeline('automatic-speech-recognition', request.modelId, {
      cache_dir: request.cacheDir,
      local_files_only: !request.allowDownload,
    }), signal)
  } catch (error) {
    if (error instanceof SpeechError) throw error
    throw new SpeechError('failed to load local Whisper tiny.en', 'SPEECH_PROVIDER_ERROR', { cause: error })
  }
}
/* v8 ignore stop */

/**
 * True when `cacheDir` already contains at least one file.
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

/** Local Whisper tiny.en STT provider. */
export class WhisperSttProvider implements SpeechSttProvider {
  readonly id = WHISPER_STT_PROVIDER_ID
  private engine: WhisperEngine | undefined
  private loading: Promise<WhisperEngine> | undefined
  private loadedModel: string | undefined

  /**
   * @param options - thunk returning the currently authoritative connection facts.
   */
  constructor(private readonly options: () => WhisperSttOptions) {}

  /**
   * Cheap local usability check: enabled, and either a download is allowed or
   * the cache is already warm. Must not load weights.
   * @returns whether a transcribe would be attempted.
   */
  available(): boolean {
    const options = this.options()
    return options.enabled && (options.allowDownload || cacheIsWarm(options.cacheDir))
  }

  /**
   * Transcribe PCM16 WAV audio.
   * @param request - bytes; media type must be WAV.
   * @param signal - optional cancellation around load.
   * @returns the transcript.
   */
  async transcribe(request: SpeechTranscribeRequest, signal?: AbortSignal): Promise<SpeechTranscribeResult> {
    if (!this.available()) {
      throw new SpeechError('local Whisper tiny.en is unavailable', 'SPEECH_PROVIDER_UNAVAILABLE')
    }
    const token = speechMediaTypeToken(request.mediaType)
    if (token !== 'audio/wav' && token !== 'audio/x-wav') {
      throw new SpeechError(
        'Whisper tiny.en accepts PCM16 WAV; decode the recording in the browser first',
        'SPEECH_UNSUPPORTED_MEDIA',
      )
    }
    const wav = decodePcm16Wav(request.audio)
    const samples = prepareWhisperSamples(wav.samples, wav.sampleRate)
    if (samples.length === 0) return { text: '' }
    const options = this.options()
    const engine = await this.ensureEngine(options, signal)
    let result: WhisperAsrResult
    try {
      const language = whisperLanguageName(options.language)
      result = await engine(samples, language === undefined ? undefined : { language })
    } catch (error) {
      throw new SpeechError('Whisper transcribe failed', 'SPEECH_PROVIDER_ERROR', { cause: error })
    }
    return { text: stripWhisperTranscript(result.text ?? '') }
  }

  private ensureEngine(options: WhisperSttOptions, signal?: AbortSignal): Promise<WhisperEngine> {
    if (this.engine !== undefined && this.loadedModel === options.modelId) {
      return Promise.resolve(this.engine)
    }
    if (this.loading !== undefined && this.loadedModel === options.modelId) return this.loading
    this.engine = undefined
    this.loadedModel = options.modelId
    this.loading = options.load({
      modelId: options.modelId,
      cacheDir: options.cacheDir,
      allowDownload: options.allowDownload,
    }, signal).then((engine) => {
      this.engine = engine
      this.loading = undefined
      return engine
    }, (error: unknown) => {
      this.loading = undefined
      this.loadedModel = undefined
      /* v8 ignore start -- engine loader rejects with Error */
      throw error instanceof Error ? error : new Error(String(error))
      /* v8 ignore stop */
    })
    return this.loading
  }
}
