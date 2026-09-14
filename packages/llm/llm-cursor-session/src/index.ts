/**
 * Register the `cursor-session` provider route: an HTTP (non-spawn) route
 * over the Cursor Agent CLI's own login credential, served through the
 * shared `cursor-credential` engine. Model listing and resolution are live;
 * chat streaming fails loud while the agent wire's proprietary handshake is
 * not replicated — a hand-declared `cursor-cli` overlay route on
 * `llm-cli-bridge` (cursor-agent spawn) is the serving path for completions.
 *
 * @module @shres-code/shres-code-llm-cursor-session
 */

import type { Context } from '@shres-code/cordis'
import { CursorSessionManager } from '@shres-code/shres-code-cursor-credential'
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  LlmConfigurableProvider,
} from '@shres-code/shres-code-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import { CursorSessionLlmAdapter } from './adapter.ts'
import { CURSOR_SESSION_PROVIDER_ID, Config, resolveConfig } from './config.ts'

export { CursorSessionLlmAdapter } from './adapter.ts'
export type { CursorSessionAdapterOptions } from './adapter.ts'
export {
  Config,
  CURSOR_SESSION_PROVIDER_ID,
  DEFAULT_BASE_URL,
  DEFAULT_DISPLAY_NAME,
  SHIPPED_MODELS,
  defaultAuthPath,
  resolveConfig,
} from './config.ts'
export type { Config as CursorSessionConfig, CursorSessionModelConfig, ResolvedCursorSessionRoute } from './config.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-cursor-session'

/** The LLM seam this adapter registers into. */
export const inject = ['llm']

const NS = settingsNamespace('llm-cursor-session')

/** Register the cursor-session route with `ctx.llm`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  const route = () => resolveConfig(current())
  const manager = () => {
    const engine = ctx.get('cursorCredential')
    if (engine === undefined) return undefined
    const resolved = route()
    return engine.managerFor({
      securityPath: resolved.securityPath,
      authPath: resolved.authPath,
      useKeychain: resolved.useKeychain,
    })
  }
  const adapter = new CursorSessionLlmAdapter({ route, manager })

  const directoryEntry = (): LlmConfigurableProvider => ({
    provider: CURSOR_SESSION_PROVIDER_ID,
    displayName: route().displayName,
    settingsNs: NS,
    settingsPath: [],
    declared: false,
  })
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entry = directoryEntry()
    if (deepEqualJson(entry, directoryFacts)) return
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders([entry])
    } else {
      directory.replace([entry])
    }
    directoryFacts = entry
  }
  ensureDirectory()

  // The settings schema defaults `enabled` to true, so the section value is
  // always a boolean here.
  let registration: AdapterRegistrationHandle | undefined
  let registeredEnabled: boolean | undefined
  const ensureRegistration = (): void => {
    const enabled = current().enabled
    if (enabled === registeredEnabled) return
    registeredEnabled = enabled
    if (registration === undefined) {
      if (!enabled) return
      registration = ctx.llm.registerAdapter([CURSOR_SESSION_PROVIDER_ID], adapter)
      return
    }
    if (enabled) {
      registration.replace([CURSOR_SESSION_PROVIDER_ID])
    } else {
      registration.replace([])
    }
  }
  ensureRegistration()

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      ensureDirectory()
      ensureRegistration()
    },
  })
}

// Re-export for consumers that build a manager directly.
export { CursorSessionManager }
