/**
 * Register a local Kokoro-82M TTS provider on `ctx.speech`. Weights load on
 * first synthesize into the harness model cache; no API key is required.
 * @module @shres-code/shres-code-speech-kokoro
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { shresHomePath } from '@shres-code/shres-code-home-paths'
import type {} from '@shres-code/shres-code-speech'
import { KOKORO_DEVICES, KOKORO_DTYPES, KokoroTtsProvider, loadKokoroJs } from './provider.ts'
import type { KokoroDevice, KokoroDtype, KokoroLoader, KokoroTtsOptions } from './provider.ts'
import { KOKORO_DEFAULT_MODEL_ID } from './provider.ts'

export {
  audioToWav,
  cacheIsWarm,
  KOKORO_DEFAULT_MODEL_ID,
  KOKORO_DEVICES,
  KOKORO_DTYPES,
  KOKORO_TTS_PROVIDER_ID,
  KokoroTtsProvider,
  loadKokoroJs,
} from './provider.ts'
export type {
  KokoroAudio, KokoroDevice, KokoroDtype, KokoroEngine, KokoroLoadRequest, KokoroLoader, KokoroTtsOptions,
} from './provider.ts'
export { encodePcm16Wav, KOKORO_SAMPLE_RATE } from './wav.ts'
export { KOKORO_DEFAULT_VOICE_ID, KOKORO_VOICES } from './voices.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'speech-kokoro'

/** The speech seam this provider registers into. */
export const inject = ['speech']

/** Plugin config (all optional — `apply` fills defaults). */
export interface Config {
  /** Hugging Face model id. */
  modelId?: string
  /** Weight quantization. Defaults to `q8`. */
  dtype?: KokoroDtype
  /** ONNX device. Defaults to `cpu`. */
  device?: KokoroDevice
  /** Cache directory for downloaded weights. */
  cacheDir?: string
  /** When false, refuse to download and require a warm cache. Defaults to true. */
  allowDownload?: boolean
  /** When false, the backend is omitted from the pool. Defaults to on. */
  enabled?: boolean
}

/** Loader-validated plugin config for local Kokoro TTS. */
export const Config: z<Config> = z.object({
  modelId: z.string().default(KOKORO_DEFAULT_MODEL_ID),
  dtype: z.union(KOKORO_DTYPES).default('q8'),
  device: z.union(KOKORO_DEVICES).default('cpu'),
  cacheDir: z.string(),
  allowDownload: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

/**
 * Fill Kokoro connection facts from plugin config.
 * @param config - plugin config.
 * @param load - optional test loader.
 * @returns provider options.
 */
export function resolveOptions(config: Config, load: KokoroLoader = loadKokoroJs): KokoroTtsOptions {
  return {
    enabled: config.enabled !== false,
    allowDownload: config.allowDownload !== false,
    modelId: config.modelId ?? KOKORO_DEFAULT_MODEL_ID,
    dtype: config.dtype ?? 'q8',
    device: config.device ?? 'cpu',
    cacheDir: config.cacheDir ?? shresHomePath('models', 'speech', 'kokoro'),
    load,
  }
}

/** Register the Kokoro TTS provider with `ctx.speech`. */
export function apply(ctx: Context, config: Config): void {
  ctx.speech.registerTtsProvider(new KokoroTtsProvider(() => resolveOptions(config)))
}
