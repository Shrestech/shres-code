/**
 * Session-manager behavior: serve a valid document token, refresh at the
 * leeway, persist rotations the CLI can pick up, adopt a sibling's fresher
 * token, and fail loud — naming the document and the fix, never a value.
 * Route-configuration resolution is covered beside it: both are pure over
 * the section value.
 */

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { defaultAuthPath, resolveCredentialSpec, resolveRoute } from '../src/config.ts'
import { GrokSessionManager } from '../src/session.ts'
import { ENTRY_KEY, entryRaw, farFuture, grantPayload, nearlyExpired, writeAuthDocument } from './helpers.ts'

/** A manager whose fetch and clock the test owns. */
function manager(authPath: string, fetchImpl: typeof fetch): GrokSessionManager {
  return new GrokSessionManager({ authPath, refreshLeewayMs: 300_000, fetch: fetchImpl })
}

/** A fetch stub returning one JSON grant; records requests. */
function grantFetch(payload: object, status = 200): { fetch: typeof fetch; requests: GrantedRequest[] } {
  const requests: GrantedRequest[] = []
  const fetchImpl: typeof fetch = async (url, init) => {
    const rawHeaders = init?.headers
    const headers: Record<string, string> = {}
    if (typeof rawHeaders === 'string') headers['content-type'] = rawHeaders
    else if (Array.isArray(rawHeaders)) for (const [name, value] of rawHeaders) headers[name] = value
    else if (rawHeaders !== undefined) Object.assign(headers, rawHeaders)
    requests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      formBody: typeof init?.body === 'string' ? init.body : undefined,
      headers,
    })
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fetchImpl, requests }
}

/** The request facts one stubbed grant observed. */
interface GrantedRequest {
  url: string
  formBody: string | undefined
  headers: Record<string, string> | undefined
}

describe('route configuration', () => {
  it('defaults the auth document to the Grok CLI home', () => {
    expect(defaultAuthPath()).toMatch(/\.grok[/\\]auth\.json$/)
  })

  it('defaults the credential spec to the CLI home and the shipped leeway', () => {
    expect(resolveCredentialSpec({})).toEqual({ authPath: defaultAuthPath(), refreshLeewayMs: 300_000 })
    expect(resolveCredentialSpec({ authPath: '/x/auth.json', refreshLeewayMs: 5 }))
      .toEqual({ authPath: '/x/auth.json', refreshLeewayMs: 5 })
  })

  it('refuses an empty catalog, an empty baseURL, and a negative leeway', () => {
    expect(() => resolveRoute({ models: [] })).toThrow(/must list at least one model/)
    expect(() => resolveRoute({ baseURL: '' })).toThrow(/baseURL must be non-empty/)
    expect(() => resolveCredentialSpec({ refreshLeewayMs: -1 })).toThrow(/non-negative/)
  })

  it('maps optional model fields onto the profile only when stated', () => {
    const profile = resolveRoute({
      models: [{ id: 'bare' }, { id: 'full', name: 'Full', contextWindow: 1000, maxTokens: 128 }],
    })
    const models = profile.models ?? []
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({ id: 'bare' })
    expect(models[0]).not.toHaveProperty('name')
    expect(models[0]).not.toHaveProperty('maxTokens')
    expect(models[1]).toMatchObject({ id: 'full', name: 'Full', contextWindow: 1000, maxTokens: 128 })
  })
})

describe('GrokSessionManager', () => {
  it('serves a far-from-expiry token without any network call', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(farFuture()) })
    const { fetch, requests } = grantFetch({})
    const token = await manager(authPath, fetch).accessToken()
    expect(token).toBe((JSON.parse(await readFile(authPath, 'utf8')) as Record<string, { key: string }>)[ENTRY_KEY]!.key)
    expect(requests).toEqual([])
  })

  it('refreshes inside the leeway and persists the rotation for the CLI', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(nearlyExpired()) })
    const payload = grantPayload()
    const grant = grantFetch(payload)
    const token = await manager(authPath, grant.fetch).accessToken()
    expect(token).toBe(payload.access_token)
    expect(grant.requests).toHaveLength(1)
    const request = grant.requests[0]!
    expect(request.url).toBe('https://auth.x.ai/oauth2/token')
    expect(request.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' })
    const sent = new URLSearchParams(request.formBody)
    expect(sent.get('grant_type')).toBe('refresh_token')
    expect(sent.get('client_id')).toBe('test-client-id')
    expect(sent.get('refresh_token')).toBe('refresh-token-1')
    const document = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, Record<string, unknown>>
    expect(document[ENTRY_KEY]!['key']).toBe(payload.access_token)
    expect(document[ENTRY_KEY]!['refresh_token']).toBe('refresh-token-2')
    expect(document[ENTRY_KEY]!['email']).toBe('user@example.com')
    expect((await stat(authPath)).mode & 0o777).toBe(0o600)
  })

  it('falls back to the exp claim when the grant omits expires_in', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(nearlyExpired()) })
    const grant = grantFetch(grantPayload({ expires_in: undefined }))
    const token = await manager(authPath, grant.fetch).accessToken()
    expect(token.length).toBeGreaterThan(0)
    const document = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, Record<string, unknown>>
    expect(Number.isFinite(Date.parse(String(document[ENTRY_KEY]!['expires_at'])))).toBe(true)
  })

  it('reports a failed grant as AUTH_REFRESH_FAILED with the issuer error code', async () => {
    // The document token is fully expired, so a failed grant has no valid
    // sibling to adopt and the failure is the answer.
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(Date.now() - 1000) })
    const grant = grantFetch({ error: 'invalid_grant', error_description: 'token revoked' }, 400)
    await expect(manager(authPath, grant.fetch).accessToken()).rejects.toThrow(/invalid_grant/)
    await expect(manager(authPath, grant.fetch).accessToken()).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
  })

  it('adopts a token a sibling refreshed into the document after a failed grant', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(Date.now() - 1000) })
    const siblingToken = entryRaw(farFuture())
    // The sibling writes between this process's read and its grant: the stub
    // refreshes the document, then fails the grant exactly like a consumed
    // (rotated-away) refresh token would.
    const fetchImpl = (async () => {
      await writeFile(authPath, JSON.stringify({ [ENTRY_KEY]: siblingToken }), { mode: 0o600 })
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const token = await manager(authPath, fetchImpl).accessToken()
    expect(token).toBe(siblingToken['key'])
    expect((JSON.parse(await readFile(authPath, 'utf8')) as Record<string, { key: string }>)[ENTRY_KEY]!.key).toBe(siblingToken['key'])
  })

  it('keeps a sibling rotation instead of overwriting it after our own grant succeeded', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(nearlyExpired()) })
    const siblingToken = entryRaw(farFuture() + 1000, { refresh_token: 'refresh-token-sibling' })
    const fetchImpl = (async () => {
      await writeFile(authPath, JSON.stringify({ [ENTRY_KEY]: siblingToken }), { mode: 0o600 })
      return new Response(JSON.stringify(grantPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const token = await manager(authPath, fetchImpl).accessToken()
    expect(token).toBe(siblingToken['key'])
    const document = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, Record<string, unknown>>
    expect(document[ENTRY_KEY]!['refresh_token']).toBe('refresh-token-sibling')
  })

  it('overwrites an expired sibling rotation after our own grant succeeded', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(nearlyExpired()) })
    const expiredSibling = entryRaw(Date.now() - 1000, { refresh_token: 'refresh-expired-sibling' })
    const payload = grantPayload()
    const fetchImpl = (async () => {
      await writeFile(authPath, JSON.stringify({ [ENTRY_KEY]: expiredSibling }), { mode: 0o600 })
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const token = await manager(authPath, fetchImpl).accessToken()
    expect(token).toBe(payload.access_token)
    const document = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, Record<string, unknown>>
    expect(document[ENTRY_KEY]!['refresh_token']).toBe('refresh-token-2')
  })

  it('writes a fresh document when the file vanishes before a rotation persists', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(nearlyExpired()) })
    const payload = grantPayload()
    const fetchImpl = (async () => {
      await rm(authPath, { force: true })
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const token = await manager(authPath, fetchImpl).accessToken()
    expect(token).toBe(payload.access_token)
    const document = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, Record<string, unknown>>
    expect(document[ENTRY_KEY]!['key']).toBe(payload.access_token)
  })

  it('shares one refresh across concurrent callers', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(nearlyExpired()) })
    const payload = grantPayload()
    const grant = grantFetch(payload)
    const instance = manager(authPath, grant.fetch)
    const [first, second] = await Promise.all([instance.accessToken(), instance.accessToken()])
    expect(first).toBe(second)
    expect(grant.requests).toHaveLength(1)
  })

  it('fails with the not-logged-in posture when the document is absent', async () => {
    const token = manager('/nonexistent/grok/auth.json', grantFetch({}).fetch).accessToken()
    await expect(token).rejects.toThrow(/grok login/)
    await expect(token).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('fails when the document holds no issuer entry', async () => {
    const authPath = await writeAuthDocument({ 'https://other.example::id': entryRaw(farFuture()) })
    await expect(manager(authPath, grantFetch({}).fetch).accessToken()).rejects.toThrow(/holds no/)
  })

  it('fails on a malformed document, naming the path and never the contents', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(farFuture()) })
    await writeFile(authPath, '{not json', { mode: 0o600 })
    await expect(manager(authPath, grantFetch({}).fetch).accessToken()).rejects.toThrow(/not valid JSON/)
  })

  it('fails a document whose root is not an object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-session-'))
    const authPath = join(dir, 'auth.json')
    await writeFile(authPath, '[]', { mode: 0o600 })
    await expect(manager(authPath, grantFetch({}).fetch).accessToken()).rejects.toThrow(/must be a JSON object/)
  })

  it('refuses a document other OS users can read', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(farFuture()) })
    if (process.platform === 'win32') return
    await chmod(authPath, 0o644)
    await expect(manager(authPath, grantFetch({}).fetch).accessToken()).rejects.toThrow(/chmod 600/)
  })

  it('fails an entry without an expiry statement', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: { key: 'k', refresh_token: 'r' } })
    await expect(manager(authPath, grantFetch({}).fetch).accessToken()).rejects.toThrow(/no usable expiry/)
  })

  it('fails an entry missing the key/refresh pair', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: { expires_at: new Date().toISOString() } })
    await expect(manager(authPath, grantFetch({}).fetch).accessToken()).rejects.toThrow(/no usable key\/refresh_token pair/)
  })

  it('treats a token with a truncated JWT shape as expiry-less', async () => {
    const authPath = await writeAuthDocument({
      [ENTRY_KEY]: { key: 'short', refresh_token: 'r', expires_at: 'not-a-date' },
    })
    await expect(manager(authPath, grantFetch({}).fetch).accessToken()).rejects.toThrow(/no usable expiry/)
  })

  it('treats an unparseable token payload as expiry-less', async () => {
    const garbage = Buffer.from('garbage').toString('base64url')
    const authPath = await writeAuthDocument({
      [ENTRY_KEY]: { key: `h.${garbage}.s`, refresh_token: 'r', expires_at: 'not-a-date' },
    })
    await expect(manager(authPath, grantFetch({}).fetch).accessToken()).rejects.toThrow(/no usable expiry/)
  })

  it('falls back to the key-suffix client id when the entry omits oidc_client_id', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(nearlyExpired(), { oidc_client_id: undefined }) })
    const grant = grantFetch(grantPayload())
    await manager(authPath, grant.fetch).accessToken()
    const sent = new URLSearchParams(grant.requests[0]!.formBody)
    expect(sent.get('client_id')).toBe('test-client-id')
  })

  it('skips entries whose value is not an object', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: 'garbage', 'https://auth.x.ai::ok': entryRaw(farFuture()) })
    const token = await manager(authPath, grantFetch({}).fetch).accessToken()
    expect(token.length).toBeGreaterThan(0)
  })

  it('selects the newest issuer entry when a document carries several', async () => {
    const older = entryRaw(farFuture())
    const newer = entryRaw(farFuture() + 5000, { refresh_token: 'refresh-newer' })
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: older, 'https://auth.x.ai::another-client': newer })
    const token = await manager(authPath, grantFetch({}).fetch).accessToken()
    expect(token).toBe(newer['key'])
  })

  it('breaks an expiry tie by client id, deterministically', async () => {
    const expiry = farFuture()
    const base = entryRaw(expiry, { refresh_token: 'tie-a', oidc_client_id: 'test-client-id' })
    const larger = entryRaw(expiry, { refresh_token: 'tie-b', oidc_client_id: 'zzz-client' })
    const smaller = entryRaw(expiry, { refresh_token: 'tie-c', oidc_client_id: 'aaa-client' })
    const authPath = await writeAuthDocument({
      'https://auth.x.ai::test-client-id': base,
      'https://auth.x.ai::zzz-client': larger,
      'https://auth.x.ai::aaa-client': smaller,
    })
    const token = await manager(authPath, grantFetch({}).fetch).accessToken()
    // Equal expiry: the larger client id wins the deterministic tie-break;
    // a smaller latecomer does not take it from an earlier entry.
    expect(token).toBe(larger['key'])
  })

  it('fails a failed refresh whose document vanished before adoption', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(Date.now() - 1000) })
    const fetchImpl = (async () => {
      await rm(authPath, { force: true })
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await expect(manager(authPath, fetchImpl).accessToken()).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
  })

  it('treats a null or non-numeric exp claim as no expiry', async () => {
    // JSON.stringify cannot produce a non-finite number, so the non-finite
    // case gets a hand-written raw document below.
    const nullPayload = Buffer.from('null').toString('base64url')
    const authPath = await writeAuthDocument({
      [ENTRY_KEY]: { key: `h.${nullPayload}.s`, refresh_token: 'r', expires_at: 'not-a-date' },
    })
    await expect(manager(authPath, grantFetch({}).fetch).accessToken()).rejects.toThrow(/no usable expiry/)
  })

  it('treats a non-numeric exp claim as no expiry', async () => {
    const stringExp = Buffer.from(JSON.stringify({ exp: 'soon' })).toString('base64url')
    const authPath = await writeAuthDocument({
      [ENTRY_KEY]: { key: `h.${stringExp}.s`, refresh_token: 'r', expires_at: 'not-a-date' },
    })
    await expect(manager(authPath, grantFetch({}).fetch).accessToken()).rejects.toThrow(/no usable expiry/)
  })

  it('treats a non-finite exp claim as no expiry', async () => {
    // 1e999 survives only in hand-written JSON: JSON.parse reads it as
    // Infinity, the one value the isFinite guard rejects after typeof.
    const hugeExp = Buffer.from('{"exp":1e999}').toString('base64url')
    const dir = await mkdtemp(join(tmpdir(), 'grok-session-'))
    const authPath = join(dir, 'auth.json')
    const entry = JSON.stringify({ key: `h.${hugeExp}.s`, refresh_token: 'r', expires_at: 'not-a-date' })
    await writeFile(authPath, `{${JSON.stringify(ENTRY_KEY)}: ${entry}}`, { mode: 0o600 })
    await expect(manager(authPath, grantFetch({}).fetch).accessToken()).rejects.toThrow(/no usable expiry/)
  })

  it('keeps the prior refresh token when the grant returns an empty one', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(nearlyExpired()) })
    const grant = grantFetch(grantPayload({ refresh_token: '' }))
    await manager(authPath, grant.fetch).accessToken()
    const document = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, Record<string, unknown>>
    expect(document[ENTRY_KEY]!['refresh_token']).toBe('refresh-token-1')
  })

  it('reports a rejected network error as a failed refresh', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(Date.now() - 1000) })
    const fetchImpl = (async () => { throw new Error('offline') }) as typeof fetch
    await expect(manager(authPath, fetchImpl).accessToken()).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
  })

  it('reports unparseable, non-object, and expiry-less grant bodies as failures', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(Date.now() - 1000) })
    const unparseable = (async () => new Response('not json', { status: 200 })) as typeof fetch
    await expect(manager(authPath, unparseable).accessToken()).rejects.toThrow(/unparseable body/)
    const nonObject = (async () => new Response('"text"', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await expect(manager(authPath, nonObject).accessToken()).rejects.toThrow(/non-object body/)
    const noToken = (async () => new Response('[1]', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await expect(manager(authPath, noToken).accessToken()).rejects.toThrow(/no access_token/)
    const noExpiry = (async () => new Response(JSON.stringify({ access_token: 'a.b.c' }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await expect(manager(authPath, noExpiry).accessToken()).rejects.toThrow(/stated no expiry/)
  })

  it('describes a non-object JSON error body by its status alone', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(Date.now() - 1000) })
    const fetchImpl = (async () => new Response('42', { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await expect(manager(authPath, fetchImpl).accessToken()).rejects.toThrow(/HTTP 400 unknown_error/)
  })

  it('describes a non-JSON error body by its status alone', async () => {
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(Date.now() - 1000) })
    const fetchImpl = (async () => new Response('<html>502</html>', { status: 502 })) as typeof fetch
    await expect(manager(authPath, fetchImpl).accessToken()).rejects.toThrow(/HTTP 502/)
  })

  it('propagates a document that became unreadable during a failed refresh', async () => {
    if (process.platform === 'win32') return
    const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(Date.now() - 1000) })
    const fetchImpl = (async () => {
      await chmod(authPath, 0o000)
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await expect(manager(authPath, fetchImpl).accessToken()).rejects.toThrow()
    await chmod(authPath, 0o600)
  })
})
