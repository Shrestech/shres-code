/**
 * Register a local Whisper STT provider on `ctx.speech`. English uses tiny.en;
 * other languages use multilingual tiny. Weights load on first transcribe
 * into the harness model cache; no API key is required. The client must send
 * PCM16 WAV (it decodes MediaRecorder output with Web Audio before the Remote
 * call).
 * @module @shres-code/shres-code-speech-whisper
 */

import { join } from 'node:path'
import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { shresHomePath } from '@shres-code/shres-code-home-paths'
import { modelForLanguage } from '@shres-code/shres-code-speech'
import type {} from '@shres-code/shres-code-speech'
import {
  loadWhisperJs,
  WhisperSttProvider,
} from './provider.ts'
import type { WhisperLoader, WhisperSttOptions } from './provider.ts'

export {
  cacheIsWarm,
  loadWhisperJs,
  WHISPER_DEFAULT_MODEL_ID,
  WHISPER_STT_PROVIDER_ID,
  WhisperSttProvider,
} from './provider.ts'
export type {
  WhisperAsrResult, WhisperEngine, WhisperEngineOptions, WhisperLoadRequest, WhisperLoader, WhisperSttOptions,
} from './provider.ts'
export {
  decodePcm16Wav,
  peakAmplitude,
  prepareWhisperSamples,
  resampleLinear,
  stripWhisperTranscript,
  WHISPER_MIN_SAMPLES,
  WHISPER_SAMPLE_RATE,
  WHISPER_SILENCE_PEAK,
  WHISPER_TARGET_PEAK,
} from './wav.ts'
export type { PcmWav } from './wav.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'speech-whisper'

/** The speech seam this provider registers into. */
export const inject = ['speech']

/** Plugin config (all optional — `apply` fills defaults). */
export interface Config {
  /** Hugging Face model id. When omitted, English uses tiny.en and others use multilingual tiny. */
  modelId?: string
  /** Cache directory for downloaded weights. */
  cacheDir?: string
  /** When false, refuse to download and require a warm cache. Defaults to true. */
  allowDownload?: boolean
  /** When false, the backend is omitted from the pool. Defaults to on. */
  enabled?: boolean
  /** BCP-47 tag; filled from speech settings at apply time. */
  language?: string
}

/** Loader-validated plugin config for local Whisper. */
export const Config: z<Config> = z.object({
  modelId: z.string(),
  cacheDir: z.string(),
  allowDownload: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

/**
 * Fill Whisper connection facts from plugin config.
 * @param config - plugin config.
 * @param load - optional test loader.
 * @returns provider options.
 */
export function resolveOptions(config: Config, load: WhisperLoader = loadWhisperJs): WhisperSttOptions {
  const language = config.language ?? 'en'
  const modelId = config.modelId ?? modelForLanguage(language)
  return {
    enabled: config.enabled !== false,
    allowDownload: config.allowDownload !== false,
    modelId,
    language,
    cacheDir: config.cacheDir ?? join(shresHomePath('models', 'speech', 'whisper'), modelId.replaceAll('/', '__')),
    load,
  }
}

/** Register the Whisper STT provider with `ctx.speech`. */
export function apply(ctx: Context, config: Config): void {
  ctx.speech.registerSttProvider(new WhisperSttProvider(() => {
    const language = ctx.speech.settings().language
    return resolveOptions(Object.assign({}, config, { language }))
  }))
}
