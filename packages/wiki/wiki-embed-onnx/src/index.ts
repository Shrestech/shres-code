/**
 * Register an in-process EmbeddingGemma-300M embeddings provider on `ctx.wiki`.
 * Weights load on first embed into the harness model cache; no API key is
 * required. Absent or unavailable embeddings leave search on BM25.
 *
 * @module @shres-code/shres-code-wiki-embed-onnx
 */

import { join } from 'node:path'
import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { shresHomePath } from '@shres-code/shres-code-home-paths'
import type {} from '@shres-code/shres-code-wiki'
import {
  loadWikiEmbedJs,
  WIKI_EMBED_DEFAULT_MODEL_ID,
  WikiOnnxEmbeddings,
} from './provider.ts'
import type { WikiEmbedLoader, WikiEmbedOptions } from './provider.ts'

export {
  cacheIsWarm,
  loadWikiEmbedJs,
  vectorsFrom,
  WIKI_EMBED_DEFAULT_MODEL_ID,
  WikiOnnxEmbeddings,
} from './provider.ts'
export type {
  WikiEmbedEngine, WikiEmbedLoadRequest, WikiEmbedLoader, WikiEmbedOptions, WikiEmbedOutput,
} from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wiki-embed-onnx'

/** The wiki seam this provider registers into. */
export const inject = ['wiki']

/** Plugin config (all optional — `apply` fills defaults). */
export interface Config {
  /** Hugging Face model id. */
  modelId?: string
  /** Cache directory for downloaded weights. */
  cacheDir?: string
  /** When false, refuse to download and require a warm cache. Defaults to true. */
  allowDownload?: boolean
  /** When false, the backend reports unavailable. Defaults to on. */
  enabled?: boolean
}

/** Loader-validated plugin config for local wiki embeddings. */
export const Config: z<Config> = z.object({
  modelId: z.string(),
  cacheDir: z.string(),
  allowDownload: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

/**
 * Fill embeddings connection facts from plugin config.
 * @param config - plugin config.
 * @param load - optional test loader.
 * @returns provider options.
 */
export function resolveOptions(config: Config, load: WikiEmbedLoader = loadWikiEmbedJs): WikiEmbedOptions {
  const modelId = config.modelId ?? WIKI_EMBED_DEFAULT_MODEL_ID
  return {
    enabled: config.enabled !== false,
    allowDownload: config.allowDownload !== false,
    modelId,
    cacheDir: config.cacheDir ?? join(shresHomePath('models', 'wiki'), modelId.replaceAll('/', '__')),
    load,
  }
}

/**
 * Register the ONNX embeddings provider with `ctx.wiki`.
 * @param ctx - context exposing `ctx.wiki`.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const provider = new WikiOnnxEmbeddings(() => resolveOptions(config))
  ctx.effect(() => {
    const dispose = ctx.wiki.registerEmbeddings(provider)
    return dispose
  }, 'wiki-embed-onnx')
}
