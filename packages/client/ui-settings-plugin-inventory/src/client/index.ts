/** Read-only Host plugin inventory plus the gesture-gated Manage tab, registered into Web Settings. */

import type {} from '@shres-code/shres-code-client-locale/client'
import type { ClientContext } from '@shres-code/shres-code-client-runtime/client'
import type {} from '@shres-code/shres-code-client-ui-settings/client'
import { PluginInventorySettingsTab, type PluginInventorySettingsTabInjected } from './PluginInventorySettingsTab.tsx'
import { PluginManageSettingsTab, type PluginManageSettingsTabInjected } from './PluginManageSettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from './locales.ts'

export type { PluginInventorySettingsTabInjected, PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
export type { PluginManageSettingsTabInjected, PluginManageSettingsTabProps } from './PluginManageSettingsTab.tsx'
export type { PluginInventoryLocaleKey } from './locales.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-only Host plugin inventory and Manage-tab copy. */
    'settings.pluginInventory': PluginInventoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInventory'

/** Services required by the Settings registrations and the generated Remote faces. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory', 'remote.pluginAdmin']

/**
 * Unwrap one pluginAdmin receipt. A wire failure throws exactly like the
 * inventory face does, keeping transport details out of component state.
 * @param op - the Remote method name, for the thrown error label.
 * @param receipt - the generated receipt promise.
 * @returns the receipt's value.
 */
async function unwrap<T>(
  op: string,
  receipt: Promise<
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  >,
): Promise<T> {
  const result = await receipt
  if (!result.ok) throw new Error(`pluginAdmin.${op} failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** Contribute the lazy inventory and Manage tabs to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const list: PluginInventorySettingsTabInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const injected = (): PluginInventorySettingsTabInjected => ({ list })

  const managed = (): PluginManageSettingsTabInjected => ({
    status: () => unwrap('status', ctx.remote.pluginAdmin.status()),
    begin: (verb, target) => unwrap('begin', ctx.remote.pluginAdmin.begin({ verb, target })),
    install: (token, spec) => unwrap('stageInstall', ctx.remote.pluginAdmin.stageInstall({ token, spec })),
    confirm: token => unwrap('confirm', ctx.remote.pluginAdmin.confirm({ token })),
    cancel: token => unwrap('cancel', ctx.remote.pluginAdmin.cancel({ token })),
    remove: (token, name) => unwrap('removePlugin', ctx.remote.pluginAdmin.removePlugin({ token, name })),
    skillAdd: (token, path) => unwrap('skillAdd', ctx.remote.pluginAdmin.skillAdd({ token, path })),
    skillRemove: (token, name) => unwrap('skillRemove', ctx.remote.pluginAdmin.skillRemove({ token, name })),
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'all',
    order: 10,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginInventorySettingsTab))

  // Second contribution of the same list slot: the section renders one entry
  // per registered id, so the Manage tab appears beside the inventory tab
  // without the section owner knowing either one.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'manage',
    order: 20,
    label: () => t('manageTab'),
    locale: NS,
    inject: managed,
  }, PluginManageSettingsTab))
}
