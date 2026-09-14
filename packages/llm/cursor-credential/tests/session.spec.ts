/**
 * Session-manager behavior: serve a valid credential from the keychain or
 * the file store, re-read on every resolve so the CLI's rotations are
 * adopted, share one in-flight read, and fail loud — naming the source and
 * the fix, never a value.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CursorSessionManager, toSessionEntry } from '../src/index.ts'
import { expired, fakeKeychain, farFuture, tokenWithExp } from './helpers.ts'

const KEYCHAIN_SPEC = {
  securityPath: '/usr/bin/security',
  authPath: '/home/u/.cursor/auth.json',
  useKeychain: true,
}

async function fileSpec(): Promise<{ spec: { securityPath: string; authPath: string; useKeychain: boolean }; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-session-'))
  return { spec: { securityPath: '/usr/bin/security', authPath: join(dir, 'auth.json'), useKeychain: false }, dir }
}

describe('CursorSessionManager (keychain source)', () => {
  it('serves a far-from-expiry access token from the keychain', async () => {
    const keychain = fakeKeychain({
      'cursor-access-token': tokenWithExp(farFuture()),
      'cursor-refresh-token': 'refresh-1',
    })
    const manager = new CursorSessionManager({ ...KEYCHAIN_SPEC, readKeychain: keychain.read })
    await expect(manager.current()).resolves.toEqual({ accessToken: tokenWithExp(farFuture()) })
    expect(keychain.reads.sort()).toEqual(['cursor-access-token', 'cursor-refresh-token'])
  })

  it('fails AUTH_REFRESH_FAILED naming cursor-agent login when the token has expired', async () => {
    const keychain = fakeKeychain({ 'cursor-access-token': tokenWithExp(expired()) })
    const manager = new CursorSessionManager({ ...KEYCHAIN_SPEC, readKeychain: keychain.read })
    await expect(manager.current()).rejects.toThrow(/cursor-agent login/)
    await expect(manager.current()).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
  })

  it('fails MISSING_CREDENTIAL when the keychain holds no access token', async () => {
    const manager = new CursorSessionManager({ ...KEYCHAIN_SPEC, readKeychain: fakeKeychain({}).read })
    await expect(manager.current()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('adopts the CLI\'s rotation by re-reading on every resolve', async () => {
    let current = tokenWithExp(farFuture())
    const manager = new CursorSessionManager({
      ...KEYCHAIN_SPEC,
      readKeychain: service => Promise.resolve(service === 'cursor-access-token' ? current : undefined),
    })
    const first = await manager.current()
    current = tokenWithExp(farFuture() + 1000)
    const second = await manager.current()
    expect(second.accessToken).not.toBe(first.accessToken)
  })

  it('shares one in-flight read across concurrent callers', async () => {
    const keychain = fakeKeychain({ 'cursor-access-token': tokenWithExp(farFuture()) })
    const manager = new CursorSessionManager({ ...KEYCHAIN_SPEC, readKeychain: keychain.read })
    const [a, b, c] = await Promise.all([manager.current(), manager.current(), manager.current()])
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(keychain.reads.filter(s => s === 'cursor-access-token')).toHaveLength(1)
  })
})

describe('CursorSessionManager (file source)', () => {
  it('serves a valid accessToken/refreshToken document', async () => {
    const { spec } = await fileSpec()
    await writeFile(spec.authPath, JSON.stringify({ accessToken: tokenWithExp(farFuture()), refreshToken: 'refresh-1' }))
    await expect(new CursorSessionManager(spec).current()).resolves.toEqual({ accessToken: tokenWithExp(farFuture()) })
  })

  it('accepts the snake_case field spellings the CLI writes', async () => {
    const { spec } = await fileSpec()
    await writeFile(spec.authPath, JSON.stringify({ access_token: tokenWithExp(farFuture()), refresh_token: 'refresh-1' }))
    await expect(new CursorSessionManager(spec).current()).resolves.toBeDefined()
  })

  it('fails MISSING_CREDENTIAL naming the path when the document is absent', async () => {
    const { spec } = await fileSpec()
    await expect(new CursorSessionManager(spec).current())
      .rejects.toThrow(new RegExp(spec.authPath.replace(/\//g, '\\/')))
      .catch(() => expect(new CursorSessionManager(spec).current()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' }))
  })

  it('fails MISSING_CREDENTIAL on malformed JSON', async () => {
    const { spec } = await fileSpec()
    await writeFile(spec.authPath, '{not json')
    await expect(new CursorSessionManager(spec).current()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('fails AUTH_REFRESH_FAILED on an expired document token', async () => {
    const { spec } = await fileSpec()
    await writeFile(spec.authPath, JSON.stringify({ accessToken: tokenWithExp(expired()) }))
    await expect(new CursorSessionManager(spec).current()).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' })
  })
})

describe('toSessionEntry validation', () => {
  it('rejects a non-JWT access token with MISSING_CREDENTIAL', () => {
    expect(() => toSessionEntry('not-a-jwt', undefined, 'src')).toThrow(/no usable exp claim/)
  })

  it('keeps a refresh token only when non-empty', () => {
    expect(toSessionEntry(tokenWithExp(farFuture()), '', 'src').refreshToken).toBeUndefined()
    expect(toSessionEntry(tokenWithExp(farFuture()), 'r', 'src').refreshToken).toBe('r')
  })
})
