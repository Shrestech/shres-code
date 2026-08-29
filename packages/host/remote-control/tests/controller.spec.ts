import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { openTunnel, type SshRunner } from '../src/controller.ts'
import { asRemoteId, asRemoteTarget } from '../src/registry.ts'
import type { RemoteEntry } from '../src/types.ts'

/** One fake long-lived ssh child. */
interface FakeChild { argv: readonly string[]; pid: number; disposed: boolean }

/** One canned describe answer in the real envelope, or empty output. */
const ANSWER_LAB = JSON.stringify({ result: { value: { version: '0.1.0-rc.5', cwd: '/srv' } } })
const ANSWER_SKEW = JSON.stringify({ result: { value: { version: '9.9.9' } } })

/**
 * Fabricate the runner seam: exec output depends on whether the command reads
 * the installation id or probes the daemon (probe answers pop from the queue
 * so retry behavior is scriptable); spawns register killable children.
 * @param execOutput - canned stdout per remote command class.
 * @param children - handle registry recording spawned children.
 * @returns the runner plus the handle registry.
 */
function fakeRunner(
  execOutput: { probe?: string; installId?: string; probeQueue?: string[] },
  children: FakeChild[],
): SshRunner {
  return {
    async run(argv) {
      if (argv.some(arg => arg.includes('anonymous-user-id'))) {
        return { exitCode: 0, stdout: execOutput.installId ?? '', stderr: '' }
      }
      if (execOutput.probeQueue !== undefined) {
        return { exitCode: 0, stdout: execOutput.probeQueue.shift() ?? '', stderr: '' }
      }
      return { exitCode: 0, stdout: execOutput.probe ?? '', stderr: '' }
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
 * Bind a one-shot describe server answering the envelope with the given
 * version — the same body shape the real `host.describe` endpoint returns.
 * @param version - version echoed to every POST inside `result.value`.
 * @returns the bound loopback port and the closer.
 */
async function describeServer(version: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void request
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ result: { value: { version } } }))
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
      const runner = fakeRunner({ installId: 'install-1', probe: ANSWER_LAB }, children)
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
    const runner = fakeRunner({ probe: ANSWER_SKEW }, children)
    await expect(openTunnel(runner, SPEC(), entry(), { allowVersionSkew: false, localVersion: '0.1.0-rc.5', forceFingerprint: false }))
      .rejects.toMatchObject({ code: 'version-mismatch' })
    expect(children.length).toBe(1)
    expect(children[0]!.disposed).toBe(true)
  })

  it('tolerates version skew only under the flag', async () => {
    const server = await describeServer('0.1.0-rc.5')
    try {
      const runner = fakeRunner({ installId: 'install-1', probe: ANSWER_SKEW }, [])
      const spec = { ...SPEC(), localPort: server.port }
      const tunnel = await openTunnel(runner, spec, entry(), { allowVersionSkew: true, localVersion: '0.1.0-rc.5', forceFingerprint: false })
      expect(tunnel.version).toBe('9.9.9')
      expect(tunnel.fingerprint).toBe('install-1')
    } finally {
      await server.close()
    }
  })

  it('retries a silent probe and recovers once describe answers', async () => {
    const server = await describeServer('0.1.0-rc.5')
    try {
      const runner = fakeRunner({ installId: 'install-1', probeQueue: ['', '', ANSWER_LAB] }, [])
      const tunnel = await openTunnel(runner, { ...SPEC(), localPort: server.port }, entry(), { allowVersionSkew: false, localVersion: '0.1.0-rc.5', forceFingerprint: false })
      expect(tunnel.version).toBe('0.1.0-rc.5')
    } finally {
      await server.close()
    }
  })

  it('fails typed after probe attempts are exhausted', async () => {
    const children: FakeChild[] = []
    const runner = fakeRunner({ installId: 'install-1', probeQueue: ['', '', '', '', '', ''] }, children)
    await expect(openTunnel(runner, SPEC(), entry(), { allowVersionSkew: false, localVersion: '0.1.0-rc.5', forceFingerprint: false }))
      .rejects.toMatchObject({ code: 'probe-failed' })
    expect(children.every(c => c.disposed)).toBe(true)
  })

  it('fails when the forward does not carry describe', async () => {
    const children: FakeChild[] = []
    const runner = fakeRunner({ installId: 'install-1', probe: ANSWER_LAB }, children)
    await expect(openTunnel(runner, SPEC(), entry(), { allowVersionSkew: false, localVersion: '0.1.0-rc.5', forceFingerprint: false }))
      .rejects.toMatchObject({ code: 'tunnel-failed' })
    expect(children.every(c => c.disposed)).toBe(true)
  })

  it('checks the installation fingerprint on record', async () => {
    const server = await describeServer('0.1.0-rc.5')
    try {
      const runner = fakeRunner({ installId: 'some-other-install', probe: ANSWER_LAB }, [])
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
