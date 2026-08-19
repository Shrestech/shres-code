/**
 * Register a local Whisper tiny.en STT provider on `ctx.speech`. Weights
 * load on first transcribe into the harness model cache; no API key is
 * required. The client must send PCM16 WAV (it decodes MediaRecorder output
 * with Web Audio before the Remote call).
 * @module @shres-code/shres-code-speech-whisper
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { shresHomePath } from '@shres-code/shres-code-home-paths'
import type {} from '@shres-code/shres-code-speech'
import {
  loadWhisperJs,
  WHISPER_DEFAULT_MODEL_ID,
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
  WhisperAsrResult, WhisperEngine, WhisperLoadRequest, WhisperLoader, WhisperSttOptions,
} from './provider.ts'
export { decodePcm16Wav } from './wav.ts'
export type { PcmWav } from './wav.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'speech-whisper'

/** The speech seam this provider registers into. */
export const inject = ['speech']

/** Plugin config (all optional — `apply` fills defaults). */
export interface Config {
  /** Hugging Face model id. */
  modelId?: string
  /** Cache directory for downloaded weights. */
  cacheDir?: string
  /** When false, refuse to download and require a warm cache. Defaults to true. */
  allowDownload?: boolean
  /** When false, the backend is omitted from the pool. Defaults to on. */
  enabled?: boolean
}

/** Loader-validated plugin config for local Whisper tiny.en. */
export const Config: z<Config> = z.object({
  modelId: z.string().default(WHISPER_DEFAULT_MODEL_ID),
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
  return {
    enabled: config.enabled !== false,
    allowDownload: config.allowDownload !== false,
    modelId: config.modelId ?? WHISPER_DEFAULT_MODEL_ID,
    cacheDir: config.cacheDir ?? shresHomePath('models', 'speech', 'whisper'),
    load,
  }
}

/** Register the Whisper STT provider with `ctx.speech`. */
export function apply(ctx: Context, config: Config): void {
  ctx.speech.registerSttProvider(new WhisperSttProvider(() => resolveOptions(config)))
}
