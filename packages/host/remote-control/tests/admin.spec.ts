import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { remoteMethods } from '@shres-code/shres-code-typert-protocol'
import { RemoteControlError } from '../src/errors.ts'
import RemoteAdminGateway from '../src/admin.ts'
import type { AdminConfig } from '../src/admin.ts'
import type { SshRunner } from '../src/controller.ts'
import { asRemoteId, asRemoteTarget, loadRegistry } from '../src/registry.ts'
import type { TunnelStateView } from '../src/types.ts'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const ANSWER_LAB = JSON.stringify({ result: { value: { version: '0.1.0-rc.5' } } })
const ANSWER_SKEW = JSON.stringify({ result: { value: { version: '9.9.9' } } })

/** One fake long-lived ssh child, with the describe server it carries. */
interface FakeChild {
  argv: readonly string[]
  disposed: boolean
  /** Simulate the child's own death; observed through the spawn's onExit. */
  exit(code: number | null): Promise<void>
}

/**
 * Fabricate the runner seam: exec output follows the controller.spec classes
 * (probe, probe queue, installation id); a `-N` spawn parses its `-L` forward
 * and, when given a forwardVersion, really serves the describe envelope on
 * the allocated local port so the gateway's verify probe passes.
 */
function fabricatedRunner(options: {
  probe?: string
  probeQueue?: string[]
  installId?: string
  forwardVersion?: string
  spawnFailure?: unknown
}): SshRunner & { children: FakeChild[] } {
  const children: FakeChild[] = []
  const servers: Server[] = []
  return {
    children,
    async run(argv) {
      if (argv.some(arg => arg.includes('anonymous-user-id'))) {
        return { exitCode: 0, stdout: options.installId ?? '', stderr: '' }
      }
      if (options.probeQueue !== undefined) {
        return { exitCode: 0, stdout: options.probeQueue.shift() ?? '', stderr: '' }
      }
      return { exitCode: 0, stdout: options.probe ?? '', stderr: '' }
    },
    spawn(argv, onExit) {
      if (options.spawnFailure !== undefined) {
        throw options.spawnFailure
      }
      const forwardIndex = argv.indexOf('-N')
      const localPort = forwardIndex >= 0 ? Number.parseInt(argv[argv.indexOf('-L') + 1]!.split(':')[0]!, 10) : 0
      return new Promise((resolveSpawn) => {
        const closeServer = async (): Promise<void> => {
          const server = servers.pop()
          if (server === undefined) return
          await new Promise<void>((closeDone) => { server.close(() => { closeDone() }) })
        }
        const finish = (): void => {
          const child: FakeChild = {
            argv,
            disposed: false,
            exit: async (code) => {
              await closeServer()
              onExit?.(code)
            },
          }
          children.push(child)
          resolveSpawn({
            pid: 4242,
            dispose: async () => {
              if (child.disposed) return
              child.disposed = true
              await closeServer()
              onExit?.(null)
            },
          })
        }
        if (forwardIndex < 0 || options.forwardVersion === undefined) {
          finish()
          return
        }
        const server = createServer((request, response) => {
          void request
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ result: { value: { version: options.forwardVersion } } }))
        })
        servers.push(server)
        server.listen(localPort, '127.0.0.1', () => { finish() })
      })
    },
  }
}

/** Boot the gateway over isolated registry/run dirs and the fabricated runner. */
async function harness(
  runner: SshRunner & { children?: FakeChild[] },
  config: { registryPath?: string; runDir?: string } = {},
): Promise<{
  gateway: RemoteAdminGateway
  registryPath: string
  runDir: string
  views: TunnelStateView[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'shres-admin-gateway-'))
  tempDirs.push(root)
  await mkdir(join(root, 'remote'), { recursive: true })
  const registryPath = config.registryPath ?? join(root, 'remote', 'remotes.json')
  const runDir = config.runDir ?? join(root, 'remote', 'run')
  const views: TunnelStateView[] = []
  const ctx = new Context()
  ctx.on('remote-control/tunnel-state', (view) => { views.push(view) })
  contexts.push(ctx)
  // cordis plugin constructors take (ctx, config) only, so the fabricated
  // runner rides a subclass instead of a third argument.
  class TestGateway extends RemoteAdminGateway {
    constructor(ctx: Context, config?: AdminConfig) {
      super(ctx, config, runner)
    }
  }
  await ctx.plugin(TestGateway, { registryPath, runDir, sshCommand: 'unused-with-fake-runner' })
  const gateway = ctx.get('remoteAdmin') as RemoteAdminGateway
  if (!(gateway instanceof RemoteAdminGateway)) throw new Error('gateway not mounted under remoteAdmin')
  return { gateway, registryPath, runDir, views }
}

/** Mint a grant for one verb/alias pair. */
async function grant(gateway: RemoteAdminGateway, verb: 'connect' | 'disconnect' | 'add' | 'edit' | 'remove', alias: string | null): Promise<string> {
  return gateway.begin({ verb, alias }).token
}

/** Seed the lab alias through the gateway's own add, like the UI flow. */
async function seedLab(gateway: RemoteAdminGateway): Promise<void> {
  await gateway.add({ token: await grant(gateway, 'add', null), alias: 'lab', target: 'ci@remote.example', remotePort: 3080 })
}

describe('RemoteAdminGateway', () => {
  it('exposes the eight methods as direct Remote calls', async () => {
    const { gateway } = await harness(fabricatedRunner({}))
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'remoteAdmin', namespace: 'remoteAdmin' })
    expect(remoteMethods(gateway).map(marker => marker.method)).toEqual([
      'begin', 'inspect', 'connect', 'disconnect', 'add', 'edit', 'remove', 'status',
    ])
  })

  it('begin refuses alias shapes that contradict the verb', async () => {
    const { gateway } = await harness(fabricatedRunner({}))
    expect(() => gateway.begin({ verb: 'connect', alias: null })).toThrow(/needs an alias/)
    expect(() => gateway.begin({ verb: 'add', alias: 'lab' })).toThrow(/pass alias null/)
  })

  it('connects through the full chain: outcome, registry facts, marker, events, status', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_LAB, installId: 'install-1', forwardVersion: '0.1.0-rc.5' })
    const { gateway, registryPath, runDir, views } = await harness(runner)
    await seedLab(gateway)
    const outcome = await gateway.connect({
      token: await grant(gateway, 'connect', 'lab'),
      alias: 'lab',
      allowVersionSkew: false,
      forceFingerprint: false,
    })
    expect(outcome).toMatchObject({ status: 'connected', version: '0.1.0-rc.5', fingerprint: 'install-1' })
    if (outcome.status !== 'connected') throw new Error('unreachable arm')
    const entries = await loadRegistry(registryPath)
    expect(entries.get(asRemoteId('lab'))).toMatchObject({ fingerprint: 'install-1' })
    expect(entries.get(asRemoteId('lab'))!.lastConnectedAt).not.toBeNull()
    expect(await readFile(join(runDir, 'lab.pid'), 'utf8')).toBe('4242\n')
    expect(views.map(view => view.state)).toEqual(['connecting', 'open'])
    expect(gateway.status()).toMatchObject({ tunnels: [{ alias: 'lab', state: 'open', localPort: outcome.localPort }] })
  })

  it('connect is idempotent per alias while the tunnel is open', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_LAB, installId: 'install-1', forwardVersion: '0.1.0-rc.5' })
    const { gateway } = await harness(runner)
    await seedLab(gateway)
    const first = await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    const second = await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    expect(first.status).toBe('connected')
    expect(second).toEqual(first)
    expect(runner.children).toHaveLength(2)
  })

  it('answers version skew as outcome data and still connects only under the flag', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_SKEW, installId: 'install-1', forwardVersion: '9.9.9' })
    const { gateway, views } = await harness(runner)
    await seedLab(gateway)
    const skewed = await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    expect(skewed).toEqual({ status: 'version-mismatch', observed: '9.9.9', local: '0.1.0-rc.5' })
    expect(views.at(-1)).toMatchObject({ state: 'error' })
    const tolerated = await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: true, forceFingerprint: false })
    expect(tolerated).toMatchObject({ status: 'connected', version: '9.9.9' })
  })

  it('answers a changed installation as outcome data, or connects by force', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_LAB, installId: 'install-2', forwardVersion: '0.1.0-rc.5' })
    const { gateway, registryPath } = await harness(runner)
    const { upsertEntry, REGISTRY_VERSION } = await import('../src/registry.ts')
    await upsertEntry(registryPath, {
      id: asRemoteId('lab'),
      target: asRemoteTarget('ci@remote.example'),
      remotePort: 3080,
      version: REGISTRY_VERSION,
      fingerprint: 'install-1',
      createdAt: '2026-08-29T00:00:00.000Z',
      lastConnectedAt: null,
    })
    const refused = await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    expect(refused).toEqual({ status: 'fingerprint-mismatch', observed: 'install-2', trusted: 'install-1' })
    const forced = await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: true })
    expect(forced).toMatchObject({ status: 'connected', fingerprint: 'install-2' })
  })

  it('answers a silent installation id as a fingerprint mismatch with a null observation', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_LAB, installId: '', forwardVersion: '0.1.0-rc.5' })
    const { gateway, registryPath } = await harness(runner)
    const { upsertEntry, REGISTRY_VERSION } = await import('../src/registry.ts')
    await upsertEntry(registryPath, {
      id: asRemoteId('lab'),
      target: asRemoteTarget('ci@remote.example'),
      remotePort: 3080,
      version: REGISTRY_VERSION,
      fingerprint: 'install-1',
      createdAt: '2026-08-29T00:00:00.000Z',
      lastConnectedAt: null,
    })
    const outcome = await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    expect(outcome).toEqual({ status: 'fingerprint-mismatch', observed: null, trusted: 'install-1' })
  })

  it('answers an unreachable daemon as staged outcome data', async () => {
    const silent = fabricatedRunner({ probeQueue: ['', '', '', '', '', ''], installId: 'install-1', forwardVersion: '0.1.0-rc.5' })
    const { gateway } = await harness(silent)
    await seedLab(gateway)
    const probe = await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    expect(probe).toMatchObject({ status: 'unreachable', stage: 'probe' })
    if (probe.status !== 'unreachable') throw new Error('unreachable arm')
    expect(probe.message).toContain('host.describe')
  })

  it('maps a dead forward to the tunnel stage', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_LAB, installId: 'install-1' })
    const { gateway } = await harness(runner)
    await seedLab(gateway)
    const outcome = await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    expect(outcome).toMatchObject({ status: 'unreachable', stage: 'tunnel' })
  })

  it('keeps internal spawn failures as wire errors, not outcomes', async () => {
    const runner = fabricatedRunner({ spawnFailure: 'ssh spawn failed: exploded' })
    const { gateway, views } = await harness(runner)
    await seedLab(gateway)
    await expect(gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false }))
      .rejects.toBe('ssh spawn failed: exploded')
    expect(views.at(-1)).toMatchObject({ state: 'error', error: 'ssh spawn failed: exploded' })
  })

  it('refuses a connect for an unregistered alias as a caller error', async () => {
    const { gateway } = await harness(fabricatedRunner({}))
    await expect(gateway.connect({ token: await grant(gateway, 'connect', 'ghost'), alias: 'ghost', allowVersionSkew: false, forceFingerprint: false }))
      .rejects.toThrow(/not registered/)
  })

  it('keeps typed failures outside the decision set as wire errors', async () => {
    const runner = fabricatedRunner({})
    runner.run = async () => { throw new RemoteControlError('gesture-refused', 'probe seam exploded') }
    const { gateway, views } = await harness(runner)
    await seedLab(gateway)
    await expect(gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false }))
      .rejects.toThrow(/probe seam exploded/)
    expect(views.at(-1)).toMatchObject({ state: 'error', error: 'probe seam exploded' })
  })

  it('spends each gesture exactly once and refuses missing or out-of-scope tokens', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_LAB, installId: 'install-1', forwardVersion: '0.1.0-rc.5' })
    const { gateway } = await harness(runner)
    await seedLab(gateway)
    const token = await grant(gateway, 'connect', 'lab')
    await gateway.connect({ token, alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    await expect(gateway.connect({ token, alias: 'lab', allowVersionSkew: false, forceFingerprint: false }))
      .rejects.toThrow(/gesture token/)
    await expect(gateway.connect({ token: 'deadbeef', alias: 'lab', allowVersionSkew: false, forceFingerprint: false }))
      .rejects.toThrow(/gesture token/)
    await expect(gateway.remove({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab' }))
      .rejects.toThrow(/gesture token/)

    // An add grant is scoped to the not-yet-existing alias (null), and its
    // refusal message names that shape.
    const addToken = await grant(gateway, 'add', null)
    await gateway.add({ token: addToken, alias: 'prod', target: 'ci@remote.example', remotePort: 3080 })
    await expect(gateway.add({ token: addToken, alias: 'prod', target: 'ci@remote.example', remotePort: 3080 }))
      .rejects.toThrow(/<new alias>/)
  })

  it('add, edit, and remove mutate the registry under their own grants', async () => {
    const { gateway, registryPath } = await harness(fabricatedRunner({}))
    const added = await gateway.add({ token: await grant(gateway, 'add', null), alias: 'lab', target: 'ci@remote.example', remotePort: 3080 })
    expect(added.entry).toMatchObject({ id: 'lab', target: 'ci@remote.example', remotePort: 3080, fingerprint: null })
    const edited = await gateway.edit({ token: await grant(gateway, 'edit', 'lab'), alias: 'lab', target: 'build@remote.example', remotePort: 3081 })
    expect(edited.entry).toMatchObject({ id: 'lab', target: 'build@remote.example', remotePort: 3081 })
    const removed = await gateway.remove({ token: await grant(gateway, 'remove', 'lab'), alias: 'lab' })
    expect(removed).toEqual({ status: 'removed', removed: true })
    expect(await loadRegistry(registryPath)).toHaveLength(0)
  })

  it('edit preserves the identity and history an add or connect wrote', async () => {
    const { gateway, registryPath } = await harness(fabricatedRunner({}))
    await gateway.add({ token: await grant(gateway, 'add', null), alias: 'lab', target: 'ci@remote.example', remotePort: 3080 })
    const { upsertEntry, REGISTRY_VERSION } = await import('../src/registry.ts')
    await upsertEntry(registryPath, {
      id: asRemoteId('lab'),
      target: asRemoteTarget('ci@remote.example'),
      remotePort: 3080,
      version: REGISTRY_VERSION,
      fingerprint: 'install-1',
      createdAt: '2026-08-29T00:00:00.000Z',
      lastConnectedAt: '2026-08-30T00:00:00.000Z',
    })
    const edited = await gateway.edit({ token: await grant(gateway, 'edit', 'lab'), alias: 'lab', target: 'build@remote.example', remotePort: 3081 })
    expect(edited.entry).toMatchObject({
      target: 'build@remote.example', remotePort: 3081,
      fingerprint: 'install-1', createdAt: '2026-08-29T00:00:00.000Z', lastConnectedAt: '2026-08-30T00:00:00.000Z',
    })
  })

  it('refuses a remove while the alias tunnel is live, with outcome data', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_LAB, installId: 'install-1', forwardVersion: '0.1.0-rc.5' })
    const { gateway, registryPath } = await harness(runner)
    await seedLab(gateway)
    await gateway.add({ token: await grant(gateway, 'add', null), alias: 'lab', target: 'ci@remote.example', remotePort: 3080 })
    await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    const refused = await gateway.remove({ token: await grant(gateway, 'remove', 'lab'), alias: 'lab' })
    expect(refused).toEqual({ status: 'connected' })
    expect(await loadRegistry(registryPath)).toHaveLength(1)
  })

  it('disconnect closes the live tunnel and reports not-connected otherwise', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_LAB, installId: 'install-1', forwardVersion: '0.1.0-rc.5' })
    const { gateway, runDir, views } = await harness(runner)
    await seedLab(gateway)
    expect(await gateway.disconnect({ token: await grant(gateway, 'disconnect', 'lab'), alias: 'lab' }))
      .toEqual({ state: 'not-connected' })
    await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    expect(await gateway.disconnect({ token: await grant(gateway, 'disconnect', 'lab'), alias: 'lab' }))
      .toEqual({ state: 'closed' })
    await expect(readFile(join(runDir, 'lab.pid'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(views.at(-1)).toMatchObject({ state: 'closed' })
    expect(gateway.status()).toMatchObject({ tunnels: [{ state: 'closed' }] })
  })

  it('observes the forward child exit on its own and republishes closed', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_LAB, installId: 'install-1', forwardVersion: '0.1.0-rc.5' })
    const { gateway, runDir, views } = await harness(runner)
    await seedLab(gateway)
    await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    const forward = runner.children.find(child => child.argv.includes('-N'))
    if (forward === undefined) throw new Error('no forward child recorded')
    await forward.exit(0)
    expect(gateway.status()).toMatchObject({ tunnels: [{ state: 'closed' }] })
    // The exit observation clears the marker asynchronously; poll for the removal.
    await expect.poll(
      async () => readFile(join(runDir, 'lab.pid'), 'utf8').then(() => 'present', () => 'gone'),
      { timeout: 2_000 },
    ).toBe('gone')
    expect(views.map(view => view.state)).toEqual(['connecting', 'open', 'closed'])
  })

  it('ends the process tunnels when the plugin fiber disposes', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_LAB, installId: 'install-1', forwardVersion: '0.1.0-rc.5' })
    const { gateway, runDir } = await harness(runner)
    await seedLab(gateway)
    await gateway.connect({ token: await grant(gateway, 'connect', 'lab'), alias: 'lab', allowVersionSkew: false, forceFingerprint: false })
    const ctx = contexts[contexts.length - 1]!
    await ctx.fiber.dispose()
    contexts.pop()
    expect(runner.children.every(child => child.disposed)).toBe(true)
    await expect(readFile(join(runDir, 'lab.pid'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('inspect reports the trust-modal facts with null as the unreachable datum', async () => {
    const runner = fabricatedRunner({ probe: ANSWER_LAB, installId: 'install-9' })
    const { gateway, registryPath } = await harness(runner)
    const { upsertEntry, REGISTRY_VERSION } = await import('../src/registry.ts')
    await upsertEntry(registryPath, {
      id: asRemoteId('lab'),
      target: asRemoteTarget('ci@remote.example'),
      remotePort: 3080,
      version: REGISTRY_VERSION,
      fingerprint: 'install-1',
      createdAt: '2026-08-29T00:00:00.000Z',
      lastConnectedAt: null,
    })
    const facts = await gateway.inspect({ alias: 'lab' })
    expect(facts).toMatchObject({
      target: 'ci@remote.example', daemonVersion: '0.1.0-rc.5', installationId: 'install-9',
      localVersion: '0.1.0-rc.5', firstConnect: false, trustedFingerprint: 'install-1',
    })
    const silent = await harness(fabricatedRunner({}))
    await silent.gateway.add({ token: await grant(silent.gateway, 'add', null), alias: 'lab', target: 'ci@remote.example', remotePort: 3080 })
    expect(await silent.gateway.inspect({ alias: 'lab' })).toMatchObject({
      daemonVersion: null, installationId: null, firstConnect: true, trustedFingerprint: null,
    })
  })

  it('resolves every default through the owning resolvers when no config arrives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shres-admin-defaults-'))
    tempDirs.push(root)
    await mkdir(join(root, 'remote'), { recursive: true })
    const savedHome = process.env['SHRES_HOME']
    process.env['SHRES_HOME'] = root
    try {
      const ctx = new Context()
      contexts.push(ctx)
      // No config and no injected runner: the production resolution paths and
      // the node adapter both come from the gateway itself. `add` writes only.
      await ctx.plugin(RemoteAdminGateway, {})
      const gateway = ctx.get('remoteAdmin') as RemoteAdminGateway
      await gateway.add({ token: await grant(gateway, 'add', null), alias: 'lab', target: 'ci@remote.example', remotePort: 3080 })
      expect(await loadRegistry(join(root, 'remote', 'remotes.json'))).toHaveLength(1)
    } finally {
      if (savedHome === undefined) delete process.env['SHRES_HOME']
      else process.env['SHRES_HOME'] = savedHome
    }
  })
})
