import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LiveTunnel } from '../src/controller.ts'
import { TunnelManager } from '../src/tunnel-manager.ts'
import { asRemoteId, asRemoteTarget } from '../src/registry.ts'
import type { TunnelSpec, TunnelStateView } from '../src/types.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** One disposable live-tunnel fixture. */
function fakeTunnel(pid = 42): LiveTunnel & { disposed: boolean } {
  const handle = {
    pid,
    version: '0.1.0-rc.5',
    fingerprint: 'install-1',
    disposed: false,
    dispose: async (): Promise<void> => { handle.disposed = true },
  }
  return handle
}

async function harness(): Promise<{
  runDir: string
  manager: TunnelManager
  views: TunnelStateView[]
  spec: TunnelSpec
}> {
  const runDir = await mkdtemp(join(tmpdir(), 'shres-tunnel-manager-'))
  tempDirs.push(runDir)
  const views: TunnelStateView[] = []
  const manager = new TunnelManager({ runDir, publish: (view) => { views.push(view) } })
  const spec: TunnelSpec = {
    id: asRemoteId('lab'),
    target: asRemoteTarget('ci@remote.example'),
    localPort: 40123,
    remotePort: 3080,
    controlPath: join(runDir, 'lab.sock'),
  }
  return { runDir, manager, views, spec }
}

describe('TunnelManager', () => {
  it('publishes a connecting view with no bound facts yet', async () => {
    const { manager, views, spec } = await harness()
    manager.connecting(spec.id, spec)
    expect(manager.view(spec.id)).toMatchObject({ alias: 'lab', state: 'connecting', localPort: null, version: null, error: null })
    expect(views).toHaveLength(1)
  })

  it('commits a verified open: view facts, PID marker under the run dir', async () => {
    const { manager, views, spec, runDir } = await harness()
    manager.connecting(spec.id, spec)
    await manager.opened(spec.id, spec, fakeTunnel(4242), '0.1.0-rc.5', 'install-1')
    expect(manager.view(spec.id)).toMatchObject({
      state: 'open', localPort: 40123, version: '0.1.0-rc.5', fingerprint: 'install-1', error: null,
    })
    expect(await readFile(join(runDir, 'lab.pid'), 'utf8')).toBe('4242\n')
    expect(views.map(view => view.state)).toEqual(['connecting', 'open'])
    expect(manager.isLive(spec.id)).toBe(true)
  })

  it('commits a failed attempt as an error view and keeps no handle', async () => {
    const { manager, spec } = await harness()
    manager.connecting(spec.id, spec)
    manager.failed(spec.id, spec, 'no host.describe answered on the remote')
    expect(manager.view(spec.id)).toMatchObject({ state: 'error', error: 'no host.describe answered on the remote' })
    expect(manager.isLive(spec.id)).toBe(false)
  })

  it('publishes the closed state and clears the marker when the forward exits', async () => {
    const { manager, spec, runDir } = await harness()
    manager.connecting(spec.id, spec)
    await manager.opened(spec.id, spec, fakeTunnel(), '0.1.0-rc.5', 'install-1')
    await manager.exited(spec.id, spec, 0)
    expect(manager.view(spec.id)).toMatchObject({ state: 'closed', localPort: 40123 })
    await expect(readFile(join(runDir, 'lab.pid'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(manager.isLive(spec.id)).toBe(false)
  })

  it('ignores stale exit observations', async () => {
    const { manager, views, spec } = await harness()
    await manager.exited(asRemoteId('ghost'), spec, 0)
    manager.connecting(spec.id, spec)
    await manager.exited(spec.id, spec, 0)
    expect(manager.view(spec.id)!.state).toBe('connecting')
    expect(views).toHaveLength(1)
  })

  it('disconnect disposes the caller handle, clears the marker, and publishes closed', async () => {
    const { manager, spec, runDir, views } = await harness()
    expect(await manager.disconnect(spec.id)).toBe(false)
    const tunnel = fakeTunnel()
    manager.connecting(spec.id, spec)
    await manager.opened(spec.id, spec, tunnel, '0.1.0-rc.5', 'install-1')
    expect(await manager.disconnect(spec.id)).toBe(true)
    expect(tunnel.disposed).toBe(true)
    // The disposer-driven exit no-ops against the committed record: exactly
    // one closed publication for the committed transition.
    expect(views.filter(view => view.state === 'closed')).toHaveLength(1)
    expect(manager.view(spec.id)).toMatchObject({ state: 'closed' })
    await expect(readFile(join(runDir, 'lab.pid'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('disposes a displaced handle when a second open commits over it', async () => {
    const { manager, views, spec } = await harness()
    const first = fakeTunnel(11)
    const second = fakeTunnel(22)
    manager.connecting(spec.id, spec)
    await manager.opened(spec.id, spec, first, '0.1.0-rc.5', 'install-1')
    // A concurrently granted connect commits its open over the first one.
    manager.connecting(spec.id, spec)
    await manager.opened(spec.id, spec, second, '0.2.0', 'install-2')
    expect(first.disposed).toBe(true)
    expect(second.disposed).toBe(false)
    expect(manager.isLive(spec.id)).toBe(true)
    // The displaced attempt's own exit is stale and must not close the winner.
    await manager.exited(spec.id, { ...spec }, 0)
    expect(manager.view(spec.id)).toMatchObject({ state: 'open' })
    await manager.exited(spec.id, spec, 0)
    expect(manager.view(spec.id)).toMatchObject({ state: 'closed' })
    expect(views.map(view => view.state)).toEqual(['connecting', 'open', 'connecting', 'open', 'closed'])
  })

  it('views() projects every tracked alias and view() reports unknown aliases as null', async () => {
    const { manager, spec } = await harness()
    expect(manager.view(asRemoteId('ghost'))).toBeNull()
    expect(manager.views()).toEqual([])
    manager.connecting(spec.id, spec)
    expect(manager.views()).toHaveLength(1)
  })

  it('disposeAll ends every live tunnel and clears every marker', async () => {
    const { manager, views, spec, runDir } = await harness()
    const tunnel = fakeTunnel()
    manager.connecting(spec.id, spec)
    await manager.opened(spec.id, spec, tunnel, '0.1.0-rc.5', 'install-1')
    manager.connecting(asRemoteId('prod'), { ...spec, id: asRemoteId('prod') })
    await manager.disposeAll()
    expect(tunnel.disposed).toBe(true)
    // A still-connecting alias owns no handle yet, so disposeAll leaves it alone.
    expect(manager.views().map(view => view.state)).toEqual(['closed', 'connecting'])
    await expect(readFile(join(runDir, 'lab.pid'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(views.at(-1)).toMatchObject({ state: 'closed' })
  })
})
