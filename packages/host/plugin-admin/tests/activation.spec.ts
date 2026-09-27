import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EntryOptions } from '@shres-code/cordis-plugin-loader'
import { Context } from '@shres-code/cordis'
import { boot, provideProfileRuntime } from '@shres-code/shres-code-app-boot'
import { managedPlugins } from '../src/activation.ts'
import { PluginAdminGateway } from '../src/gateway.ts'
import { nodePluginAdminCore } from '../src/core.ts'
import type { PluginAdminCore } from '../src/core.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function composition(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'shres-manager-rows-'))
  directories.push(dir)
  await writeFile(join(dir, 'feature.mjs'), 'export function apply() {}\n')
  await writeFile(join(dir, 'cordis.yml'), '- id: feature\n  name: ./feature.mjs\n')
  const ctx = await boot('manager-rows', join(dir, 'cordis.yml'))
  contexts.push(ctx)
  return ctx
}

describe('managed plugin entries', () => {
  it('has no entries when a raw host provides no Loader', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(managedPlugins(ctx)).toEqual([])
  })

  it('allows profile rows and refuses entries outside the profile include', async () => {
    const ctx = await composition()
    const feature = managedPlugins(ctx).find(row => row.entryId === 'include:feature')
    expect(feature).toEqual({ entryId: 'include:feature', moduleName: './feature.mjs', enabled: true, fiberPhase: 'active' })
    expect(managedPlugins(ctx).find(row => row.entryId === 'include')?.readOnlyReason).toBe('unaddressable')
    ctx.loader.builtins.feature = () => {}
    const outside: EntryOptions = { id: 'outside', name: 'cordis:feature' }
    await ctx.loader.create(outside)
    expect(managedPlugins(ctx).find(row => row.entryId === 'outside')?.readOnlyReason).toBe('unaddressable')
  })

  it('does not target an ambiguous patch id and reflects live disposal', async () => {
    const ctx = await composition()
    ctx.loader.builtins.feature = () => {}
    const duplicate: EntryOptions = { id: 'feature', name: 'cordis:feature' }
    await ctx.loader.create(duplicate)
    expect(managedPlugins(ctx).find(row => row.entryId === 'include:feature')?.readOnlyReason).toBe('unaddressable')
    await ctx.loader.remove('feature')
    await ctx.loader.update('include:feature', { disabled: true })
    expect(managedPlugins(ctx).find(row => row.entryId === 'include:feature')).toMatchObject({ enabled: false, fiberPhase: null })
  })

  it('enforces row protection at the executor and distinguishes a live override from an applied change', async () => {
    const ctx = await composition()
    provideProfileRuntime(ctx, {
      profileDir: directories.at(-1)!, bootBundles: [], pluginMutations: 'enabled',
    })
    const change = vi.fn<PluginAdminCore['setPluginEnabled']>(async (_runtime, request) => {
      await ctx.loader.update('include:feature', { disabled: !request.enabled })
      return { kind: 'saved', application: 'applied' }
    })
    class Gateway extends PluginAdminGateway {
      constructor(ctx: Context) { super(ctx, undefined, { ...nodePluginAdminCore, setPluginEnabled: change }) }
    }
    await ctx.plugin(Gateway)
    const gateway = ctx.get('pluginAdmin') as PluginAdminGateway
    const manager: EntryOptions = { id: 'manager', name: '@shres-code/shres-code-host-plugin-admin', disabled: true }
    await ctx.loader.create(manager)
    const protectedRow = gateway.listPlugins().find(row => row.entryId === 'manager')!
    await expect(gateway.setPluginEnabled({
      token: gateway.begin({ verb: 'plugin-enable', target: protectedRow.entryId }).token,
      entryId: protectedRow.entryId, enabled: true,
    })).resolves.toEqual({ kind: 'refused', code: 'management-required' })
    expect(change).not.toHaveBeenCalled()

    const feature = gateway.listPlugins().find(row => row.entryId === 'include:feature')!
    await expect(gateway.setPluginEnabled({
      token: gateway.begin({ verb: 'plugin-disable', target: feature.entryId }).token,
      entryId: feature.entryId, enabled: false,
    })).resolves.toEqual({ kind: 'saved', application: 'applied' })
    expect(change).toHaveBeenCalledWith(expect.anything(), {
      id: 'feature', moduleName: './feature.mjs', enabled: false,
    }, expect.anything())
    expect(change.mock.calls[0]?.[2].signal).toBeInstanceOf(AbortSignal)
    change.mockResolvedValue({ kind: 'saved', application: 'applied' })
    await expect(gateway.setPluginEnabled({
      token: gateway.begin({ verb: 'plugin-enable', target: feature.entryId }).token,
      entryId: feature.entryId, enabled: true,
    })).resolves.toEqual({ kind: 'saved', application: 'overridden' })
  })

  it('protects infrastructure even when its row is disabled', async () => {
    const ctx = await composition()
    const manager: EntryOptions = { id: 'manager', name: '@shres-code/shres-code-host-plugin-admin', disabled: true }
    await ctx.loader.create(manager)
    expect(managedPlugins(ctx).find(row => row.entryId === 'manager')?.readOnlyReason).toBe('management-required')
  })
})
