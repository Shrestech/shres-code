/**
 * Session-manager behavior: serve a valid document token, refresh at the
 * leeway, persist rotations the CLI can pick up, adopt a sibling's fresher
 * session, and fail loud — naming the document and the fix, never a value.
 */

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { CodexSessionManager } from '../src/index.ts'
import { documentRaw, farFuture, grantPayload, nearlyExpired, tokensRaw, writeAuthDocument, writeRootDocument } from './helpers.ts'

/** A manager whose fetch and clock the test owns. */
function manager(authPath: string, fetchImpl: typeof fetch): CodexSessionManager {
  return new CodexSessionManager({ authPath, refreshLeewayMs: 300_000, fetch: fetchImpl })
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
      jsonBody: typeof init?.body === 'string' ? init.body : undefined,
      headers,
    })
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fetchImpl, requests }
}

/** The request facts one stubbed grant observed. */
interface GrantedRequest {
  url: string
  jsonBody: string | undefined
  headers: Record<string, string> | undefined
}

describe('CodexSessionManager', () => {
  it('serves a far-from-expiry session without any network call', async () => {
    const authPath = await writeAuthDocument(tokensRaw(farFuture()))
    const { fetch, requests } = grantFetch({})
    const token = await manager(authPath, fetch).current()
    const document = JSON.parse(await readFile(authPath, 'utf8')) as { tokens: { access_token: string } }
    expect(token).toEqual({ accessToken: document.tokens.access_token, accountId: 'account-1' })
    expect(requests).toEqual([])
  })

  it('refreshes inside the leeway and persists the rotation for the CLI', async () => {
    const authPath = await writeAuthDocument(tokensRaw(nearlyExpired()))
    const payload = grantPayload()
    const grant = grantFetch(payload)
    const token = await manager(authPath, grant.fetch).current()
    expect(token.accessToken).toBe(payload.access_token)
    expect(grant.requests).toHaveLength(1)
    const request = grant.requests[0]!
    expect(request.url).toBe('https://auth.openai.com/oauth/token')
    expect(request.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(request.jsonBody!)).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token-1',
    })
    const document = JSON.parse(await readFile(authPath, 'utf8')) as {
      OPENAI_API_KEY: string | null
      auth_mode: string
      last_refresh: string
      tokens: Record<string, unknown>
    }
    expect(document.tokens['access_token']).toBe(payload.access_token)
    expect(document.tokens['refresh_token']).toBe('refresh-token-2')
    // The CLI's own document members survive the rotation.
    expect(document.OPENAI_API_KEY).toBeNull()
    expect(document.auth_mode).toBe('chatgpt')
    expect(Number.isFinite(Date.parse(document.last_refresh))).toBe(true)
    expect((await stat(authPath)).mode & 0o777).toBe(0o600)
  })

  it('keeps the prior refresh token and id token when the grant omits them', async () => {
    const authPath = await writeAuthDocument(tokensRaw(nearlyExpired()))
    const grant = grantFetch(grantPayload({ refresh_token: undefined, id_token: undefined }))
    await manager(authPath, grant.fetch).current()
    const document = JSON.parse(await readFile(authPath, 'utf8')) as { tokens: Record<string, unknown> }
    expect(document.tokens['refresh_token']).toBe('refresh-token-1')
    expect(document.tokens['id_token']).toBeDefined()
  })

  it('reports a failed grant as AUTH_REFRESH_FAILED with the issuer error code', async () => {
    // The document session is fully expired, so a failed grant has no valid
    // sibling to adopt and the failure is the answer.
    const authPath = await writeAuthDocument(tokensRaw(Date.now() - 1000))
    const grant = grantFetch({ error: 'invalid_grant', error_description: 'token revoked' }, 400)
    await expect(manager(authPath, grant.fetch).current()).rejects.toThrow(/invalid_grant/)
    await expect(manager(authPath, grant.fetch).current()).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
  })

  it('adopts a session a sibling refreshed into the document after a failed grant', async () => {
    const authPath = await writeAuthDocument(tokensRaw(Date.now() - 1000))
    const siblingTokens = tokensRaw(farFuture(), { refresh_token: 'refresh-token-sibling' })
    // The sibling writes between this process's read and its grant: the stub
    // refreshes the document, then fails the grant exactly like a consumed
    // (rotated-away) refresh token would.
    const fetchImpl = (async () => {
      await writeFile(authPath, JSON.stringify(documentRaw(siblingTokens)), { mode: 0o600 })
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const token = await manager(authPath, fetchImpl).current()
    expect(token.accessToken).toBe(siblingTokens['access_token'])
    const document = JSON.parse(await readFile(authPath, 'utf8')) as { tokens: { access_token: unknown } }
    expect(document.tokens.access_token).toBe(siblingTokens['access_token'])
  })

  it('keeps a sibling rotation instead of overwriting it after our own grant succeeded', async () => {
    const authPath = await writeAuthDocument(tokensRaw(nearlyExpired()))
    const siblingTokens = tokensRaw(farFuture() + 1000, { refresh_token: 'refresh-token-sibling' })
    const fetchImpl = (async () => {
      await writeFile(authPath, JSON.stringify(documentRaw(siblingTokens)), { mode: 0o600 })
      return new Response(JSON.stringify(grantPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const token = await manager(authPath, fetchImpl).current()
    expect(token.accessToken).toBe(siblingTokens['access_token'])
    const document = JSON.parse(await readFile(authPath, 'utf8')) as { tokens: Record<string, unknown> }
    expect(document.tokens['refresh_token']).toBe('refresh-token-sibling')
  })

  it('overwrites an expired sibling rotation after our own grant succeeded', async () => {
    const authPath = await writeAuthDocument(tokensRaw(nearlyExpired()))
    const expiredSibling = tokensRaw(Date.now() - 1000, { refresh_token: 'refresh-expired-sibling' })
    const payload = grantPayload()
    const fetchImpl = (async () => {
      await writeFile(authPath, JSON.stringify(documentRaw(expiredSibling)), { mode: 0o600 })
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const token = await manager(authPath, fetchImpl).current()
    expect(token.accessToken).toBe(payload.access_token)
    const document = JSON.parse(await readFile(authPath, 'utf8')) as { tokens: Record<string, unknown> }
    expect(document.tokens['refresh_token']).toBe('refresh-token-2')
  })

  it('writes a fresh document when the file vanishes before a rotation persists', async () => {
    const authPath = await writeAuthDocument(tokensRaw(nearlyExpired()))
    const payload = grantPayload()
    const fetchImpl = (async () => {
      await rm(authPath, { force: true })
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const token = await manager(authPath, fetchImpl).current()
    expect(token.accessToken).toBe(payload.access_token)
    const document = JSON.parse(await readFile(authPath, 'utf8')) as { tokens: Record<string, unknown>; auth_mode: string }
    expect(document.tokens['access_token']).toBe(payload.access_token)
    expect(document.auth_mode).toBe('chatgpt')
  })

  it('shares one refresh across concurrent callers', async () => {
    const authPath = await writeAuthDocument(tokensRaw(nearlyExpired()))
    const payload = grantPayload()
    const grant = grantFetch(payload)
    const instance = manager(authPath, grant.fetch)
    const [first, second] = await Promise.all([instance.current(), instance.current()])
    expect(first).toEqual(second)
    expect(grant.requests).toHaveLength(1)
  })

  it('fails with the not-logged-in posture when the document is absent', async () => {
    const token = manager('/nonexistent/codex/auth.json', grantFetch({}).fetch).current()
    await expect(token).rejects.toThrow(/codex login/)
    await expect(token).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('fails when the document holds no ChatGPT session tokens', async () => {
    const authPath = await writeRootDocument({ OPENAI_API_KEY: null, auth_mode: 'chatgpt' })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/holds no ChatGPT session tokens/)
  })

  it('refuses an API-key login with the subscription posture', async () => {
    const authPath = await writeRootDocument({ OPENAI_API_KEY: 'sk-test', auth_mode: 'apikey' })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/API-key login/)
  })

  it('fails on a malformed document, naming the path and never the contents', async () => {
    const authPath = await writeAuthDocument(tokensRaw(farFuture()))
    await writeFile(authPath, '{not json', { mode: 0o600 })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/not valid JSON/)
  })

  it('fails a document whose root is not an object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-session-'))
    const authPath = join(dir, 'auth.json')
    await writeFile(authPath, '[]', { mode: 0o600 })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/must be a JSON object/)
  })

  it('refuses a document other OS users can read', async () => {
    const authPath = await writeAuthDocument(tokensRaw(farFuture()))
    if (process.platform === 'win32') return
    await chmod(authPath, 0o644)
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/chmod 600/)
  })

  it('fails a session without an expiry claim', async () => {
    const authPath = await writeAuthDocument({ ...tokensRaw(farFuture()), access_token: 'short' })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/no usable exp claim/)
  })

  it('fails a session missing the access/refresh pair', async () => {
    const authPath = await writeAuthDocument({ account_id: 'account-1' })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/no usable access_token\/refresh_token pair/)
  })

  it('fails a session whose access token is valid but its refresh token is not', async () => {
    const validAccess = tokensRaw(farFuture())['access_token']
    const authPath = await writeAuthDocument({ ...tokensRaw(farFuture()), access_token: validAccess, refresh_token: '' })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/no usable access_token\/refresh_token pair/)
  })

  it('fails a session missing the account id', async () => {
    const authPath = await writeAuthDocument({ ...tokensRaw(farFuture()), account_id: undefined })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/no account_id/)
  })

  it('treats a token with a truncated JWT shape as expiry-less', async () => {
    const authPath = await writeAuthDocument({ ...tokensRaw(farFuture()), access_token: 'short' })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/no usable exp claim/)
  })

  it('treats an unparseable token payload as expiry-less', async () => {
    const garbage = Buffer.from('garbage').toString('base64url')
    const authPath = await writeAuthDocument({ ...tokensRaw(farFuture()), access_token: `h.${garbage}.s` })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/no usable exp claim/)
  })

  it('treats a null, non-numeric, or non-finite exp claim as no expiry', async () => {
    const nullPayload = Buffer.from('null').toString('base64url')
    let authPath = await writeAuthDocument({ ...tokensRaw(farFuture()), access_token: `h.${nullPayload}.s` })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/no usable exp claim/)
    const stringExp = Buffer.from(JSON.stringify({ exp: 'soon' })).toString('base64url')
    authPath = await writeAuthDocument({ ...tokensRaw(farFuture()), access_token: `h.${stringExp}.s` })
    await expect(manager(authPath, grantFetch({}).fetch).current()).rejects.toThrow(/no usable exp claim/)
    // 1e999 survives only in hand-written JSON: JSON.parse reads it as
    // Infinity, the one value the isFinite guard rejects after typeof.
    const hugeExp = Buffer.from('{"exp":1e999}').toString('base64url')
    const dir = await mkdtemp(join(tmpdir(), 'codex-session-'))
    const manual = join(dir, 'auth.json')
    await writeFile(manual, JSON.stringify(documentRaw({ ...tokensRaw(farFuture()), access_token: `h.${hugeExp}.s` })), { mode: 0o600 })
    await expect(manager(manual, grantFetch({}).fetch).current()).rejects.toThrow(/no usable exp claim/)
  })

  it('reports a rejected network error as a failed refresh', async () => {
    const authPath = await writeAuthDocument(tokensRaw(Date.now() - 1000))
    const fetchImpl = (async () => { throw new Error('offline') }) as typeof fetch
    await expect(manager(authPath, fetchImpl).current()).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
  })

  it('fails a failed refresh whose document vanished before adoption', async () => {
    const authPath = await writeAuthDocument(tokensRaw(Date.now() - 1000))
    const fetchImpl = (async () => {
      await rm(authPath, { force: true })
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await expect(manager(authPath, fetchImpl).current()).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
  })

  it('reports unparseable, non-object, and token-less grant bodies as failures', async () => {
    const authPath = await writeAuthDocument(tokensRaw(Date.now() - 1000))
    const unparseable = (async () => new Response('not json', { status: 200 })) as typeof fetch
    await expect(manager(authPath, unparseable).current()).rejects.toThrow(/unparseable body/)
    const nonObject = (async () => new Response('"text"', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await expect(manager(authPath, nonObject).current()).rejects.toThrow(/non-object body/)
    const noToken = (async () => new Response('[1]', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await expect(manager(authPath, noToken).current()).rejects.toThrow(/no access_token/)
    const noExpiry = (async () => new Response(JSON.stringify({ access_token: 'a.b.c' }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await expect(manager(authPath, noExpiry).current()).rejects.toThrow(/no expiry/)
  })

  it('describes a non-object JSON error body by its status alone', async () => {
    const authPath = await writeAuthDocument(tokensRaw(Date.now() - 1000))
    const fetchImpl = (async () => new Response('42', { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await expect(manager(authPath, fetchImpl).current()).rejects.toThrow(/HTTP 400 unknown_error/)
  })

  it('describes a non-JSON error body by its status alone', async () => {
    const authPath = await writeAuthDocument(tokensRaw(Date.now() - 1000))
    const fetchImpl = (async () => new Response('<html>502</html>', { status: 502 })) as typeof fetch
    await expect(manager(authPath, fetchImpl).current()).rejects.toThrow(/HTTP 502/)
  })

  it('propagates a document that became unreadable during a failed refresh', async () => {
    if (process.platform === 'win32') return
    const authPath = await writeAuthDocument(tokensRaw(Date.now() - 1000))
    const fetchImpl = (async () => {
      await chmod(authPath, 0o000)
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await expect(manager(authPath, fetchImpl).current()).rejects.toThrow()
    await chmod(authPath, 0o600)
  })

  it('peeks the account id without refreshing, and empty on failure', async () => {
    const authPath = await writeAuthDocument(tokensRaw(nearlyExpired()))
    const grant = grantFetch(grantPayload())
    const instance = manager(authPath, grant.fetch)
    await expect(instance.peekAccountId()).resolves.toBe('account-1')
    expect(grant.requests).toEqual([])
    await expect(manager('/nonexistent/codex/auth.json', grantFetch({}).fetch).peekAccountId()).resolves.toBe('')
    const tokenless = await writeRootDocument({ OPENAI_API_KEY: null, auth_mode: 'chatgpt' })
    await expect(manager(tokenless, grantFetch({}).fetch).peekAccountId()).resolves.toBe('')
    await writeFile(authPath, '{not json', { mode: 0o600 })
    await expect(instance.peekAccountId()).resolves.toBe('')
  })
})
