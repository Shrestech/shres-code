/**
 * Delegated-completion adapter: spawn a product CLI and emit a text stream.
 * @module @shres-code/shres-code-llm-cli-bridge/adapter
 */

import {
  LlmAdapter,
  LlmError,
} from '@shres-code/shres-code-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@shres-code/shres-code-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@shres-code/shres-code-subprocess'
import { buildCliArgv } from './argv.ts'
import {
  STDOUT_COLLECT_MAX_BYTES,
  effortInfo,
  type CliBridgeRoute,
} from './config.ts'
import { parseCliOutput } from './parse.ts'
import { serializePrompt } from './serialize.ts'

/** Constructor hooks the plugin owns. */
export interface CliLlmAdapterOptions {
  /** Current resolved routes; re-read per operation. */
  routes: () => ReadonlyMap<string, CliBridgeRoute>
  /** Shared subprocess spawn, when the seam is mounted. */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /**
   * Working directory for the child CLI, resolved from the request session.
   * Must fail loud when no session workspace exists.
   */
  cwd: (sessionId?: GenerateOptions['sessionId']) => string
  /** Process-tree termination grace. */
  disposeGraceMs: () => number
  /**
   * Child env after the subprocess scrub. Resolves `apiKeyEnv` through the
   * credentials seam so the secret never lives in settings.
   */
  resolveEnv?: (route: CliBridgeRoute) => Promise<Record<string, string>> | Record<string, string>
}

/**
 * `LlmAdapter` that completes through an external coding-agent CLI.
 * There is no HTTP request, so attribution headers do not apply.
 */
export class CliLlmAdapter extends LlmAdapter {
  constructor(private readonly options: CliLlmAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const route = this.options.routes().get(provider)
    return {
      id: provider,
      name: route?.displayName ?? provider,
      kind: 'delegated',
    }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const route = this.requireRoute(provider)
    return Promise.resolve(route.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
    })))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const route = this.requireRoute(provider)
    const configured = route.models.find(entry => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: configured?.name ?? model,
      context: { contextWindow: route.contextWindow },
      defaultMaxTokens: route.defaultMaxTokens,
      // A route with no effort flags (cursor-agent) declares no reasoning
      // metadata at all; the seam requires at least one advertised effort
      // whenever `reasoning` is present.
      ...(route.efforts.length === 0
        ? {}
        : { reasoning: { efforts: effortInfo(route.efforts) } }),
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const route = this.requireRoute(options.provider)
    if ((options.tools?.length ?? 0) > 0 && !route.allowDelegatedTools) {
      throw new LlmError(
        `llm-cli-bridge: provider "${options.provider}" cannot honor harness tools unless allowDelegatedTools is true`,
        'UNSUPPORTED_OPTION',
      )
    }
    if (options.temperature !== undefined) {
      throw new LlmError(
        `llm-cli-bridge: provider "${options.provider}" does not support temperature`,
        'UNSUPPORTED_OPTION',
      )
    }
    if (options.stop !== undefined) {
      throw new LlmError(
        `llm-cli-bridge: provider "${options.provider}" does not support stop sequences`,
        'UNSUPPORTED_OPTION',
      )
    }
    const argv = buildCliArgv(route, {
      model: options.model,
      ...options.reasoningEffort === undefined ? {} : { effort: String(options.reasoningEffort) },
      prompt: serializePrompt(options),
    })
    const env = this.options.resolveEnv === undefined
      ? route.env
      : await this.options.resolveEnv(route)
    const child = this.options.spawn({
      argv,
      cwd: this.options.cwd(options.sessionId),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: STDOUT_COLLECT_MAX_BYTES },
        stderr: 'inherit',
      },
      graceMs: this.options.disposeGraceMs(),
      env,
      signal: options.signal,
    })
    const onAbort = (): void => { child.terminate() }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const outcome = await child.done
      if (options.signal?.aborted) {
        throw new LlmError('llm-cli-bridge: request was aborted', 'ABORTED')
      }
      if (outcome.exitCode !== 0) {
        throw new LlmError(
          `llm-cli-bridge: ${route.binary} exited with code ${String(outcome.exitCode)} signal ${String(outcome.signal)}`,
          'CLI_EXIT',
        )
      }
      const parsed = parseCliOutput(route, child.collected.stdout?.readFrom(0).text ?? '')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: parsed.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: parsed.text } }
      if (parsed.usage !== undefined) yield { type: 'usage', usage: parsed.usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      if (child.pid > 0) {
        child.terminate()
        await child.waitForExit().catch(function alreadySettledOrKilled() {
          // Teardown after the owner already settled or killed the child.
        })
      }
      await child.done.catch(function alreadySettledOrKilled() {
        // Teardown after the owner already settled or killed the child.
      })
    }
  }

  private requireRoute(provider: string): CliBridgeRoute {
    const route = this.options.routes().get(provider)
    if (route === undefined) {
      throw new LlmError(`llm-cli-bridge: no route registered for provider "${provider}"`, 'NO_ADAPTER')
    }
    return route
  }
}
