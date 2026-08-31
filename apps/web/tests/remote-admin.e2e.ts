// Web e2e scenario: the shipped composition serves the gesture-gated
// remoteAdmin namespace through the real Loader composition row, Typert
// descriptor, and HTTP /api carrier. Zero model calls and zero ssh: begin,
// add, edit, remove, and status run hermetically against the isolated
// harness home's registry (the same file remoteControl/list projects per
// call), spent tokens refuse reuse, and a declared non-loopback authority
// is refused for both remote namespaces.
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

interface RemoteEntryView {
  id: string
  target: string
  remotePort: number
}

interface RpcBody {
  result?: { ok?: boolean; value?: unknown; error?: { message?: string } }
}

/** One client-request envelope per wire contract: rpcId unique per call. */
let rpcSeq = 0

/** Issue one POST against the real /api carrier and return the response envelope. */
async function rpc(scaffold: WebScaffold, method: string, request?: Record<string, unknown>): Promise<RpcBody> {
  const response = await fetch(`${scaffold.baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `remote-admin-e2e-${String(++rpcSeq)}`,
      method,
      // A parameterless descriptor takes an empty args object; methods with a
      // single `request` parameter wrap it under its wire name.
      payload: { args: request === undefined ? {} : { request } },
    }),
  })
  expect(response.ok).toBe(true)
  return await response.json() as RpcBody
}

function value(body: RpcBody): Record<string, unknown> {
  if (body.result?.ok !== true) throw new Error(`wire failure: ${JSON.stringify(body.result?.error)}`)
  return body.result.value as Record<string, unknown>
}

/** Mint one grant for the verb/alias pair through the real wire. */
async function grant(scaffold: WebScaffold, verb: string, alias: string | null): Promise<string> {
  const token = value(await rpc(scaffold, 'remoteAdmin/begin', { verb, alias }))['token']
  if (typeof token !== 'string') throw new Error(`begin did not mint: ${JSON.stringify(alias)}`)
  return token
}

async function listIds(scaffold: WebScaffold): Promise<string[]> {
  const body = value(await rpc(scaffold, 'remoteControl/list'))
  return ((body['entries'] as RemoteEntryView[]) ?? []).map(entry => entry.id)
}

describe('web e2e: remoteAdmin gesture-gated namespace', () => {
  let scaffold: WebScaffold

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
  }, 120_000)

  afterAll(async () => {
    await scaffold?.close()
  })

  it('drives add, edit, and remove through begin grants over the real registry', async () => {
    onTestFailed(() => { void scaffold })

    expect(value(await rpc(scaffold, 'remoteAdmin/status'))).toMatchObject({ tunnels: [] })
    expect(await listIds(scaffold)).toEqual([])

    const added = value(await rpc(scaffold, 'remoteAdmin/add', {
      token: await grant(scaffold, 'add', null),
      alias: 'lab', target: 'ci@remote.example', remotePort: 3080,
    }))
    expect(added).toMatchObject({ entry: { id: 'lab', target: 'ci@remote.example', remotePort: 3080, fingerprint: null } })
    // The admin row writes the same durable file the read-only row projects.
    expect(await listIds(scaffold)).toEqual(['lab'])

    const edited = value(await rpc(scaffold, 'remoteAdmin/edit', {
      token: await grant(scaffold, 'edit', 'lab'),
      alias: 'lab', target: 'build@remote.example', remotePort: 3081,
    }))
    expect(edited).toMatchObject({ entry: { target: 'build@remote.example', remotePort: 3081 } })
    expect(await listIds(scaffold)).toEqual(['lab'])

    const removed = value(await rpc(scaffold, 'remoteAdmin/removeEntry', {
      token: await grant(scaffold, 'removeEntry', 'lab'),
      alias: 'lab',
    }))
    expect(removed).toEqual({ status: 'removed', removed: true })
    expect(await listIds(scaffold)).toEqual([])
  })

  it('refuses token reuse, unknown tokens, and contradictory begin requests', async () => {
    onTestFailed(() => { void scaffold })

    const token = await grant(scaffold, 'add', null)
    await rpc(scaffold, 'remoteAdmin/add', { token, alias: 'lab', target: 'ci@remote.example', remotePort: 3080 })
    const reused = await rpc(scaffold, 'remoteAdmin/add', { token, alias: 'prod', target: 'ci@remote.example', remotePort: 3080 })
    expect(reused.result?.error?.message).toContain('gesture token')

    const missing = await rpc(scaffold, 'remoteAdmin/removeEntry', { token: 'deadbeef', alias: 'lab' })
    expect(missing.result?.error?.message).toContain('gesture token')

    const scoped = await rpc(scaffold, 'remoteAdmin/removeEntry', { token: await grant(scaffold, 'connect', 'lab'), alias: 'lab' })
    expect(scoped.result?.error?.message).toContain('gesture token')

    const aliasedAdd = await rpc(scaffold, 'remoteAdmin/begin', { verb: 'add', alias: 'lab' })
    expect(aliasedAdd.result?.error?.message).toContain('pass alias null')
    const bareVerb = await rpc(scaffold, 'remoteAdmin/begin', { verb: 'connect', alias: null })
    expect(bareVerb.result?.error?.message).toContain('needs an alias')

    // The spent token left no second mutation behind.
    expect(await listIds(scaffold)).toEqual(['lab'])
  })

  it('keeps /api POST-only: a GET never reaches the namespace', async () => {
    onTestFailed(() => { void scaffold })

    const response = await fetch(`${scaffold.baseUrl}/api/remoteAdmin/begin`)
    expect(response.ok).toBe(false)
  })
})

describe('web e2e: remote plane pins to loopback', () => {
  let scaffold: WebScaffold

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ remoteAuthority: 'remote.localhost' })
  }, 120_000)

  afterAll(async () => {
    await scaffold?.close()
  })

  it('refuses both remote namespaces for a declared non-loopback authority', async () => {
    onTestFailed(() => { void scaffold })

    for (const method of ['remoteControl/list', 'remoteAdmin/status', 'remoteAdmin/begin']) {
      const response = await fetch(`${scaffold.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: scaffold.baseUrl, 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'remote-admin-e2e-pin',
          method,
          payload: { args: { request: method === 'remoteAdmin/begin' ? { verb: 'add', alias: null } : {} } },
        }),
      })
      expect(response.status, method).toBe(403)
    }
  })
})
