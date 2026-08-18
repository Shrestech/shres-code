/**
 * J-Space settings plugin, browser half. Registers the J-Space page
 * over the Host `jspace` settings namespace.
 * Export discipline: packages/client/AGENTS.md.
 */

import type { ClientContext } from '@shres-code/shres-code-client-runtime/client'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type {} from '@shres-code/shres-code-client-ui-settings/client'
import type {} from '@shres-code/shres-code-client-locale/client'
import { createJSpaceViewSource, type JSpaceSessionRead } from './card-source.ts'
import { JSpaceSection } from './JSpaceSection.tsx'
import type { JSpaceSectionInjected, JSpaceSettings } from './JSpaceSection.tsx'
import { en, type JSpaceKey } from './locales.ts'

export type {
  JSpaceSectionInjected, JSpaceSectionProps, JSpaceSettings,
} from './JSpaceSection.tsx'
export type { JSpaceCardView } from './card-source.ts'
export type { JSpaceKey } from './locales.ts'

/** Settings namespace the Host seat registers. Spelled here: client must not import the Host package. */
export const JSPACE_SETTINGS_NAMESPACE = 'jspace'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The J-Space settings page copy. */
    'settings.jspace': JSpaceKey
  }
}

const NS = 'settings.jspace'

/** Required services. */
export const inject = ['slots', 'locale', 'settingsScope', 'sessions']

/**
 * Register the J-Space section once `settings.section` is declared.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-settings-jspace: copy dictionaries')
  const t = ctx.locale.bind(NS) as JSpaceSectionInjected['t']
  const scope = ctx.settingsScope.bind<JSpaceSettings>({
    namespace: JSPACE_SETTINGS_NAMESPACE,
  })
  const useSnapshot = bindSnapshotSelector(scope)
  const useCard = bindSnapshotSelector(
    createJSpaceViewSource(ctx.sessions as unknown as JSpaceSessionRead),
  )
  const injected = (): JSpaceSectionInjected => ({ scope, useSnapshot, useCard, t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'jspace',
    order: 13,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, JSpaceSection))
}
