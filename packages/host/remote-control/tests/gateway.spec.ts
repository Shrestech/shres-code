import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { remoteMethods } from '@shres-code/shres-code-typert-protocol'
import { asRemoteId, asRemoteTarget, loadRegistry, resolveRegistryPath, upsertEntry } from '../src/index.ts'
import RemoteControlGateway from '../src/gateway.ts'
import type { RemoteEntry } from '../src/types.ts'

const contexts: Context[] = []
const savedHome = process.env['SHRES_HOME']

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (savedHome === undefined) delete process.env['SHRES_HOME']
  else process.env['SHRES_HOME'] = savedHome
})

async function harness(): Promise<{ home: string; gateway: RemoteControlGateway; registry: string }> {
  const home = await mkdtemp(join(tmpdir(), 'shres-remote-gateway-'))
  await mkdir(join(home, 'remote'), { recursive: true })
  process.env['SHRES_HOME'] = home
  const registry = resolveRegistryPath()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(RemoteControlGateway)
  const gateway = ctx.get('remoteControl') as RemoteControlGateway
  if (!(gateway instanceof RemoteControlGateway)) throw new Error('gateway not mounted under remoteControl')
  return { home, gateway, registry }
}

/** One registry entry fixture for the gateway projection. */
function entry(id: 'lab' | 'prod'): RemoteEntry {
  return {
    id: asRemoteId(id),
    target: asRemoteTarget('ci@remote.example'),
    remotePort: 3080,
    version: 1,
    fingerprint: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    lastConnectedAt: null,
  }
}

describe('RemoteControlGateway', () => {
  it('publishes one direct list method under the remoteControl namespace', async () => {
    const { gateway } = await harness()
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'remoteControl', namespace: 'remoteControl' })
    expect(remoteMethods(gateway)).toEqual([{ method: 'list', invocation: { kind: 'direct' } }])
  })

  it('projects registry entries and reports a missing file as empty', async () => {
    const { gateway, registry } = await harness()
    expect(await gateway.list()).toEqual({ entries: [] })
    await upsertEntry(registry, entry('lab'))
    const { entries } = await gateway.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'lab', target: 'ci@remote.example', remotePort: 3080 })
    await loadRegistry(registry)
  })
})
