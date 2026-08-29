import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { openTunnel, type SshRunner } from '../src/controller.ts'
import type { } from '../src/errors.ts'
import { asRemoteId, asRemoteTarget } from '../src/registry.ts'
import type { RemoteEntry } from '../src/types.ts'

/** One fake long-lived ssh child. */
interface FakeChild { argv: readonly string[]; pid: number; disposed: boolean }

/**
 * Fabricate the runner seam: exec output depends on whether the command reads
 * the installation id or probes the daemon; spawns register killable children.
 * @param execOutput - canned stdout per remote command class.
 * @param children - handle registry recording spawned children.
 * @returns the runner plus the handle registry.
 */
function fakeRunner(execOutput: { probe?: string; installId?: string }, children: FakeChild[]): SshRunner {
  return {
    async run(argv) {
      const stdout = argv.some(arg => arg.includes('anonymous-user-id')) ? execOutput.installId ?? '' : execOutput.probe ?? ''
      return { exitCode: 0, stdout, stderr: '' }
    },
    async spawn(argv) {
      const child: FakeChild = { argv, pid: children.length + 1, disposed: false }
      children.push(child)
      return { pid: child.pid, dispose: async () => { child.disposed = true } }
    },
  }
}

/** Build one registry entry fixture. */
function entry(fingerprint: string | null = 'install-1'): RemoteEntry {
  return {
    id: asRemoteId('lab'),
    target: asRemoteTarget('ci@remote.example'),
    remotePort: 3080,
    version: 1,
    fingerprint,
    createdAt: '2026-08-29T00:00:00.000Z',
    lastConnectedAt: null,
  }
}

/**
 * Bind a one-shot describe server answering with the given version.
 * @param version - version echoed to every POST.
 * @returns the bound loopback port and the closer.
 */
async function describeServer(version: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void request
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ version }))
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()))
  const address = server.address()
  if (address === null || typeof address === 'string') { await new Promise<void>(c => server.close(() => c())); throw new Error('no tcp address') }
  return { port: address.port, close: async () => { await new Promise(c => server.close(c)) } }
}


describe('openTunnel', () => {
  it('probes, forwards, verifies through the tunnel, and returns the live handle', async () => {
    const server = await describeServer('0.1.0-rc.5')
    try {
      const children: FakeChild[] = []
      const runner = fakeRunner({ installId: 'install-1', probe: JSON.stringify({ version: '0.1.0-rc.5' }) }, children)
      const tunnel = await openTunnel(runner, { ...SPEC(), localPort: server.port }, entry(), { allowVersionSkew: false, localVersion: '0.1.0-rc.5', forceFingerprint: false })
      expect(tunnel.version).toBe('0.1.0-rc.5')
      expect(tunnel.fingerprint).toBe('install-1')
      expect(tunnel.pid).toBe(2)
      expect(children.filter(c => c.argv.includes('-N')).length).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('refuses version skew loudly and disposes the master window', async () => {
    const children: FakeChild[] = []
    const runner = fakeRunner({ probe: JSON.stringify({ version: '9.9.9' }) }, children)
    await expect(openTunnel(runner, SPEC(), entry(), { allowVersionSkew: false, localVersion: '0.1.0-rc.5', forceFingerprint: false }))
      .rejects.toMatchObject({ code: 'version-mismatch' })
    expect(children.length).toBe(1)
    expect(children[0]!.disposed).toBe(true)
  })

  it('fails when the forward does not carry describe', async () => {
    const children: FakeChild[] = []
    const runner = fakeRunner({ installId: 'install-1', probe: JSON.stringify({ version: '0.1.0-rc.5' }) }, children)
    await expect(openTunnel(runner, SPEC(), entry(), { allowVersionSkew: false, localVersion: '0.1.0-rc.5', forceFingerprint: false }))
      .rejects.toMatchObject({ code: 'tunnel-failed' })
    expect(children.every(c => c.disposed)).toBe(true)
  })

  it('checks the installation fingerprint on record', async () => {
    const server = await describeServer('0.1.0-rc.5')
    try {
      const runner = fakeRunner({ installId: 'some-other-install', probe: JSON.stringify({ version: '0.1.0-rc.5' }) }, [])
      const spec = { ...SPEC(), localPort: server.port }
      await expect(openTunnel(runner, spec, entry('different-install'), { allowVersionSkew: false, localVersion: '0.1.0-rc.5', forceFingerprint: false }))
        .rejects.toMatchObject({ code: 'fingerprint-mismatch' })
    } finally {
      await server.close()
    }
  })
})

/** Tunnel spec fixture targeting the fake remote. */
function SPEC(): {
  id: ReturnType<typeof asRemoteId>
  target: ReturnType<typeof asRemoteTarget>
  localPort: number
  remotePort: number
  controlPath: string
} {
  return {
    id: asRemoteId('lab'),
    target: asRemoteTarget('ci@remote.example'),
    localPort: 40123,
    remotePort: 3080,
    controlPath: '/tmp/lab.sock',
  }
}
