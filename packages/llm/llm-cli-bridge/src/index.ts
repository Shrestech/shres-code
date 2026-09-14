/**
 * Register {@link CliLlmAdapter} for hand-declared delegated CLI routes.
 * There are no shipped routes: the shipped CLI delegations were retired in
 * favor of the subscription-session routes (`codex-session`, `grok-session`,
 * `cursor-session`). Per-route binary, model arg, effort arg, and env come
 * from the optional `llm-cli-bridge` settings section over this composition
 * entry.
 *
 * @module @shres-code/shres-code-llm-cli-bridge
 */

import type { Context } from '@shres-code/cordis'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import { credentialRef } from '@shres-code/shres-code-credentials'
import type {} from '@shres-code/shres-code-credentials'
import { launchEnvironmentOf } from '@shres-code/shres-code-launch-environment'
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  GenerateOptions,
  LlmConfigurableProvider,
} from '@shres-code/shres-code-llm'
import type { SessionId } from '@shres-code/shres-code-session'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import { CliLlmAdapter } from './adapter.ts'
import {
  Config,
  DEFAULT_DISPOSE_GRACE_MS,
  resolveRoutes,
  type CliBridgeRoute,
} from './config.ts'
import { executableOnPath } from './probe.ts'

export { CliLlmAdapter } from './adapter.ts'
export type { CliLlmAdapterOptions } from './adapter.ts'
export { buildCliArgv, effortFlags } from './argv.ts'
export {
  Config,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MAX_TOKENS,
  CUSTOM_ROUTE_TEMPLATE,
  SHIPPED_ROUTE_IDS,
  resolveRoutes,
} from './config.ts'
export type { CliBridgeModel, CliBridgeRoute, EffortStyle, ShippedRouteId } from './config.ts'
export { answerFromObject, isCliErrorPayload, parseCliOutput } from './parse.ts'
export { serializePrompt } from './serialize.ts'
export { executableOnPath } from './probe.ts'

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
      enabled: route.enabled !== false,
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
    binary: route.binary,
    binaryFound: executableOnPath(route.binary),
  }))
}

/**
 * Validate the process-tree grace, including a live settings overlay.
 * @param value - composition or current settings value.
 * @returns the checked grace in milliseconds.
 */
function readDisposeGraceMs(value: number | undefined): number {
  const disposeGraceMs = value ?? DEFAULT_DISPOSE_GRACE_MS
  if (!Number.isFinite(disposeGraceMs) || disposeGraceMs <= 0 || disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-cli-bridge: disposeGraceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return disposeGraceMs
}

/**
 * Resolve the child cwd from the request session workspace. A tool-running
 * CLI must not fall back to `process.cwd()`.
 * @param ctx - context that may carry the session store.
 * @param sessionId - stamped loop session, when present.
 * @returns the session header cwd.
 */
function sessionWorkspaceCwd(ctx: Context, sessionId: GenerateOptions['sessionId']): string {
  if (sessionId === undefined) {
    throw new Error('llm-cli-bridge: stream() requires a session with a workspace')
  }
  const sessions = ctx.get('sessions') as { get(id: SessionId): { header: { cwd?: string } } | undefined } | undefined
  if (sessions === undefined) {
    throw new Error('llm-cli-bridge: stream() requires ctx.sessions')
  }
  const cwd = sessions.get(sessionId)?.header.cwd
  if (cwd === undefined || cwd.length === 0) {
    throw new Error(
      'llm-cli-bridge: no working directory for the child — start from a session that has one',
    )
  }
  return cwd
}

/**
 * Build child env: copy the route overlay, then inject the named credential
 * after the subprocess scrub so the secret never lives in settings.
 * @param ctx - context that may carry credentials.
 * @param route - resolved route.
 * @returns env passed to spawn.
 */
export async function resolveRouteEnv(
  ctx: Context,
  route: CliBridgeRoute,
): Promise<Record<string, string>> {
  const env = { ...route.env }
  const ref = route.apiKeyEnv
  if (ref === undefined || ref.length === 0) return env
  const credentials = ctx.get('credentials')
  const secret = credentials !== undefined
    ? (await credentials.resolve(credentialRef(ref)))?.value
    : launchEnvironmentOf(ctx).get(ref)?.value
  if (secret !== undefined && secret.length > 0) env[ref] = secret
  return env
}

/**
 * Register one CLI-bridge adapter for all configured routes.
 * @param ctx - context carrying the llm service and optional settings/subprocess.
 * @param config - composition entry; settings overlay the route dict.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  readDisposeGraceMs(resolved.disposeGraceMs)

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
    cwd: sessionId => sessionWorkspaceCwd(ctx, sessionId),
    disposeGraceMs: () => readDisposeGraceMs(current().disposeGraceMs),
    resolveEnv: route => resolveRouteEnv(ctx, route),
  })

  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(routes())
    if (deepEqualJson(entries, directoryFacts)) return
    if (entries.length === 0) {
      // The llm service refuses an empty registration; with no declared route
      // the directory stays dormant until a settings overlay declares one.
      if (directory !== undefined) directory.replace(entries)
    } else if (directory === undefined) {
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
    const ids = [...routes().entries()]
      .filter(([, route]) => route.enabled !== false)
      .map(([id]) => id)
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
    setSource: (source) => { current = () => source() },
    onChange: () => {
      ensureDirectory()
      ensureRegistrationFacts()
    },
  })
}
