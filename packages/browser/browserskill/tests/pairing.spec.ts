/** Pairing link and device parsing, and the runtime mode record. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDevices, parsePairingLink } from '../src/runtime/pairing.ts'
import { RUNTIME_STATE_FILE, readRuntimeState, writeRuntimeState } from '../src/runtime/mode.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function ownedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'shres-bsk-mode-'))
  roots.push(root)
  return root
}

describe('pairing link', () => {
  it('reads the device id out of a local link', () => {
    expect(parsePairingLink('ws://127.0.0.1:52902/#bsk-local.v1.device-1.secret.mac')).toEqual({
      url: 'ws://127.0.0.1:52902/#bsk-local.v1.device-1.secret.mac',
      deviceId: 'device-1',
    })
  })

  it('refuses a remote or unshaped line', () => {
    expect(parsePairingLink('ws://example.com:52800/#bsk-local.v1.d.s')).toBeUndefined()
    expect(parsePairingLink('pairing started')).toBeUndefined()
    expect(parsePairingLink('ws://127.0.0.1:52902/#bsk-local.v1.')).toBeUndefined()
  })
})

describe('device grants', () => {
  it('parses the daemon reply and keeps activation facts', () => {
    expect(parseDevices([
      { device_id: 'd1', status: 'unactivated', label: '', gen: 0, expires_at: '2026-11-22T00:48:16Z' },
      { device_id: 'd2', status: 'active', label: 'Chrome', gen: 1, browser_id: 'b1', activated_at: '2026-11-22T00:40:00Z' },
    ])).toEqual([
      { deviceId: 'd1', status: 'unactivated', label: '', gen: 0, expiresAt: '2026-11-22T00:48:16Z' },
      { deviceId: 'd2', status: 'active', label: 'Chrome', gen: 1, browserId: 'b1', activatedAt: '2026-11-22T00:40:00Z' },
    ])
  })

  it('fails loud on a malformed record instead of reading it as no devices', () => {
    expect(() => parseDevices({ devices: [] })).toThrow('not an array')
    expect(() => parseDevices([{ status: 'active' }])).toThrow('lacks an id')
    expect(() => parseDevices([{ device_id: 'd', status: 'pairing' }])).toThrow('known status')
  })
})

describe('runtime mode record', () => {
  it('reads a pre-mode record as managed and keeps its port', async () => {
    const root = await ownedRoot()
    await writeFile(join(root, RUNTIME_STATE_FILE), JSON.stringify({ version: 1, daemonPort: 52_902 }))
    expect(await readRuntimeState(root)).toEqual({ version: 2, mode: 'managed', daemonPort: 52_902 })
  })

  it('round-trips an explicit mode', async () => {
    const root = await ownedRoot()
    await writeRuntimeState(root, { version: 2, mode: 'paired', daemonPort: 52_903 })
    expect(await readRuntimeState(root)).toEqual({ version: 2, mode: 'paired', daemonPort: 52_903 })
  })

  it('refuses a record with an unknown mode or a bad port', async () => {
    const root = await ownedRoot()
    await writeFile(join(root, RUNTIME_STATE_FILE), JSON.stringify({ version: 2, mode: 'attached' }))
    expect(await readRuntimeState(root)).toBeUndefined()
    await writeFile(join(root, RUNTIME_STATE_FILE), JSON.stringify({ version: 1, daemonPort: 0 }))
    expect(await readRuntimeState(root)).toBeUndefined()
    await writeFile(join(root, RUNTIME_STATE_FILE), 'not json')
    expect(await readRuntimeState(root)).toBeUndefined()
  })
})
