/** Loader entry ownership and the plugin manager's protected infrastructure. */
import type { Context } from '@shres-code/cordis'
import type {} from '@shres-code/cordis-plugin-loader'
import { isProfileManagementModule } from '@shres-code/shres-code-app-boot'
import { readPluginInventory } from '@shres-code/shres-code-host-plugin-inventory'
import type { ManagedPlugin } from './types.ts'

/**
 * Read live plugin entries and identify rows the profile patch can safely address.
 * @param ctx - gateway context; raw compositions may omit the Loader.
 * @returns entries with reasons for refusing activation changes.
 */
export function managedPlugins(ctx: Context): ManagedPlugin[] {
  const loader = ctx.get('loader')
  if (loader === undefined) return []
  const actual = [...loader.entries()]
  return readPluginInventory(ctx).entries.map((row) => {
    const entry = actual.find(item => item.id === row.entryId)
    const reason = isProfileManagementModule(row.moduleName)
      ? 'management-required'
      : entry?.parent.tree.ctx.fiber.entry?.id !== 'include'
        || actual.filter(item => item.options.id === entry.options.id).length !== 1
        ? 'unaddressable' : undefined
    return { ...row, ...(reason === undefined ? {} : { readOnlyReason: reason }) }
  })
}
