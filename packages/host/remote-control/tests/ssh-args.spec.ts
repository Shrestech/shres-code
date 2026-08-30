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
    expect(argv[0]).toBe('-M')
    expect(argv).toContain('ControlPersist=600')
    expect(argv).not.toContain('-F')
    expect(argv.at(-1)).toBe('ci@remote.example')
  })

  it('refuses shell-hostile targets at argv construction', () => {
    expect(() => tunnelArgv({ ...spec, target: '-oProxyCommand=evil' as never })).toThrow()
  })

  it('refuses leading-dash users (ssh option smuggling), not just flag-pairs', () => {
    expect(() => tunnelArgv({ ...spec, target: '-lroot@example.com' as never })).toThrow()
    expect(() => masterArgv({ ...spec, target: '-F/tmp/other' as never })).toThrow()
  })
})

describe('remote commands', () => {
  it('probes describe with the client-request envelope the real handler dispatches', () => {
    const command = probeCommand(3080)
    expect(command).toContain('-X POST http://127.0.0.1:3080/api/host.describe')
    expect(command).toContain("-H 'Content-Type: application/json'")
    expect(command).toContain('-d \'{"type":"client-request","rpcId":"remote-connect-probe","method":"host.describe","payload":{}}\'')
  })

  it('reads the installation id tolerating both home layouts and absence', () => {
    expect(installationIdCommand()).toContain('SHRES_HOME')
    expect(installationIdCommand()).toContain('.anonymous-user-id')
    expect(installationIdCommand().endsWith('|| true')).toBe(true)
  })
})

describe('probe parsing', () => {
  it('extracts the version from the real ServerResponse envelope', () => {
    expect(parseProbeVersion('{"result":{"type":"ok","value":{"version":"0.1.0-rc.5","cwd":"/srv"}}}')).toBe('0.1.0-rc.5')
  })

  it('returns null for garbage, stderr noise, and versionless bodies', () => {
    expect(parseProbeVersion('curl: (7) Failed to connect')).toBeNull()
    expect(parseProbeVersion('')).toBeNull()
    expect(parseProbeVersion('{"cwd":"/tmp"}')).toBeNull()
    expect(parseProbeVersion('{"result":{"value":{"version":42}}}')).toBeNull()
    expect(parseProbeVersion('{"error":{"message":"refused"}}')).toBeNull()
  })
})
