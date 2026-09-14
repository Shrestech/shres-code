/**
 * Cursor Agent CLI session credential: read the login the CLI's
 * `cursor-agent login` stored — the macOS login keychain's
 * `cursor-access-token` / `cursor-refresh-token` items by default, or the
 * file store the CLI writes under `AGENT_CLI_CREDENTIAL_STORE=file` — serve
 * the access token while its JWT `exp` holds, and adopt whatever the CLI
 * rotates in on the next resolve. The issuer the token's `iss` names is not
 * resolvable publicly, so this engine never runs a refresh grant itself: the
 * CLI owns rotation, and an expired token fails loud with the
 * `cursor-agent login` step. Values never reach diagnostics.
 * @module @shres-code/shres-code-cursor-credential/session
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { LlmError } from '@shres-code/shres-code-llm'

const execFileAsync = promisify(execFile)

/** Keychain service `cursor-agent login` writes the access token under. */
export const KEYCHAIN_ACCESS_SERVICE = 'cursor-access-token'

/** Keychain service `cursor-agent login` writes the refresh token under. */
export const KEYCHAIN_REFRESH_SERVICE = 'cursor-refresh-token'

/** Keychain account both services hold their items under. */
export const KEYCHAIN_ACCOUNT = 'cursor-user'

/** Default path of the CLI's file-store document (`AGENT_CLI_CREDENTIAL_STORE=file`). */
export const DEFAULT_AUTH_PATH = '~/.cursor/auth.json'

/** Default path of the macOS security tool that reads the login keychain. */
export const DEFAULT_SECURITY_PATH = '/usr/bin/security'

/** One selected session: the facts a request needs. */
export interface CursorSessionEntry {
  /** Access token sent as the request's bearer credential. */
  accessToken: string
  /** Refresh token when the source carries one; the CLI owns its use. */
  refreshToken: string | undefined
  /** Access-token expiry in epoch milliseconds, from the JWT `exp` claim. */
  expiresAtMs: number
  /** Where the entry was read from, quoted in diagnostics. */
  source: string
}

/** Reader hooks the manager runs through; tests substitute them. */
export interface CursorSessionOptions {
  /** macOS security tool path used for the keychain source. */
  securityPath: string
  /**
   * File-store document path. Read only when `useKeychain` is false: the
   * CLI's default store on macOS is the keychain, and the file exists only
   * under `AGENT_CLI_CREDENTIAL_STORE=file`.
   */
  authPath: string
  /** Whether the keychain source is in use. */
  useKeychain: boolean
  /** Injected keychain reader (tests). Defaults to the security tool. */
  readKeychain?: (service: string) => Promise<string | undefined>
  /** Injected clock in epoch milliseconds (tests). Defaults to Date.now. */
  now?: () => number
}

/**
 * Decode the token's `exp` claim without verifying the signature: the
 * credential was written by the CLI that obtained the token, and no other
 * expiry fact backs it up.
 * @param token - the access token, a JWT.
 * @returns the claim's epoch-millisecond value, or `undefined` when absent or malformed.
 */
export function expiryFromToken(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const exp = (parsed as Record<string, unknown>)['exp']
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined
  return exp * 1000
}

/**
 * Validate the credential pair a source served, failing loud with the login
 * step when it cannot serve a request.
 * @param accessToken - the access token a source read.
 * @param refreshToken - the refresh token a source read, when present.
 * @param source - source description, quoted in diagnostics.
 * @returns the selected session facts.
 */
export function toSessionEntry(
  accessToken: string | undefined,
  refreshToken: string | undefined,
  source: string,
): CursorSessionEntry {
  if (accessToken === undefined || accessToken.length === 0) {
    throw new LlmError(
      `llm-cursor-session: ${source} carries no Cursor access token;`
      + ' run "cursor-agent login" once, or mount the route disabled where the CLI is not signed in',
      'MISSING_CREDENTIAL',
    )
  }
  const expiresAtMs = expiryFromToken(accessToken)
  if (expiresAtMs === undefined) {
    throw new LlmError(
      `llm-cursor-session: ${source} access token states no usable exp claim;`
      + ' the credential format is not one this adapter reads',
      'MISSING_CREDENTIAL',
    )
  }
  return {
    accessToken,
    refreshToken: refreshToken !== undefined && refreshToken.length > 0 ? refreshToken : undefined,
    expiresAtMs,
    source,
  }
}

/** The credential facts one request needs. */
export interface CursorSessionToken {
  /** Bearer credential for the request. */
  accessToken: string
}

/**
 * Resolve the current credential for the Cursor subscription session: read
 * the CLI's store, serve the access token while its JWT is valid, and fail
 * loud — never refresh — when it has expired, because the issuer the token
 * names is not resolvable and the CLI owns rotation. Concurrent callers share
 * one in-flight read.
 */
export class CursorSessionManager {
  private readonly options: CursorSessionOptions
  private inFlight: Promise<CursorSessionToken> | undefined

  constructor(options: CursorSessionOptions) {
    this.options = options
  }

  /**
   * The token for one request. Concurrent callers share the whole read.
   * @returns the current session credential.
   */
  current(): Promise<CursorSessionToken> {
    this.inFlight ??= this.resolve().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /** One shared resolve: read the store, serve a valid token, else fail loud. */
  private async resolve(): Promise<CursorSessionToken> {
    const entry = await this.readEntry()
    const now = (this.options.now ?? Date.now)()
    if (entry.expiresAtMs <= now) {
      throw new LlmError(
        `llm-cursor-session: ${entry.source} access token has expired;`
        + ' run "cursor-agent login" to rotate it — this engine adopts the CLI\'s rotation on the next resolve',
        'AUTH_REFRESH_FAILED',
      )
    }
    return { accessToken: entry.accessToken }
  }

  /** Read the configured source's credential, or fail with the not-logged-in posture. */
  private async readEntry(): Promise<CursorSessionEntry> {
    return this.options.useKeychain ? this.readKeychainEntry() : this.readFileEntry()
  }

  /** Read both keychain services through the security tool. */
  private async readKeychainEntry(): Promise<CursorSessionEntry> {
    const read = this.options.readKeychain ?? this.readViaSecurity.bind(this)
    const [accessToken, refreshToken] = await Promise.all([
      read(KEYCHAIN_ACCESS_SERVICE),
      read(KEYCHAIN_REFRESH_SERVICE),
    ])
    return toSessionEntry(
      accessToken,
      refreshToken,
      `keychain services ${KEYCHAIN_ACCESS_SERVICE}/${KEYCHAIN_REFRESH_SERVICE}`,
    )
  }

  /** One keychain service read; an unreadable item is absence, other failures surface. */
  private async readViaSecurity(service: string): Promise<string | undefined> {
    let stdout: string
    try {
      const result = await execFileAsync(this.options.securityPath, [
        'find-generic-password', '-w',
        '-s', service,
        '-a', KEYCHAIN_ACCOUNT,
      ])
      stdout = result.stdout
    } catch {
      return undefined
    }
    const value = stdout.trim()
    return value.length > 0 ? value : undefined
  }

  /** Read the file-store document's access/refresh pair. */
  private async readFileEntry(): Promise<CursorSessionEntry> {
    let text: string
    try {
      text = await readFile(this.options.authPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        throw new LlmError(
          `llm-cursor-session: no Cursor session at ${this.options.authPath};`
          + ' run "cursor-agent login" once, or mount the route disabled where the CLI is not signed in',
          'MISSING_CREDENTIAL',
        )
      }
      throw error
    }
    let document: unknown
    try {
      document = JSON.parse(text)
    } catch {
      throw new LlmError(
        `llm-cursor-session: ${this.options.authPath} is not readable JSON;`
        + ' run "cursor-agent login" to rewrite it',
        'MISSING_CREDENTIAL',
      )
    }
    if (typeof document !== 'object' || document === null) {
      throw new LlmError(
        `llm-cursor-session: ${this.options.authPath} must be a JSON object`,
        'MISSING_CREDENTIAL',
      )
    }
    const root = document as Record<string, unknown>
    const accessToken = root['accessToken'] ?? root['access_token']
    const refreshToken = root['refreshToken'] ?? root['refresh_token']
    return toSessionEntry(
      typeof accessToken === 'string' ? accessToken : undefined,
      typeof refreshToken === 'string' ? refreshToken : undefined,
      this.options.authPath,
    )
  }
}
