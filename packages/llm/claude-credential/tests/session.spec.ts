/**
 * Session-manager behavior: serve the credential the Claude Code CLI stored —
 * the login keychain item or its own document — refresh it through the
 * issuer's refresh_token grant at the configured leeway, persist rotations the
 * CLI can pick up, adopt a sibling's fresher session, and fail loud — naming
 * the source, the issuer's error code, and the fix, never a value.
 */

import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_ID,
  ClaudeSessionManager,
  DEFAULT_SECURITY_PATH,
  KEYCHAIN_SERVICE,
  TOKEN_URL,
  defaultAuthPath,
  selectSessionEntry,
} from '../src/index.ts'
import type { ClaudeSessionOptions } from '../src/index.ts'
import {
  GRANT_EXPIRES_AT,
  MCP_OAUTH,
  TEST_NOW,
  documentRaw,
  expired,
  failingSecurityStandIn,
  fakeKeychain,
  farFuture,
  grantFetch,
  grantPayload,
  nearlyExpired,
  oauthRaw,
  rawFetch,
  refusingWriteSecurityStandIn,
  securityStandIn,
  silentRefusingWriteSecurityStandIn,
  tempDir,
  testClock,
  unreachableFetch,
  writeClaudeDocument,
  writeRawDocument,
} from './helpers.ts'

/** How diagnostics in these tests name the document source. */
const SOURCE = 'the test document'

/** A fetch stub for serve-only cases: any token request means the premise broke. */
const unexpectedGrant: typeof fetch = async () => {
  throw new Error('the manager must not run a grant here')
}

/** A file-source manager over a 300-second leeway whose fetch the test owns. */
function fileManager(
  authPath: string,
  fetchImpl: typeof fetch = unexpectedGrant,
  extra: Partial<ClaudeSessionOptions> = {},
): ClaudeSessionManager {
  return new ClaudeSessionManager({
    useKeychain: false,
    securityPath: DEFAULT_SECURITY_PATH,
    authPath,
    keychainAccount: 'claude-user',
    refreshLeewayMs: 300_000,
    fetch: fetchImpl,
    ...extra,
  })
}

/** A keychain-source manager whose reader and fetch the test owns. */
function keychainManager(
  fetchImpl: typeof fetch = unexpectedGrant,
  extra: Partial<ClaudeSessionOptions> = {},
): ClaudeSessionManager {
  return new ClaudeSessionManager({
    useKeychain: true,
    securityPath: DEFAULT_SECURITY_PATH,
    authPath: '/home/u/.claude/.credentials.json',
    keychainAccount: 'claude-user',
    refreshLeewayMs: 300_000,
    fetch: fetchImpl,
    ...extra,
  })
}

/** The message of the error one call rejects with. */
async function messageOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    return (error as { message: string }).message
  }
  throw new Error('expected the call to reject')
}

/** The error one selection throws; its message and code are the assertions. */
function selectionRejection(text: string): { message: string; code: unknown } {
  try {
    selectSessionEntry(text, SOURCE)
  } catch (error) {
    return error as { message: string; code: unknown }
  }
  throw new Error('expected the document to be refused')
}

/** The document as one re-read from disk. */
async function readWritten(authPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>
}

/** The rotated "claudeAiOauth" object of one written document. */
async function readWrittenOauth(authPath: string): Promise<Record<string, unknown>> {
  return (await readWritten(authPath))['claudeAiOauth'] as Record<string, unknown>
}

describe('ClaudeSessionManager (keychain source)', () => {
  it('serves the item the login keychain holds without touching the issuer', async () => {
    const keychain = fakeKeychain({ [KEYCHAIN_SERVICE]: JSON.stringify(documentRaw(oauthRaw(farFuture()))) })
    const token = await keychainManager(unexpectedGrant, { readKeychain: keychain.read }).current()
    expect(token).toEqual({ accessToken: 'access-token-1' })
    expect(keychain.reads).toEqual([KEYCHAIN_SERVICE])
  })

  it('adopts the CLI rotation by re-reading the item on every resolve', async () => {
    let item = JSON.stringify(documentRaw(oauthRaw(farFuture())))
    const reads: string[] = []
    const manager = keychainManager(unexpectedGrant, {
      readKeychain: async (service) => {
        reads.push(service)
        return item
      },
    })
    const first = await manager.current()
    item = JSON.stringify(documentRaw(oauthRaw(farFuture(), { accessToken: 'rotated-by-cli' })))
    const second = await manager.current()
    expect(first).toEqual({ accessToken: 'access-token-1' })
    expect(second).toEqual({ accessToken: 'rotated-by-cli' })
    expect(reads).toEqual([KEYCHAIN_SERVICE, KEYCHAIN_SERVICE])
  })

  it('shares one keychain read across concurrent callers', async () => {
    const keychain = fakeKeychain({ [KEYCHAIN_SERVICE]: JSON.stringify(documentRaw(oauthRaw(farFuture()))) })
    const manager = keychainManager(unexpectedGrant, { readKeychain: keychain.read })
    const [first, second, third] = await Promise.all([manager.current(), manager.current(), manager.current()])
    expect(first).toEqual(second)
    expect(second).toEqual(third)
    expect(keychain.reads).toHaveLength(1)
  })

  it('fails MISSING_CREDENTIAL naming the keychain item when the service holds none', async () => {
    const promise = keychainManager(unexpectedGrant, { readKeychain: fakeKeychain({}).read }).current()
    await expect(promise).rejects.toThrow(/the login keychain item "Claude Code-credentials"/)
    await expect(promise).rejects.toThrow(/sign in with \/login/)
    await expect(promise).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('fails MISSING_CREDENTIAL when the item read back empty', async () => {
    const manager = keychainManager(unexpectedGrant, { readKeychain: fakeKeychain({ [KEYCHAIN_SERVICE]: '' }).read })
    await expect(manager.current()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
})

describe('ClaudeSessionManager (file source)', () => {
  it('serves a valid document without touching the issuer', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(farFuture()))
    await expect(fileManager(authPath).current()).resolves.toEqual({ accessToken: 'access-token-1' })
  })

  it('fails MISSING_CREDENTIAL naming the path and the sign-in step when the document is absent', async () => {
    const authPath = join(await tempDir(), '.credentials.json')
    const promise = fileManager(authPath).current()
    await expect(promise).rejects.toThrow(new RegExp(authPath.replace(/\//g, '\\/')))
    await expect(promise).rejects.toThrow(/sign in with \/login/)
    await expect(promise).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('fails MISSING_CREDENTIAL on a malformed document, naming no document text', async () => {
    const authPath = await writeRawDocument('{not json')
    const promise = fileManager(authPath).current()
    await expect(promise).rejects.toThrow(/is not valid JSON \(SyntaxError\)/)
    await expect(promise).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(await messageOf(promise)).not.toContain('not json')
  })

  it('fails MISSING_CREDENTIAL when the document root is not an object', async () => {
    for (const text of ['[]', 'null', '42']) {
      const authPath = await writeRawDocument(text)
      await expect(fileManager(authPath).current())
        .rejects.toThrow(/must be a JSON object with a claudeAiOauth member/)
      await expect(fileManager(authPath).current()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    }
  })

  it('refuses a document other OS users can read, naming chmod 600', async () => {
    if (process.platform === 'win32') return
    const authPath = await writeClaudeDocument(oauthRaw(farFuture()))
    await chmod(authPath, 0o644)
    await expect(fileManager(authPath).current()).rejects.toThrow(/readable beyond its owner \(mode 644\)/)
    await expect(fileManager(authPath).current()).rejects.toThrow(/chmod 600/)
    await expect(fileManager(authPath).current()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
})

describe('selectSessionEntry', () => {
  it('selects the claudeAiOauth object and keeps the document verbatim in raw', () => {
    const raw = oauthRaw(TEST_NOW + 1000, { refreshTokenExpiresAt: TEST_NOW + 90_000 })
    const entry = selectSessionEntry(JSON.stringify(documentRaw(raw)), SOURCE)
    expect(entry.accessToken).toBe('access-token-1')
    expect(entry.refreshToken).toBe('refresh-token-1')
    expect(entry.expiresAtMs).toBe(TEST_NOW + 1000)
    expect(entry.refreshTokenExpiresAtMs).toBe(TEST_NOW + 90_000)
    expect(entry.raw).toEqual(raw)
    expect(entry.source).toBe(SOURCE)
  })

  it('fails MISSING_CREDENTIAL when the document holds no claudeAiOauth member', () => {
    const error = selectionRejection('{"mcpOAuth":{}}')
    expect(error.message).toMatch(/holds no claudeAiOauth member/)
    expect(error.code).toBe('MISSING_CREDENTIAL')
  })

  it('fails MISSING_CREDENTIAL when claudeAiOauth is not an object', () => {
    for (const oauth of ['"x"', 'null', '[]', '7']) {
      const error = selectionRejection('{"claudeAiOauth":' + oauth + '}')
      expect(error.message).toMatch(/holds no claudeAiOauth member/)
      expect(error.code).toBe('MISSING_CREDENTIAL')
    }
  })

  it('fails MISSING_CREDENTIAL when the refreshToken is absent, empty, or not a string', () => {
    for (const refreshToken of [undefined, '', 42]) {
      const error = selectionRejection(JSON.stringify(documentRaw(oauthRaw(farFuture(), { refreshToken }))))
      expect(error.message).toMatch(/claudeAiOauth carries no refreshToken/)
      expect(error.code).toBe('MISSING_CREDENTIAL')
    }
  })

  it('fails MISSING_CREDENTIAL when expiresAt is not a finite number, including hand-written Infinity', () => {
    const notStated = selectionRejection(JSON.stringify(documentRaw(oauthRaw(farFuture(), { expiresAt: 'soon' }))))
    expect(notStated.message).toMatch(/claudeAiOauth states no usable expiresAt/)
    expect(notStated.code).toBe('MISSING_CREDENTIAL')
    // 1e999 survives only in hand-written JSON: JSON.parse reads it as Infinity.
    const infinite = selectionRejection('{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1e999}}')
    expect(infinite.message).toMatch(/claudeAiOauth states no usable expiresAt/)
    expect(infinite.code).toBe('MISSING_CREDENTIAL')
  })

  it('selects a zero expiresAt with no access token as refreshable, not missing', () => {
    const empty = selectSessionEntry(JSON.stringify(documentRaw(oauthRaw(0, { accessToken: '' }))), SOURCE)
    expect(empty.expiresAtMs).toBe(0)
    expect(empty.accessToken).toBe('')
    const namingNone = selectSessionEntry(JSON.stringify(documentRaw(oauthRaw(0, { accessToken: undefined }))), SOURCE)
    expect(namingNone.accessToken).toBe('')
  })

  it('fails MISSING_CREDENTIAL for an absent access token beside a non-zero expiresAt', () => {
    const error = selectionRejection(JSON.stringify(documentRaw(oauthRaw(farFuture(), { accessToken: '' }))))
    expect(error.message).toMatch(/carries no accessToken beside a non-zero expiresAt/)
    expect(error.code).toBe('MISSING_CREDENTIAL')
  })

  it('treats a zero, negative, or non-numeric refreshTokenExpiresAt as not stated', () => {
    for (const refreshTokenExpiresAt of [0, -1000, 'soon']) {
      const entry = selectSessionEntry(
        JSON.stringify(documentRaw(oauthRaw(farFuture(), { refreshTokenExpiresAt }))),
        SOURCE,
      )
      expect(entry.refreshTokenExpiresAtMs).toBeUndefined()
    }
  })
})

describe('ClaudeSessionManager refresh grant', () => {
  it('refreshes inside the leeway and persists the merged document for the CLI', async () => {
    const oauth = oauthRaw(nearlyExpired())
    const dir = await tempDir()
    const authPath = await writeClaudeDocument(oauth, { unknownRootSibling: 'kept' }, dir)
    const grant = grantFetch(grantPayload())
    const token = await fileManager(authPath, grant.fetch).current()
    expect(token).toEqual({ accessToken: 'rotated-access-token' })
    expect(grant.requests).toHaveLength(1)
    const request = grant.requests[0]!
    expect(request.url).toBe(TOKEN_URL)
    expect(request.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(request.jsonBody!)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token-1',
      client_id: CLIENT_ID,
    })
    const written = await readWritten(authPath)
    // The CLI's own document members survive the rotation.
    expect(written['unknownRootSibling']).toBe('kept')
    expect(written['mcpOAuth']).toEqual(MCP_OAUTH)
    const rotated = written['claudeAiOauth'] as Record<string, unknown>
    expect(rotated['accessToken']).toBe('rotated-access-token')
    expect(rotated['refreshToken']).toBe('rotated-refresh-token')
    // expires_at is the store's own epoch-millisecond field.
    expect(rotated['expiresAt']).toBe(GRANT_EXPIRES_AT)
    // Fields the grant does not restate stay as the CLI wrote them.
    expect(rotated['scopes']).toEqual(['user:inference'])
    expect(rotated['subscriptionType']).toBe('max')
    expect(rotated['rateLimitTier']).toBe('default_claude_max_20x')
    expect(rotated['refreshTokenExpiresAt']).toBe(oauth['refreshTokenExpiresAt'])
    // The rotation lands as one staged, renamed, owner-only document.
    expect((await stat(authPath)).mode & 0o777).toBe(0o600)
    expect(await readdir(dirname(authPath))).toEqual(['.credentials.json'])
    expect(await readFile(authPath, 'utf8')).toMatch(/\n$/)
  })

  it('counts a grant expires_in seconds from the injected clock', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(TEST_NOW - 1000))
    const grant = grantFetch({
      access_token: 'rotated-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_in: 3600,
    })
    await fileManager(authPath, grant.fetch, { now: testClock() }).current()
    expect((await readWrittenOauth(authPath))['expiresAt']).toBe(TEST_NOW + 3_600_000)
  })

  it('falls back to expires_in when the grant states expires_at as zero', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(TEST_NOW - 1000))
    const grant = grantFetch(grantPayload({ expires_at: 0, expires_in: 60 }))
    await fileManager(authPath, grant.fetch, { now: testClock() }).current()
    expect((await readWrittenOauth(authPath))['expiresAt']).toBe(TEST_NOW + 60_000)
  })

  it('refreshes a store that states expiresAt zero with no access token', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(0, { accessToken: '' }))
    const grant = grantFetch(grantPayload())
    await expect(fileManager(authPath, grant.fetch).current()).resolves.toEqual({ accessToken: 'rotated-access-token' })
    expect(grant.requests).toHaveLength(1)
    expect((await readWrittenOauth(authPath))['refreshToken']).toBe('rotated-refresh-token')
  })

  it('shares one grant across concurrent callers', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(expired()))
    const grant = grantFetch(grantPayload())
    const manager = fileManager(authPath, grant.fetch)
    const [first, second, third] = await Promise.all([manager.current(), manager.current(), manager.current()])
    expect(first).toEqual(second)
    expect(second).toEqual(third)
    expect(grant.requests).toHaveLength(1)
  })

  it('reports a refused grant by the issuer error code and description', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(expired()))
    const grant = grantFetch({ error: 'invalid_grant', error_description: 'refresh token revoked' }, 400)
    const promise = fileManager(authPath, grant.fetch).current()
    await expect(promise).rejects.toThrow(/HTTP 400 invalid_grant: refresh token revoked/)
    await expect(promise).rejects.toThrow(/sign in with \/login/)
    await expect(promise).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
    const message = await messageOf(promise)
    expect(message).not.toContain('refresh-token-1')
    expect(message).not.toContain('access-token-1')
  })

  it('quotes only the issuer code when the error body states no description', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(expired()))
    const grant = grantFetch({ error: 'invalid_grant' }, 400)
    await expect(fileManager(authPath, grant.fetch).current()).rejects.toThrow(/\(HTTP 400 invalid_grant\);/)
  })

  it('describes a non-object JSON error body by its status alone', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(expired()))
    for (const body of ['42', 'null', '[1]']) {
      await expect(fileManager(authPath, rawFetch(body, 400).fetch).current())
        .rejects.toThrow(/HTTP 400 unknown_error/)
    }
  })

  it('describes a non-JSON error body by its status alone', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(expired()))
    const promise = fileManager(authPath, rawFetch('<html>502</html>', 502).fetch).current()
    await expect(promise).rejects.toThrow(/HTTP 502 unknown_error/)
    expect(await messageOf(promise)).not.toContain('<html>')
  })

  it('reports an unreachable token endpoint as a failed refresh', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(expired()))
    const grant = unreachableFetch('offline')
    const promise = fileManager(authPath, grant.fetch).current()
    await expect(promise).rejects.toThrow(/token endpoint unreachable: Error: offline/)
    await expect(promise).rejects.toThrow(/sign in with \/login/)
    await expect(promise).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
  })

  it('reports unparseable, non-object, and token-less grant bodies as failures', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(expired()))
    await expect(fileManager(authPath, rawFetch('not json').fetch).current()).rejects.toThrow(/unparseable body/)
    await expect(fileManager(authPath, rawFetch('"text"').fetch).current()).rejects.toThrow(/non-object body/)
    await expect(fileManager(authPath, rawFetch('null').fetch).current()).rejects.toThrow(/non-object body/)
    await expect(fileManager(authPath, rawFetch('[1]').fetch).current()).rejects.toThrow(/carried no access_token/)
    await expect(fileManager(authPath, grantFetch(grantPayload({ access_token: '' })).fetch).current())
      .rejects.toThrow(/carried no access_token/)
    await expect(fileManager(authPath, grantFetch(grantPayload({ refresh_token: undefined })).fetch).current())
      .rejects.toThrow(/carried no rotated refresh_token/)
    await expect(fileManager(authPath, grantFetch(grantPayload({ refresh_token: '' })).fetch).current())
      .rejects.toThrow(/carried no rotated refresh_token/)
    const noExpiry = fileManager(authPath, grantFetch(grantPayload({ expires_at: undefined })).fetch)
    await expect(noExpiry.current()).rejects.toThrow(/stated no expiry/)
    await expect(noExpiry.current()).rejects.toThrow(/sign in with \/login/)
    await expect(noExpiry.current()).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
    await expect(fileManager(authPath, grantFetch(grantPayload({ expires_at: undefined, expires_in: 0 })).fetch).current())
      .rejects.toThrow(/stated no expiry/)
    await expect(fileManager(authPath, grantFetch(grantPayload({ expires_at: undefined, expires_in: 'soon' })).fetch).current())
      .rejects.toThrow(/stated no expiry/)
  })

  it('refuses the grant for a refresh token the store states as expired, without calling the issuer', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(expired(), { refreshTokenExpiresAt: Date.now() - 1000 }))
    const grant = grantFetch(grantPayload())
    const promise = fileManager(authPath, grant.fetch).current()
    await expect(promise).rejects.toThrow(/the stored refresh token has expired/)
    await expect(promise).rejects.toThrow(/sign in with \/login/)
    await expect(promise).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
    expect(grant.requests).toEqual([])
    expect((await readWrittenOauth(authPath))['refreshToken']).toBe('refresh-token-1')
  })

  it('runs the grant when the store states no usable refreshTokenExpiresAt', async () => {
    for (const refreshTokenExpiresAt of [0, -1000, undefined, 'soon']) {
      const authPath = await writeClaudeDocument(oauthRaw(expired(), { refreshTokenExpiresAt }))
      const grant = grantFetch(grantPayload())
      await expect(fileManager(authPath, grant.fetch).current()).resolves.toEqual({ accessToken: 'rotated-access-token' })
      expect(grant.requests).toHaveLength(1)
      expect((await readWrittenOauth(authPath))['refreshToken']).toBe('rotated-refresh-token')
    }
  })
})

describe('ClaudeSessionManager sibling adoption', () => {
  it('adopts a session a sibling refreshed into the store after a failed grant', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(expired()))
    const sibling = oauthRaw(farFuture() + 1000, {
      accessToken: 'sibling-access-token',
      refreshToken: 'sibling-refresh-token',
    })
    const fetchImpl = (async () => {
      await writeFile(authPath, JSON.stringify(documentRaw(sibling)), { mode: 0o600 })
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    await expect(fileManager(authPath, fetchImpl).current()).resolves.toEqual({ accessToken: 'sibling-access-token' })
    expect((await readWrittenOauth(authPath))['refreshToken']).toBe('sibling-refresh-token')
  })

  it('keeps a fresher sibling rotation instead of overwriting it after our own grant succeeded', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(nearlyExpired()))
    const sibling = oauthRaw(farFuture() + 1000, {
      accessToken: 'sibling-access-token',
      refreshToken: 'sibling-refresh-token',
      rateLimitTier: 'sibling_tier',
    })
    const fetchImpl = (async () => {
      await writeFile(authPath, JSON.stringify(documentRaw(sibling)), { mode: 0o600 })
      return new Response(JSON.stringify(grantPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await expect(fileManager(authPath, fetchImpl).current()).resolves.toEqual({ accessToken: 'sibling-access-token' })
    const rotated = await readWrittenOauth(authPath)
    expect(rotated['accessToken']).toBe('sibling-access-token')
    expect(rotated['refreshToken']).toBe('sibling-refresh-token')
    expect(rotated['rateLimitTier']).toBe('sibling_tier')
  })

  it('overwrites an expired sibling rotation after our own grant succeeded', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(nearlyExpired()))
    const sibling = oauthRaw(expired(), { accessToken: 'stale-sibling-access-token', refreshToken: 'sibling-refresh-token' })
    const fetchImpl = (async () => {
      await writeFile(authPath, JSON.stringify(documentRaw(sibling)), { mode: 0o600 })
      return new Response(JSON.stringify(grantPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await expect(fileManager(authPath, fetchImpl).current()).resolves.toEqual({ accessToken: 'rotated-access-token' })
    expect((await readWrittenOauth(authPath))['refreshToken']).toBe('rotated-refresh-token')
  })

  it('writes the rotation as the whole document when the store vanished first', async () => {
    const dir = await tempDir()
    const authPath = await writeClaudeDocument(oauthRaw(nearlyExpired()), { unknownRootSibling: 'lost' }, dir)
    const fetchImpl = (async () => {
      await rm(authPath, { force: true })
      return new Response(JSON.stringify(grantPayload()), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await expect(fileManager(authPath, fetchImpl).current()).resolves.toEqual({ accessToken: 'rotated-access-token' })
    const written = await readWritten(authPath)
    const rotated = written['claudeAiOauth'] as Record<string, unknown>
    expect(rotated['accessToken']).toBe('rotated-access-token')
    expect(rotated['refreshToken']).toBe('rotated-refresh-token')
    expect(written['mcpOAuth']).toBeUndefined()
    expect((await stat(authPath)).mode & 0o777).toBe(0o600)
  })

  it('fails AUTH_REFRESH_FAILED when the store vanished before adoption', async () => {
    const authPath = await writeClaudeDocument(oauthRaw(expired()))
    const fetchImpl = (async () => {
      await rm(authPath, { force: true })
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    await expect(fileManager(authPath, fetchImpl).current()).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
  })

  it('propagates a store that became unreadable during a failed refresh', async () => {
    const dir = await tempDir()
    const authPath = await writeClaudeDocument(oauthRaw(expired()), {}, dir)
    const fetchImpl = (async () => {
      await rm(authPath, { force: true })
      await mkdir(authPath, { mode: 0o700 })
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    await expect(fileManager(authPath, fetchImpl).current()).rejects.toThrow(/illegal operation on a directory/)
  })
})

describe('ClaudeSessionManager keychain write', () => {
  it('writes the merged document through the injected keychain writer', async () => {
    const keychain = fakeKeychain({
      [KEYCHAIN_SERVICE]: JSON.stringify(documentRaw(oauthRaw(expired()), { unknownRootSibling: 'kept' })),
    })
    const writes: { service: string; account: string; json: string }[] = []
    const manager = keychainManager(grantFetch(grantPayload()).fetch, {
      keychainAccount: 'configured-account',
      readKeychain: keychain.read,
      writeKeychain: async (service, account, json) => { writes.push({ service, account, json }) },
    })
    await expect(manager.current()).resolves.toEqual({ accessToken: 'rotated-access-token' })
    expect(writes).toHaveLength(1)
    const write = writes[0]!
    expect(write.service).toBe(KEYCHAIN_SERVICE)
    expect(write.account).toBe('configured-account')
    // security -w hex-encodes a password that contains a newline, and the
    // read path would then not see a document. The writer hands it one line.
    expect(write.json).not.toContain('\n')
    const document = JSON.parse(write.json) as Record<string, unknown>
    expect(document['unknownRootSibling']).toBe('kept')
    expect(document['mcpOAuth']).toEqual(MCP_OAUTH)
    const rotated = document['claudeAiOauth'] as Record<string, unknown>
    expect(rotated['accessToken']).toBe('rotated-access-token')
    expect(rotated['refreshToken']).toBe('rotated-refresh-token')
    expect(rotated['expiresAt']).toBe(GRANT_EXPIRES_AT)
    expect(rotated['subscriptionType']).toBe('max')
  })
})

describe('ClaudeSessionManager through the security tool', () => {
  it('serves the item the tool prints for the keychain service', async () => {
    if (process.platform === 'win32') return
    const standIn = await securityStandIn(JSON.stringify(documentRaw(oauthRaw(farFuture()))))
    const token = await keychainManager(unexpectedGrant, { securityPath: standIn.path }).current()
    expect(token).toEqual({ accessToken: 'access-token-1' })
    expect(await standIn.argv()).toEqual(['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE])
  })

  it('treats a tool that prints no usable item as no credential', async () => {
    if (process.platform === 'win32') return
    const standIn = await securityStandIn('   \n')
    await expect(keychainManager(unexpectedGrant, { securityPath: standIn.path }).current())
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('treats a tool that fails as no credential, naming the sign-in step', async () => {
    if (process.platform === 'win32') return
    const standIn = await failingSecurityStandIn()
    const promise = keychainManager(unexpectedGrant, { securityPath: standIn.path }).current()
    await expect(promise).rejects.toThrow(/the login keychain item "Claude Code-credentials"/)
    await expect(promise).rejects.toThrow(/sign in with \/login/)
    await expect(promise).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('writes the rotation through the tool under the configured account', async () => {
    if (process.platform === 'win32') return
    const standIn = await securityStandIn(JSON.stringify(documentRaw(oauthRaw(expired()))))
    const manager = keychainManager(grantFetch(grantPayload()).fetch, {
      securityPath: standIn.path,
      keychainAccount: 'configured-account',
    })
    await expect(manager.current()).resolves.toEqual({ accessToken: 'rotated-access-token' })
    const argv = await standIn.argv()
    expect(argv.slice(0, 7))
      .toEqual(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', 'configured-account', '-w'])
    const document = JSON.parse(argv.slice(7).join('\n')) as Record<string, unknown>
    const rotated = document['claudeAiOauth'] as Record<string, unknown>
    expect(rotated['accessToken']).toBe('rotated-access-token')
    expect(rotated['refreshToken']).toBe('rotated-refresh-token')
    expect(rotated['expiresAt']).toBe(GRANT_EXPIRES_AT)
    expect(document['mcpOAuth']).toEqual(MCP_OAUTH)
  })
})

describe('ClaudeSessionManager failed keychain writes', () => {
  it('report the exit status and a summary with the document and account redacted', async () => {
    if (process.platform === 'win32') return
    const standIn = await refusingWriteSecurityStandIn(JSON.stringify(documentRaw(oauthRaw(expired()))))
    const manager = keychainManager(grantFetch(grantPayload()).fetch, { securityPath: standIn.path })
    const message = await messageOf(manager.current())
    expect(message).toMatch(/the login keychain refused the rotated credential \(exit 51: /)
    expect(message).toMatch(/sign in with \/login/)
    // The tool's own diagnostic repeats the whole command line it was handed,
    // which is where the rotated document lives; only the redaction markers of
    // the values this engine knows may appear.
    expect(message).toContain('<credential>')
    for (const value of ['rotated-access-token', 'rotated-refresh-token', 'access-token-1', 'refresh-token-1', 'claude-user', 'claudeAiOauth']) {
      expect(message).not.toContain(value)
    }
    // The seam's own failure, not a wrap: the credential exists, its rotation
    // could not be stored.
    await expect(manager.current()).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
  })

  it('report the exit status alone when the tool prints no summary', async () => {
    if (process.platform === 'win32') return
    const standIn = await silentRefusingWriteSecurityStandIn(JSON.stringify(documentRaw(oauthRaw(expired()))))
    const message = await messageOf(keychainManager(grantFetch(grantPayload()).fetch, { securityPath: standIn.path }).current())
    expect(message).toContain('(exit 51)')
    expect(message).not.toContain('<credential>')
  })

  it('report no exit status when the tool never started, still without the document', async () => {
    if (process.platform === 'win32') return
    const standIn = await securityStandIn(JSON.stringify(documentRaw(oauthRaw(expired()))))
    const grant = grantFetch(grantPayload())
    // The tool vanishes between the read and the write, which is when the exec
    // rejection carries a libuv code instead of an exit status.
    const fetchImpl: typeof fetch = async (url, init) => {
      await rm(standIn.path, { force: true })
      return await grant.fetch(url, init)
    }
    const message = await messageOf(keychainManager(fetchImpl, { securityPath: standIn.path }).current())
    expect(message).toMatch(/refused the rotated credential \(no exit status\)/)
    expect(message).not.toContain('rotated-access-token')
  })

  it('redact the document when the configured keychain account is empty', async () => {
    if (process.platform === 'win32') return
    const standIn = await refusingWriteSecurityStandIn(JSON.stringify(documentRaw(oauthRaw(expired()))))
    const message = await messageOf(keychainManager(grantFetch(grantPayload()).fetch, {
      securityPath: standIn.path,
      keychainAccount: '',
    }).current())
    expect(message).toContain('<credential>')
    expect(message).not.toContain('rotated-refresh-token')
  })
})

describe('Claude Code session source defaults', () => {
  it('names the CLI credential document under the user home directory', () => {
    const authPath = defaultAuthPath()
    expect(authPath).toBe(join(homedir(), '.claude', '.credentials.json'))
    expect(isAbsolute(authPath)).toBe(true)
  })
})
