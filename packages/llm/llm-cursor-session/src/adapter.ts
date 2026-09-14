/**
 * Cursor subscription adapter: serves the verified model catalog with the
 * CLI login's bearer credential, and fails loud on chat while the agent
 * wire's proprietary handshake is not replicated.
 * @module @shres-code/shres-code-llm-cursor-session/adapter
 */

import { LlmAdapter, LlmError } from '@shres-code/shres-code-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@shres-code/shres-code-llm'
import type { CursorSessionManager } from '@shres-code/shres-code-cursor-credential'
import type { ResolvedCursorSessionRoute } from './config.ts'

/** Constructor hooks the plugin owns. */
export interface CursorSessionAdapterOptions {
  /** Current resolved route; re-read per operation. */
  route: () => ResolvedCursorSessionRoute
  /** Shared credential manager, when the engine is mounted. */
  manager: () => CursorSessionManager | undefined
}

/**
 * `LlmAdapter` for the Cursor subscription route. Model listing and
 * resolution are served; `stream()` resolves the credential first so login
 * failures surface, then rejects with the wire-gate diagnostic.
 */
export class CursorSessionLlmAdapter extends LlmAdapter {
  constructor(private readonly options: CursorSessionAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.route().displayName }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const route = this.options.route()
    return Promise.resolve(route.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
    })))
  }

  override resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    const route = this.options.route()
    const model = route.models.find(entry => entry.id === id)
    return Promise.resolve({
      provider,
      id,
      name: model?.name ?? id,
      ...model?.contextWindow !== undefined ? { context: { contextWindow: model.contextWindow } } : {},
      ...model?.maxTokens !== undefined ? { defaultMaxTokens: model.maxTokens } : {},
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterableIterator<StreamChunk> {
    const manager = this.options.manager()
    if (manager !== undefined) {
      // Surface the login state first: an expired or absent credential is the
      // actionable failure, ahead of the wire gate.
      await manager.current()
    }
    throw new LlmError(
      'llm-cursor-session: the Cursor agent wire (agent.v1.AgentService/Run on'
      + ' agentn.global.api5.cursor.sh) gates model turns behind an undocumented'
      + ' client handshake this adapter does not replicate; for Cursor completions'
      + ' declare a cursor-cli overlay route in the llm-cli-bridge settings'
      + ' (cursor-agent spawn) until the wire is served',
      'UNSUPPORTED_OPTION',
    )
  }
}
