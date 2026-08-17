/**
 * Shield settings plugin, browser half. Registers the Shield page over the
 * Host `shres-shield` settings namespace.
 * Export discipline: packages/client/AGENTS.md.
 */

import type { ClientContext } from '@shres-code/shres-code-client-runtime/client'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type {} from '@shres-code/shres-code-client-ui-settings/client'
import type {} from '@shres-code/shres-code-client-locale/client'
import { ShieldSection } from './ShieldSection.tsx'
import type { ShieldSectionInjected, ShieldSettings } from './ShieldSection.tsx'
import { en, type ShieldKey } from './locales.ts'
import { publishShieldMark } from './mark.ts'

export type { ShieldSectionInjected, ShieldSectionProps, ShieldSettings } from './ShieldSection.tsx'
export type { ShieldKey } from './locales.ts'

/** Settings namespace the Host seat registers. Spelled here: client must not import the Host package. */
export const SHIELD_SETTINGS_NAMESPACE = 'shres-shield'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Shield settings page copy. */
    'settings.shield': ShieldKey
  }
}

const NS = 'settings.shield'

/** Required services. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Register the Shield section once `settings.section` is declared.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-settings-shield: copy dictionaries')
  const t = ctx.locale.bind(NS) as ShieldSectionInjected['t']
  const scope = ctx.settingsScope.bind<ShieldSettings>({ namespace: SHIELD_SETTINGS_NAMESPACE })
  const useSnapshot = bindSnapshotSelector(scope)
  const injected = (): ShieldSectionInjected => ({ scope, useSnapshot, t })
  ctx.effect(() => {
    const sync = (): void => {
      const snap = scope.getSnapshot()
      if (snap.status === 'loading') return
      publishShieldMark(snap.status === 'ready' && snap.value?.enabled !== false)
    }
    sync()
    return scope.subscribe(sync)
  }, 'ui-settings-shield: product mark')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'shield',
    order: 12,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, ShieldSection))
}
