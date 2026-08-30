/**
 * Grok Build CLI session credential: read the OIDC session `~/.grok/auth.json`
 * holds, refresh the access token through the issuer's `refresh_token` grant
 * when it is at or past the configured leeway, and persist the rotated values
 * back in the CLI's own document format. Values never reach diagnostics: an
 * entry key names its issuer and client id, a refresh failure names the
 * issuer's error code, and nothing else about the credential is ever quoted.
 * @module @shres-code/shres-code-llm-grok-session/session
 */

import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { LlmError } from '@shres-code/shres-code-llm'

/** OIDC issuer the Grok Build CLI's own login flow authenticates against. */
export const OIDC_ISSUER = 'https://auth.x.ai'

/** Prefix of every auth-document entry key this session can serve. */
export const ENTRY_KEY_PREFIX = `${OIDC_ISSUER}::`

/** Permission bits outside the owner; a session document must have none of them. */
const GROUP_OTHER_BITS = 0o077

/** One selected session entry: the facts refresh and dispatch need. */
export interface GrokSessionEntry {
  /** Access token sent as the request's bearer credential. */
  key: string
  /** OIDC refresh token for the `refresh_token` grant. */
  refreshToken: string
  /** OAuth client id the credential is bound to; the refresh grant echoes it. */
  clientId: string
  /** Access-token expiry in epoch milliseconds. */
  expiresAtMs: number
  /** The document entry verbatim; rotation rewrites this object. */
  raw: Record<string, unknown>
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Decode one access token's `exp` claim without verifying the signature: the
 * document was written by the CLI that obtained the token, and the claim only
 * backs up a missing `expires_at` field.
 * @param key - the access token, a JWT.
 * @returns the claim's epoch-millisecond value, or `undefined` when absent or malformed.
 */
function expiryFromToken(key: string): number | undefined {
  const payload = key.split('.')[1]
  if (payload === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const exp = (parsed as Record<string, unknown>)['exp']
  if (typeof exp !== 'number') return undefined
  if (!Number.isFinite(exp)) return undefined
  return exp * 1000
}

/**
 * Extract the session facts one document entry carries, failing loud when the
 * document no longer holds what a session needs. The message names fields and
 * the document path; values stay unquoted.
 * @param entryKey - the document key, `${issuer}::${clientId}`.
 * @param raw - the entry object.
 * @param authPath - document path, quoted in diagnostics.
 * @returns the selected entry facts.
 */
function toSessionEntry(entryKey: string, raw: Record<string, unknown>, authPath: string): GrokSessionEntry {
  const key = raw['key']
  const refreshToken = raw['refresh_token']
  if (typeof key !== 'string' || key.length === 0 || typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new LlmError(
      `llm-grok-session: ${authPath} entry "${entryKey}" has no usable key/refresh_token pair;`
      + ' run "grok login" to refresh the session document',
      'MISSING_CREDENTIAL',
    )
  }
  const clientId = typeof raw['oidc_client_id'] === 'string' && raw['oidc_client_id'].length > 0
    ? raw['oidc_client_id']
    : entryKey.slice(ENTRY_KEY_PREFIX.length)
  const declared = raw['expires_at']
  const expiresAtMs = typeof declared === 'string' && Number.isFinite(Date.parse(declared))
    ? Date.parse(declared)
    : expiryFromToken(key)
  if (expiresAtMs === undefined) {
    throw new LlmError(
      `llm-grok-session: ${authPath} entry "${entryKey}" states no usable expiry`
      + ' (neither expires_at nor an exp claim); the document format is not one this adapter reads',
      'MISSING_CREDENTIAL',
    )
  }
  return { key, refreshToken, clientId, expiresAtMs, raw }
}

/**
 * Parse and select the session entry an auth document serves. Selection takes
 * the newest `${issuer}::` entry, so a document carrying several client
 * registrations (a CLI update that re-registered) resolves deterministically
 * to the most recent login.
 * @param text - the document text.
 * @param authPath - document path, quoted in diagnostics.
 * @returns the selected entry, or `undefined` when the document holds no issuer entry at all.
 */
export function selectSessionEntry(text: string, authPath: string): GrokSessionEntry | undefined {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    /* v8 ignore next -- JSON.parse rejections are always Error instances on
       every supported runtime. */
    const name = error instanceof Error ? error.name : 'parse failed'
    throw new LlmError(
      `llm-grok-session: ${authPath} is not valid JSON (${name});`
      + ' run "grok login" to rewrite the session document',
      'MISSING_CREDENTIAL',
    )
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new LlmError(
      `llm-grok-session: ${authPath} must be a JSON object of session entries`,
      'MISSING_CREDENTIAL',
    )
  }
  const candidates = Object.entries(document as Record<string, unknown>)
    .filter(([entryKey, value]) => entryKey.startsWith(ENTRY_KEY_PREFIX) && typeof value === 'object' && value !== null)
    .map(([entryKey, value]) => toSessionEntry(entryKey, value as Record<string, unknown>, authPath))
  if (candidates.length === 0) return undefined
  return candidates.reduce((newest, entry) =>
    entry.expiresAtMs > newest.expiresAtMs
      ? entry
      : entry.expiresAtMs === newest.expiresAtMs && entry.clientId > newest.clientId ? entry : newest)
}

/**
 * One JSON error body the token endpoint returns; only its code and
 * description are quoted, never a token.
 */
interface TokenErrorBody {
  error?: unknown
  error_description?: unknown
}

/** Transport and parsing hooks the manager runs through; tests substitute them. */
export interface GrokSessionOptions {
  /** Absolute path of the Grok Build CLI auth document. */
  authPath: string
  /** Refresh when the token is at or within this many milliseconds of expiry. */
  refreshLeewayMs: number
  /** Injected fetch (tests). Defaults to global fetch. */
  fetch?: typeof fetch
  /** Injected clock in epoch milliseconds (tests). Defaults to Date.now. */
  now?: () => number
}

/**
 * Resolve the current bearer token for the Grok subscription session: serve
 * the document's access token while it is valid, otherwise run one
 * `refresh_token` grant and persist the rotation. Concurrent callers share
 * one in-flight refresh instead of racing the issuer with the same (possibly
 * single-use) refresh token.
 */
export class GrokSessionManager {
  private readonly options: GrokSessionOptions
  private inFlight: Promise<string> | undefined

  constructor(options: GrokSessionOptions) {
    this.options = options
  }

  /**
   * The bearer credential for one request. Concurrent callers share the
   * whole resolve — read, freshness check, and grant — so two requests that
   * land on an expired document cannot race the issuer with the same
   * (possibly single-use) refresh token.
   * @returns a current access token.
   */
  accessToken(): Promise<string> {
    this.inFlight ??= this.resolve().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /** One shared resolve: read the document, serve a valid token, else refresh. */
  private async resolve(): Promise<string> {
    const current = await this.readEntry()
    if (current.expiresAtMs - this.options.refreshLeewayMs > (this.options.now ?? Date.now)()) return current.key
    return this.refresh(current)
  }

  /** Read and select the document entry, or fail with the not-logged-in posture. */
  private async readEntry(): Promise<GrokSessionEntry> {
    let text: string
    try {
      await this.assertOwnerOnly()
      text = await readFile(this.options.authPath, 'utf8')
    } catch (error) {
      if (isENOENT(error)) {
        throw new LlmError(
          `llm-grok-session: no Grok session at ${this.options.authPath};`
          + ' run "grok login" once, or mount the route disabled where the CLI is not signed in',
          'MISSING_CREDENTIAL',
        )
      }
      throw error
    }
    const entry = selectSessionEntry(text, this.options.authPath)
    if (entry === undefined) {
      throw new LlmError(
        `llm-grok-session: ${this.options.authPath} holds no ${OIDC_ISSUER} session entry;`
        + ' run "grok login" to create one',
        'MISSING_CREDENTIAL',
      )
    }
    return entry
  }

  /**
   * The CLI stores the session at owner-only mode; serving a token out of a
   * document other OS users can read would defeat that promise.
   */
  private async assertOwnerOnly(): Promise<void> {
    /* v8 ignore next -- POSIX coverage cannot take the Windows peer; native
     Windows coverage enforces it instead, as in credentials-local. */
    if (process.platform === 'win32') return
    const mode = (await stat(this.options.authPath)).mode & 0o777
    if ((mode & GROUP_OTHER_BITS) !== 0) {
      throw new LlmError(
        `llm-grok-session: ${this.options.authPath} is readable beyond its owner (mode ${mode.toString(8)});`
        + ` run "chmod 600 ${this.options.authPath}" before starting again`,
        'MISSING_CREDENTIAL',
      )
    }
  }

  /** Whether one entry still holds a usable token under the refresh leeway. */
  private isValid(entry: GrokSessionEntry, leewayMs = 0): boolean {
    return entry.expiresAtMs - leewayMs > (this.options.now ?? Date.now)()
  }

  /**
   * Run the refresh grant for one expired entry. A sibling process (the CLI
   * itself, or another harness) may refresh the same document concurrently,
   * so both failure and success re-read the disk before concluding: a valid
   * token another writer persisted wins over re-authenticating, and a
   * successful rotation is merged into the latest document state before the
   * atomic write.
   * @param expired - the entry whose refresh token seeds the grant.
   * @returns a current access token.
   */
  private async refresh(expired: GrokSessionEntry): Promise<string> {
    /* v8 ignore next -- production runs without an injected fetch and reaches
       the real issuer; every test injects a stub instead. */
    const fetchImpl = this.options.fetch ?? fetch
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: expired.clientId,
      refresh_token: expired.refreshToken,
    })
    let response: Response
    try {
      response = await fetchImpl(`${OIDC_ISSUER}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
    } catch (error) {
      return await this.adoptOrThrow(`token endpoint unreachable: ${String(error)}`)
    }
    if (!response.ok) {
      const detail = await this.describeTokenError(response)
      return await this.adoptOrThrow(detail)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return await this.adoptOrThrow('token endpoint returned an unparseable body')
    }
    if (typeof payload !== 'object' || payload === null) {
      return await this.adoptOrThrow('token endpoint returned a non-object body')
    }
    const grant = payload as Record<string, unknown>
    const accessToken = grant['access_token']
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return await this.adoptOrThrow('token grant carried no access_token')
    }
    const expiresIn = grant['expires_in']
    const rotatedAt = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
      ? (this.options.now ?? Date.now)() + expiresIn * 1000
      : expiryFromToken(accessToken)
    if (rotatedAt === undefined) {
      return await this.adoptOrThrow('token grant stated no expiry (neither expires_in nor an exp claim)')
    }
    const refreshToken = grant['refresh_token']
    const rotated: GrokSessionEntry = {
      key: accessToken,
      refreshToken: typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : expired.refreshToken,
      clientId: expired.clientId,
      expiresAtMs: rotatedAt,
      raw: {
        ...expired.raw,
        key: accessToken,
        ...(typeof refreshToken === 'string' && refreshToken.length > 0 ? { refresh_token: refreshToken } : {}),
        expires_at: new Date(rotatedAt).toISOString(),
      },
    }
    return await this.persistRotation(expired, rotated)
  }

  /**
   * After a failed grant, adopt a token a concurrent writer refreshed into
   * the document; without one, the failure is the answer.
   * @param detail - human-readable grant failure, safe to surface.
   * @returns the sibling's current token when one appeared.
   */
  private async adoptOrThrow(detail: string): Promise<string> {
    const text = await this.readDocumentTextOrNull()
    if (text !== null) {
      const sibling = selectSessionEntry(text, this.options.authPath)
      if (sibling !== undefined && this.isValid(sibling)) return sibling.key
    }
    throw new LlmError(
      `llm-grok-session: refreshing the Grok session at ${this.options.authPath} failed (${detail});`
      + ' run "grok login" to sign in again',
      'AUTH_REFRESH_FAILED',
    )
  }

  /**
   * Merge one rotated entry into the document and write it atomically,
   * unless a sibling already persisted a different, still-valid token — its
   * refresh token is the one the issuer expects next, so adopting it beats
   * overwriting it.
   * @param expired - the entry the grant started from.
   * @param rotated - the granted entry to persist.
   * @returns the token to serve: the granted one, or a sibling's when its
   *   fresher rotation won the document race.
   */
  private async persistRotation(expired: GrokSessionEntry, rotated: GrokSessionEntry): Promise<string> {
    const text = await this.readDocumentTextOrNull()
    if (text !== null) {
      const sibling = selectSessionEntry(text, this.options.authPath)
      if (sibling !== undefined && sibling.refreshToken !== expired.refreshToken && this.isValid(sibling)) {
        return sibling.key
      }
    }
    const document = text === null
      ? { [this.entryKey(rotated)]: rotated.raw }
      : { ...(JSON.parse(text) as Record<string, unknown>), [this.entryKey(rotated)]: rotated.raw }
    const staging = join(dirname(this.options.authPath), `.auth.json.shres-${process.pid}-${randomBytes(4).toString('hex')}`)
    await writeFile(staging, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 })
    await chmod(staging, 0o600)
    await rename(staging, this.options.authPath)
    return rotated.key
  }

  /** The document key a rotated entry persists under. */
  private entryKey(entry: GrokSessionEntry): string {
    return `${ENTRY_KEY_PREFIX}${entry.clientId}`
  }

  /** The document text, or `null` when absent; every other read error surfaces. */
  private async readDocumentTextOrNull(): Promise<string | null> {
    try {
      return await readFile(this.options.authPath, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return null
      throw error
    }
  }

  /** Describe one failed token response from its JSON error fields only. */
  private async describeTokenError(response: Response): Promise<string> {
    let body: TokenErrorBody = {}
    try {
      const parsed: unknown = await response.json()
      if (typeof parsed === 'object' && parsed !== null) body = parsed
    } catch {
      // A non-JSON error body is described by its status alone; quoting an
      // opaque body could surface server-side text nobody vetted.
    }
    const code = typeof body.error === 'string' ? body.error : 'unknown_error'
    const description = typeof body.error_description === 'string' ? `: ${body.error_description}` : ''
    return `HTTP ${String(response.status)} ${code}${description}`
  }
}
