/**
 * Default-off X search tools for Shres agents on other routes. `x_keyword_search`,
 * `x_semantic_search`, `x_user_search`, and `x_thread_fetch` each ask the
 * grok-session route, through `ctx.llm`, with only the hosted `x_search` tool
 * offered and no function tools, so the Grok request cannot call back into
 * these tools. The tools are registered only while the `llm-grok-session`
 * settings section has `enabled`, `hostedXSearch`, and `agentXTools` all on;
 * this plugin follows that section live and owns no settings of its own.
 * @module @shres-code/shres-code-tool-grok-x-search
 */

import type { Context } from '@shres-code/cordis'
import type {} from '@shres-code/cordis-plugin-loader'
import { GROK_SESSION_SETTINGS_NAMESPACE } from '@shres-code/shres-code-llm-grok-session'
import type { Config as GrokSessionConfig } from '@shres-code/shres-code-llm-grok-session'
import type {} from '@shres-code/shres-code-settings'
import type {} from '@shres-code/shres-code-tools'
import { Config, resolveConfig } from './config.ts'
import { grokXToolDefinitions } from './tools.ts'

export { Config, MIN_RESULT_CHARS, resolveConfig } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export {
  GROK_X_SEARCH_SYSTEM,
  GROK_X_SEARCH_TIMEOUT_CODE,
  GROK_X_TOOL_SHARED_DESCRIPTION,
  GROK_X_TOOL_SPECS,
  X_SEARCH_HOSTED_TOOLS,
  boundGrokXResult,
  grokXToolDefinitions,
  parseGrokXArgument,
  renderGrokXResult,
  runGrokXSearch,
  xPostId,
} from './tools.ts'
export type { GrokXOperation, GrokXSearchValue, GrokXToolHost } from './tools.ts'
export type { GrokXSearchRequestEventData, GrokXSearchRoute, GrokXToolName } from './types.ts'

/** Cordis plugin name. */
export const name = 'tool-grok-x-search'

/** Services the tools and the settings gate read. */
export const inject = ['tools', 'llm', 'settings']

/**
 * Whether one `llm-grok-session` section opens the gate.
 * @param section - the resolved section, or `undefined` while unregistered.
 * @returns true only when `enabled`, `hostedXSearch`, and `agentXTools` are all `true`.
 */
export function grokXToolsEnabled(section: unknown): boolean {
  if (typeof section !== 'object' || section === null) return false
  const value = section as GrokSessionConfig
  return value.enabled === true && value.hostedXSearch === true && value.agentXTools === true
}

/**
 * Register or withdraw the four tools as the `llm-grok-session` section
 * changes. Withdrawing affects later requests only: a call already running
 * keeps its authorization and finishes or times out, while a call that starts
 * after the gate closed fails. Unloading this plugin aborts every running
 * call.
 * @param ctx - context carrying the tools, llm, and settings services.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const lifetime = new AbortController()
  const enabled = (): boolean => grokXToolsEnabled(ctx.settings.get(GROK_SESSION_SETTINGS_NAMESPACE))
  const host = { config: resolved, lifetime: lifetime.signal, isEnabled: enabled }
  let withdraw: (() => void) | undefined

  const sync = (): void => {
    const open = enabled()
    if (open && withdraw === undefined) {
      const disposers = grokXToolDefinitions(ctx, host).map(tool => ctx.tools.register(tool))
      withdraw = () => { for (const dispose of disposers) dispose() }
    } else if (!open && withdraw !== undefined) {
      withdraw()
      withdraw = undefined
    }
  }

  ctx.effect(() => () => {
    lifetime.abort(new Error('tool-grok-x-search unloaded'))
    withdraw?.()
    withdraw = undefined
  }, 'tool-grok-x-search: registration and in-flight calls')
  const onNamespace = (ns: string): void => {
    if (ns === GROK_SESSION_SETTINGS_NAMESPACE) sync()
  }
  ctx.on('settings/registered', onNamespace)
  ctx.on('settings/updated', onNamespace)
  ctx.on('settings/unregistered', onNamespace)
  sync()
  // Load order is not guaranteed; a namespace still missing once the Loader
  // settled means llm-grok-session is not composed and the tools stay off.
  const warnIfUnregistered = (): void => {
    if (lifetime.signal.aborted || ctx.settings.get(GROK_SESSION_SETTINGS_NAMESPACE) !== undefined) return
    ctx.logger.warn('tool-grok-x-search: the llm-grok-session settings section is not registered; the X search tools stay off until llm-grok-session loads')
  }
  // A failed sibling entry rejects the Loader's wait; the namespace check still applies.
  void ctx.get('loader')?.await().then(warnIfUnregistered, warnIfUnregistered)
}
