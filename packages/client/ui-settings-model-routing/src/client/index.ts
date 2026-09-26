/**
 * Settings › Model routing, browser half. It registers the global routing
 * configuration page while the Host serves the judgment engine view — a Host
 * that composes no judgment dispatcher gets no page — and keeps the page model
 * fresh on every pushed invalidation. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@shres-code/shres-code-client-runtime/client'
import type { ConnectionHandle } from '@shres-code/shres-code-api-remotes/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@shres-code/shres-code-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@shres-code/shres-code-client-locale/client'
// Type-only: pulls the ctx.remote merge, the generated judgmentEngines, laya,
// and modelRouting namespaces, and the forwarded-event key face into this program.
import type {} from '@shres-code/shres-code-api-remotes/client'
import { ModelRoutingSection } from './ModelRoutingSection.tsx'
import type { ModelRoutingSectionInjected } from './ModelRoutingSection.tsx'
import { createModelRoutingController, JUDGMENT_NS, MODEL_ROUTER_NS } from './model.ts'
import { en, type ModelRoutingKey } from './locales.ts'

export type { ModelRoutingSectionInjected, ModelRoutingSectionProps } from './ModelRoutingSection.tsx'
export type { ModelRoutingKey } from './locales.ts'
export type { ModelRoutingController, ModelRoutingState, PoolCandidateDraft, RouteFromDraft, WriteFailure } from './model.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Model routing settings page copy. */
    'settings.modelRouting': ModelRoutingKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.modelRouting'

/**
 * Required services (cordis fiber inject). The generated `judgmentEngines`,
 * `laya`, and `modelRouting` namespaces are mounted by the api-remotes Client
 * assembly; whether the Host serves them is read at run time.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.judgmentEngines', 'remote.laya', 'remote.modelRouting']

/**
 * Probe the Host's engine view, register the Settings entry while it is
 * served, and refresh the page model on engine, settings, and connection
 * invalidations.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-settings-model-routing: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const controller = createModelRoutingController(connection.api, {
    snapshot: () => ctx.remote.judgmentEngines.snapshot(),
    layaStatus: () => ctx.remote.laya.gatewayStatus(),
    layaInstall: () => ctx.remote.laya.installGateway(),
    layaRestart: () => ctx.remote.laya.restartGateway(),
    gate: () => ctx.remote.modelRouting.gate(),
    poolStatus: () => ctx.remote.modelRouting.poolStatus(),
  })
  const t = ctx.locale.bind(NS)
  const injected = (): ModelRoutingSectionInjected => ({ controller, hooks: { snapshot: controller.store } })

  // The page exists only while the Host serves the engine view: registration
  // follows the published availability, and disposal removes an active entry.
  ctx.effect(() => {
    let unregister: (() => void) | undefined
    const reconcile = (): void => {
      const composed = controller.store.getSnapshot().availability === 'composed'
      if (composed && unregister === undefined) {
        unregister = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'model-routing',
          order: 10.5,
          label: () => t('nav'),
          locale: NS,
          inject: injected,
        }, ModelRoutingSection))
      } else if (!composed && unregister !== undefined) {
        unregister()
        unregister = undefined
      }
    }
    const unsubscribe = controller.store.subscribe(reconcile)
    reconcile()
    return () => {
      unsubscribe()
      unregister?.()
    }
  }, 'ui-settings-model-routing: section registration')

  ctx.effect(() => {
    const refresh = (): void => { void controller.refresh() }
    const disposers = [
      ctx.remote.$on('judgment/engines-updated', refresh),
      ctx.remote.$on('settings/document-updated', (ns) => {
        if (ns === JUDGMENT_NS || ns === MODEL_ROUTER_NS) refresh()
      }),
      // Registered routes and their models decide the pool notes and the catalog the editor offers.
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    void controller.probe()
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings-model-routing: pushed invalidations')
}
