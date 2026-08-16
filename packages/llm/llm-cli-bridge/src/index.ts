/**
 * Register {@link CliLlmAdapter} for the `claude-cli`, `codex-cli`,
 * `grok-cli`, and `kimi-cli` provider routes. Per-route binary, model arg,
 * effort arg, and env come from the optional `llm-cli-bridge` settings
 * section over this composition entry.
 *
 * @module @roos-code/roos-code-llm-cli-bridge
 */

import type { Context } from '@roos-code/cordis'
import { MAX_TIMER_DELAY_MS } from '@roos-code/roos-code-timeout'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@roos-code/roos-code-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@roos-code/roos-code-settings'
import { CliLlmAdapter } from './adapter.ts'
import {
  Config,
  DEFAULT_DISPOSE_GRACE_MS,
  resolveRoutes,
  type CliBridgeRoute,
} from './config.ts'

export { CliLlmAdapter } from './adapter.ts'
export type { CliLlmAdapterOptions } from './adapter.ts'
export { buildCliArgv, effortFlags } from './argv.ts'
export {
  Config,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MAX_TOKENS,
  SHIPPED_ROUTE_IDS,
  SHIPPED_ROUTES,
  resolveRoutes,
} from './config.ts'
export type { CliBridgeModel, CliBridgeRoute, EffortStyle, ShippedRouteId } from './config.ts'
export { parseCliOutput } from './parse.ts'
export { serializePrompt } from './serialize.ts'

export const name = 'llm-cli-bridge'
export const inject = ['llm']

const NS = settingsNamespace('llm-cli-bridge')

type ResolvedConfig = {
  routes?: Config['routes']
  disposeGraceMs: number
}

/**
 * The registry captures these per route; a change here must re-register.
 * @param routes - currently resolved routes.
 * @returns a stable registration key.
 */
function registrationFacts(routes: ReadonlyMap<string, CliBridgeRoute>): unknown {
  return [...routes.entries()]
    .map(([provider, route]) => ({
      provider,
      displayName: route.displayName,
      binary: route.binary,
      allowDelegatedTools: route.allowDelegatedTools,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * Configurable-provider directory for every resolved CLI route.
 * @param routes - currently resolved routes.
 * @returns directory entries marked delegated.
 */
function directoryEntries(
  routes: ReadonlyMap<string, CliBridgeRoute>,
): LlmConfigurableProvider[] {
  return [...routes.entries()].map(([provider, route]) => ({
    provider,
    displayName: route.displayName,
    settingsNs: NS,
    settingsPath: ['routes', provider],
    declared: false,
    kind: 'delegated' as const,
  }))
}

/**
 * Register one CLI-bridge adapter for all configured routes.
 * @param ctx - context carrying the llm service and optional settings/subprocess.
 * @param config - composition entry; settings overlay the route dict.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const disposeGraceMs = resolved.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  if (!Number.isFinite(disposeGraceMs) || disposeGraceMs <= 0 || disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-cli-bridge: disposeGraceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }

  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let memoized: ReadonlyMap<string, CliBridgeRoute> | undefined
  const routes = (): ReadonlyMap<string, CliBridgeRoute> => {
    const raw = current()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveRoutes(raw.routes)
    lastRaw = raw
    memoized = next
    return next
  }
  routes()

  const adapter = new CliLlmAdapter({
    routes,
    spawn: (spec) => {
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) {
        throw new Error('llm-cli-bridge: stream() requires ctx.subprocess')
      }
      return subprocess.spawn(spec)
    },
    cwd: () => process.cwd(),
    disposeGraceMs: () => disposeGraceMs,
  })

  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(routes())
    if (deepEqualJson(entries, directoryFacts)) return
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()

  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(routes())
    if (deepEqualJson(facts, registeredFacts)) return
    const ids = [...routes().keys()]
    if (registration === undefined) {
      if (ids.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(ids, adapter)
    } else {
      registration.replace(ids)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  installSettingsSection(ctx, NS, Config, config as never, {
    setSource: (source) => { current = () => source() as Config },
    onChange: () => {
      ensureDirectory()
      ensureRegistrationFacts()
    },
  })
}
