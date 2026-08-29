import { describe, expect, it } from 'vitest'
import { installationIdCommand, masterArgv, parseProbeVersion, probeCommand, tunnelArgv } from '../src/ssh-args.ts'
import { asRemoteId, asRemoteTarget } from '../src/registry.ts'

describe('tunnel argv contract', () => {
  const spec = {
    id: asRemoteId('lab'),
    target: asRemoteTarget('ci@remote.example'),
    localPort: 40123,
    remotePort: 3080,
    controlPath: '/home/u/.shres/remote/run/lab.sock',
  }

  it('spawns the tunnel with ExitOnForwardFailure, keepalives, and the same master socket', () => {
    expect(tunnelArgv(spec)).toEqual([
      'ssh',
      '-N',
      '-L', '40123:127.0.0.1:3080',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ControlPath=/home/u/.shres/remote/run/lab.sock',
      'ci@remote.example',
    ])
  })

  it('opens the master with multiplexing and never disables the user ssh config', () => {
    const argv = masterArgv(spec)
    expect(argv[0]).toBe('ssh')
    expect(argv).toContain('-M')
    expect(argv).toContain('ControlPersist=600')
    expect(argv).not.toContain('-F')
    expect(argv.at(-1)).toBe('ci@remote.example')
  })

  it('refuses shell-hostile targets at argv construction', () => {
    expect(() => tunnelArgv({ ...spec, target: '-oProxyCommand=evil' as never })).toThrow()
  })
})

describe('remote commands', () => {
  it('probes the daemon on the remote loopback with a short timeout', () => {
    expect(probeCommand(3080)).toBe('curl -sS -m 2 -X POST http://127.0.0.1:3080/api/host.describe 2>&1')
  })

  it('reads the installation id tolerating both home layouts and absence', () => {
    expect(installationIdCommand()).toContain('SHRES_HOME')
    expect(installationIdCommand()).toContain('.anonymous-user-id')
    expect(installationIdCommand().endsWith('|| true')).toBe(true)
  })
})

describe('probe parsing', () => {
  it('extracts the version from a plain describe body', () => {
    expect(parseProbeVersion('{"version":"0.1.0-rc.5"}')).toBe('0.1.0-rc.5')
  })

  it('returns null for garbage, stderr noise, and versionless bodies', () => {
    expect(parseProbeVersion('curl: (7) Failed to connect')).toBeNull()
    expect(parseProbeVersion('')).toBeNull()
    expect(parseProbeVersion('{"cwd":"/tmp"}')).toBeNull()
  })
})
