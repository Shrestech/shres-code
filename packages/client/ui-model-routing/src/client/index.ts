/**
 * Model-routing plugin, browser half: occupies the composer's named
 * `conversation.input.modelRouting` seat with the routing toggle, and lists the
 * per-session Routing view in the `conversation.view` slot. Reads ride the
 * generic projection pair through the standard-kit `useProjection`; the mode is
 * switched by executing /route on or /route off through `command.execute`, so
 * the host stays the single source of routing state and neither surface keeps
 * a local copy of it. The routing-idle restore submits a selection through the
 * per-session model-selection directory instead, because that gesture is a
 * model selection rather than a routing mode. The view's drill-down and
 * thresholds are unary reads on the `modelRouting` Remote namespace.
 */
import type { ModelSelection } from '@shres-code/shres-code-api-remotes/client'
import type { ModelRoutingGateView } from '@shres-code/shres-code-model-router/client'
import type { ClientContext, SessionId } from '@shres-code/shres-code-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.modelRouting seat).
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@shres-code/shres-code-client-locale/client'
// Type-only: pulls the `modelRouting` SessionProjectionMap merge for useProjection.
import type {} from '@shres-code/shres-code-model-router/client'
// Type-only: pulls the settings plugin's Context merge (ctx.settingsScope).
import type {} from '@shres-code/shres-code-client-ui-settings/client'
import { createRoutingEngineSource, type RoutingEngineSource } from './engine-source.ts'
import { RoutingChip } from './RoutingChip.tsx'
import { en, type RoutingKey } from './locales.ts'
import { RoutingView, type RoutingViewInjected } from './view/RoutingView.tsx'

export type { RoutingKey } from './locales.ts'
export type { RoutingViewInjected } from './view/RoutingView.tsx'
export type { RoutingEngineSource, RoutingEngineState, RoutingJudge } from './engine-source.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The composer routing chip's copy. */
    modelRouting: RoutingKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'modelRouting'

/**
 * The settings namespace the model router installs while it is mounted; its
 * scope status is the host-composition fact the Routing view is listed by.
 */
const MODEL_ROUTER_SETTINGS_NAMESPACE = 'model-router'

/**
 * The model-selection directory one session's selection surfaces share,
 * declared structurally rather than imported: ui-model-selection owns the
 * `ctx.modelDirectories` service, and this package needs exactly the one
 * operation both of that plugin's entries submit through. The restore is
 * therefore the ordinary selection path, not a second mechanism.
 */
interface ModelSelectionDirectory {
  /**
   * Select the complete provider/model/effort pair for this session.
   * @param selection - provider, provider-owned model id, and optional effort.
   * @returns nothing when the host accepted the selection; rejects otherwise.
   */
  select(selection: ModelSelection): Promise<void>
}

/** The subset of `ctx.modelDirectories` this seat reads. */
interface ModelSelectionDirectories {
  /**
   * Resolve the resident directory for one session.
   * @param sessionId - the owning session.
   * @returns the directory every selection surface for that session shares.
   */
  directoryFor(sessionId: SessionId): ModelSelectionDirectory
}

/** Injected business face of the composer routing seat. */
export interface RoutingChipInjected {
  /**
   * Whether this session can switch routing through the command channel; false
   * for addressed subagent sessions, whose Agent-bound commands would activate
   * persisted child history.
   */
  available: boolean
  /**
   * Switch the routing mode by executing /route on or /route off.
   * @param next - the mode to request.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   * Rejects on a transport fault, which the chip surfaces the same way.
   */
  setRouting: (next: boolean) => Promise<string | null>
  /**
   * Point the session's own selection back at the route the last downgraded
   * streak was entered on, through the model-selection directory the composer
   * picker and the /model popup both submit through. The switch is a selection
   * change the user asked for, so the next request re-prefills its prefix once.
   * @param selection - the provider/model/effort to select.
   * @returns null on an accepted selection; a user-visible failure line otherwise.
   */
  restoreStrong: (selection: ModelSelection) => Promise<string | null>
  /**
   * Fetch the configured gate, whose `stateMaxChars` the remote-judge confirm
   * states as the per-consult character cap.
   * @returns the gate; rejects when the host cannot read it.
   */
  loadGate: () => Promise<ModelRoutingGateView>
  /**
   * Open Settings › Model routing, where the judge is chosen for every
   * session. Absent, the confirm names the section as text.
   */
  openRoutingSettings?: () => void
  /**
   * Framework-bound sources. `routingEngine` is the judgment engine facts,
   * which decide whether turning routing on asks for confirmation first.
   */
  hooks: {
    routingEngine: RoutingEngineSource
  }
}

/**
 * The value of one Remote read, or a rejection carrying the host's failure;
 * the view reports a rejection inline with Retry.
 * @param result - the generated method's result.
 * @returns the value on success.
 * @throws Error naming the failure message and code otherwise.
 */
function remoteValue<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`${result.error.message} (${result.error.code})`)
  return result.value
}

/**
 * Required services: the slot registry, session binding lookup, the commands,
 * modelRouting, and judgmentEngines Remotes, the locale registry, settings
 * scopes.
 */
export const inject = [
  'slots', 'sessions', 'remote', 'remote.commands', 'remote.modelRouting', 'remote.judgmentEngines', 'locale', 'settingsScope',
]

/**
 * Client plugin body: register the routing chip over the command channel and the
 * model-selection path, and the Routing view over the `modelRouting` reads.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-model-routing: dictionaries')
  // Registration-time text (the view's label in the Activity popover) reads
  // through the bound translate as a thunk, so it follows the active locale.
  const t = ctx.locale.bind(NS)

  // The Routing view is listed while the host composes the model router. The
  // router installs its settings namespace only while it is mounted, so the
  // namespace's scope status is the host's composition fact: 'loading' is not
  // yet known and keeps the entry listed, so a persisted Routing selection
  // never falls back to Chat while the answer is on its way; 'unavailable'
  // unlists it; a namespace that returns (a settings change, a host reload)
  // lists it again. The shell resolves an unlisted selection to Chat at read
  // time without writing the store, so the selection returns with the view.
  // One engine-facts source for every view and chip: read once on load and
  // again on each engine, status, or selection change the host announces.
  const routingEngine = createRoutingEngineSource(() => ctx.remote.judgmentEngines.snapshot())
  ctx.effect(() => {
    routingEngine.refresh()
    const unlisten = ctx.remote.$on('judgment/engines-updated', () => { routingEngine.refresh() })
    return () => {
      unlisten()
      routingEngine.dispose()
    }
  }, 'ui-model-routing: judgment engine facts')
  const loadGate = async (): Promise<ModelRoutingGateView> => remoteValue(await ctx.remote.modelRouting.gate())

  const routerScope = ctx.settingsScope.bind<Record<string, unknown>>({
    namespace: MODEL_ROUTER_SETTINGS_NAMESPACE,
  })
  ctx.effect(() => {
    let unlist: (() => void) | undefined
    const sync = (): void => {
      const listed = routerScope.getSnapshot().status !== 'unavailable'
      if (listed && unlist === undefined) {
        unlist = ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'routing',
          order: 20,
          locale: NS,
          label: () => t('view.routing'),
          inject: (sessionId: SessionId): RoutingViewInjected => ({
            available: ctx.sessions.subagentAddress(sessionId) === undefined,
            loadDecision: async seq => remoteValue(await ctx.remote.modelRouting.decision(sessionId, seq)),
            loadGate,
            hooks: { routerSettings: routerScope, routingEngine },
          }),
        }, RoutingView))
      } else if (!listed && unlist !== undefined) {
        unlist()
        unlist = undefined
      }
    }
    sync()
    const unsubscribe = routerScope.subscribe(sync)
    return () => {
      unsubscribe()
      unlist?.()
    }
  }, 'ui-model-routing: routing view')

  ctx.slots.inject('conversation.input.modelRouting', () => ctx.slots.register({
    name: 'conversation.input.modelRouting',
    locale: NS,
    inject: (sessionId: SessionId): RoutingChipInjected => ({
      available: ctx.sessions.subagentAddress(sessionId) === undefined,
      // Failure strings stay English (error-surface policy: not localized).
      setRouting: async (next) => {
        const line = next ? '/route on' : '/route off'
        const result = await ctx.remote.commands.execute(sessionId, line)
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return `unknown command: ${line}`
        return null
      },
      loadGate,
      hooks: { routingEngine },
      restoreStrong: async (selection) => {
        // Optional service: a deployment composing no selection surface keeps the
        // chip, and the restore is the one gesture that reports the absence.
        const directories = ctx.get('modelDirectories') as ModelSelectionDirectories | undefined
        if (directories === undefined) return 'model selection is unavailable'
        try {
          await directories.directoryFor(sessionId).select(selection)
          return null
        } catch (reason: unknown) {
          return reason instanceof Error ? reason.message : String(reason)
        }
      },
    }),
  }, RoutingChip))
}
