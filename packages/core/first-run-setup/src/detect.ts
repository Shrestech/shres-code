/**
 * Local Ollama probe. Reuses pi-ai discovery so `/v1/models` parsing stays
 * in one place; this module only supplies the timeout and maps a miss to
 * `reachable: false` instead of throwing.
 *
 * @module @roos-code/roos-code-first-run-setup/detect
 */

import { discoverModels } from '@roos-code/roos-code-llm-pi-ai'
import type { LocalOllamaStatus } from './types.ts'

/** Options for one local-Ollama listing probe. */
export interface DetectLocalOllamaOptions {
  /** OpenAI-compatible base URL, including the `/v1` suffix. */
  baseURL: string
  /** Abort the GET after this many milliseconds. */
  timeoutMs: number
}

/**
 * Ask a local Ollama endpoint which models it serves.
 * @param options - probe URL and timeout.
 * @returns advertised models, or `reachable: false` when the endpoint is down.
 */
export async function detectLocalOllama(options: DetectLocalOllamaOptions): Promise<LocalOllamaStatus> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, options.timeoutMs)
  try {
    const models = await discoverModels({
      baseURL: options.baseURL,
      api: 'openai-completions',
      signal: controller.signal,
    })
    return { reachable: true, models }
  } catch {
    // discoverModels throws on timeout/abort, connect failure, non-2xx, or a
    // non-listing body (DISCOVERY_FAILED). Every one of those means the
    // endpoint is not usable for first-run; nothing else reaches this catch.
    return { reachable: false, models: [] }
  } finally {
    clearTimeout(timer)
  }
}
