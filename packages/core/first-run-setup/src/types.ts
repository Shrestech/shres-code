/**
 * First-run picker choices and local-Ollama probe results.
 *
 * @module @roos-code/roos-code-first-run-setup/types
 */

import type { LlmDiscoveredModel } from '@roos-code/roos-code-llm'

/** Result of probing a local OpenAI-compatible Ollama endpoint. */
export interface LocalOllamaStatus {
  /** Whether `GET {baseURL}/models` answered with a listing. */
  reachable: boolean
  /** Models the endpoint advertised, in listing order. */
  models: readonly LlmDiscoveredModel[]
}

/** A template route the picker can offer without a live listing. */
export interface TemplateRoute {
  /** Provider route key written to `agent-default-model`. */
  provider: string
  /** Human label printed in the CLI menu. */
  label: string
  /** Credential reference to store when the user types a key. */
  apiKeyEnv?: string
  /** Fallback model id when the adapter lists none. */
  defaultModel: string
}

/** One menu entry the CLI prints. */
export type PickerOption =
  | {
    kind: 'ollama-local'
    provider: 'ollama-local'
    model: string
    name: string
  }
  | {
    kind: 'template'
    provider: string
    label: string
    apiKeyEnv?: string
    defaultModel: string
  }
  | {
    kind: 'custom'
  }

/** A resolved first-run choice the service can persist. */
export type FirstRunChoice =
  | {
    kind: 'ollama-local'
    model: string
  }
  | {
    kind: 'template'
    provider: string
    apiKey?: string
    model?: string
  }
  | {
    kind: 'custom'
    provider: string
    baseURL: string
    api?: string
    apiKey?: string
    model: string
    displayName?: string
  }

/** Streams the CLI picker reads and writes. Tests substitute captures. */
export interface CliIo {
  /** Line-oriented user input. */
  stdin: NodeJS.ReadableStream
  /** Menu and prompts. */
  stdout: NodeJS.WritableStream
  /** Loud-failure diagnostics. */
  stderr: NodeJS.WritableStream
  /** Whether the picker may block for input. */
  isTTY: boolean
}
