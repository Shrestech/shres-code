/**
 * In-process EmbeddingGemma-300M ONNX backend for `ctx.wiki` embeddings.
 * @module @shres-code/shres-code-wiki-embed-onnx/provider
 */

import { existsSync, readdirSync } from 'node:fs'
import type { WikiEmbeddings } from '@shres-code/shres-code-wiki'

/** Hugging Face model id this provider loads. */
export const WIKI_EMBED_DEFAULT_MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX'

/** Result face returned by transformers.js feature-extraction. */
export interface WikiEmbedOutput {
  readonly data?: ArrayLike<number>
  readonly dims?: readonly number[]
  tolist?(): unknown
}

/** Minimal feature-extraction face; tests inject a fake. */
export interface WikiEmbedEngine {
  (texts: string | readonly string[], options?: { pooling?: string; normalize?: boolean }): Promise<unknown>
}

/** Options for {@link WikiEmbedLoader}. */
export interface WikiEmbedLoadRequest {
  readonly modelId: string
  readonly cacheDir: string
  /** When false, the pipeline loads local cache files only and never downloads. */
  readonly allowDownload: boolean
}

/**
 * Load one feature-extraction engine. Production uses {@link loadWikiEmbedJs};
 * tests inject a fake so CI never downloads weights.
 */
export type WikiEmbedLoader = (request: WikiEmbedLoadRequest, signal?: AbortSignal) => Promise<WikiEmbedEngine>

/** Connection facts the plugin projects per call. */
export interface WikiEmbedOptions {
  readonly enabled: boolean
  readonly allowDownload: boolean
  readonly modelId: string
  readonly cacheDir: string
  readonly load: WikiEmbedLoader
}

/* v8 ignore start -- default loader talks to Hugging Face; unit tests inject a fake engine. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('wiki-embed-onnx: load was cancelled')
}

function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  if (signal === undefined) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error('wiki-embed-onnx: load was cancelled'))
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
 * Default loader: `@huggingface/transformers` feature-extraction.
 * When the request forbids download, the pipeline runs `local_files_only`, so
 * a cold cache fails instead of fetching.
 * @param request - model, cache, download policy.
 * @param signal - optional cancellation around the download.
 * @returns the loaded pipeline.
 */
export async function loadWikiEmbedJs(
  request: WikiEmbedLoadRequest,
  signal?: AbortSignal,
): Promise<WikiEmbedEngine> {
  throwIfAborted(signal)
  try {
    const mod = await import('@huggingface/transformers') as {
      pipeline: (task: string, model: string, options: object) => Promise<WikiEmbedEngine>
    }
    return await raceAbort(mod.pipeline('feature-extraction', request.modelId, {
      cache_dir: request.cacheDir,
      local_files_only: !request.allowDownload,
    }), signal)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('wiki-embed-onnx:')) throw error
    throw new Error('wiki-embed-onnx: failed to load EmbeddingGemma-300M', { cause: error })
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

/**
 * Normalize a transformers.js feature-extraction result into one vector per input.
 * @param output - engine return value.
 * @param count - expected number of vectors.
 * @returns one row per input text.
 */
export function vectorsFrom(output: unknown, count: number): number[][] {
  if (Array.isArray(output) && output.every(row => Array.isArray(row))) {
    return (output as number[][]).slice(0, count).map(row => row.map(Number))
  }
  if (output !== null && typeof output === 'object' && 'tolist' in output) {
    const record = output as WikiEmbedOutput
    if (typeof record.tolist === 'function') return vectorsFrom(record.tolist(), count)
  }
  if (output !== null && typeof output === 'object' && 'data' in output) {
    const record = output as WikiEmbedOutput
    const data = record.data
    if (data === undefined) return Array.from({ length: count }, () => [])
    const dims = record.dims
    const width = dims !== undefined && dims.length >= 2 ? Number(dims[dims.length - 1]) : Math.floor(data.length / Math.max(1, count))
    if (!Number.isFinite(width) || width <= 0) return Array.from({ length: count }, () => [])
    const rows: number[][] = []
    for (let index = 0; index < count; index += 1) {
      const start = index * width
      const row: number[] = []
      for (let offset = 0; offset < width; offset += 1) row.push(data[start + offset] ?? 0)
      rows.push(row)
    }
    return rows
  }
  return Array.from({ length: count }, () => [])
}

/** Local EmbeddingGemma-300M embeddings provider. */
export class WikiOnnxEmbeddings implements WikiEmbeddings {
  private engine: WikiEmbedEngine | undefined
  private loading: Promise<WikiEmbedEngine> | undefined
  private loadedModel: string | undefined

  /**
   * @param options - thunk returning the currently authoritative connection facts.
   */
  constructor(private readonly options: () => WikiEmbedOptions) {}

  /**
   * Cheap local usability check: enabled, and either a download is allowed or
   * the cache is already warm. Must not load weights.
   * @returns whether an embed would be attempted.
   */
  available(): boolean {
    const options = this.options()
    return options.enabled && (options.allowDownload || cacheIsWarm(options.cacheDir))
  }

  /**
   * Embed one or more texts.
   * @param texts - non-empty strings to embed.
   * @param signal - optional cancellation around load and inference.
   * @returns one vector per input text, same length and order.
   */
  async embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return []
    if (!this.available()) throw new Error('wiki-embed-onnx: embeddings are unavailable')
    const options = this.options()
    const engine = await this.ensureEngine(options, signal)
    signal?.throwIfAborted()
    const [only] = texts
    const output = await engine(texts.length === 1 && only !== undefined ? only : [...texts], {
      pooling: 'mean',
      normalize: true,
    })
    return vectorsFrom(output, texts.length)
  }

  private ensureEngine(options: WikiEmbedOptions, signal?: AbortSignal): Promise<WikiEmbedEngine> {
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
