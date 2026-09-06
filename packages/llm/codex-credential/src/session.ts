/**
 * Codex CLI session credential: read the ChatGPT-login session
 * `~/.codex/auth.json` holds, refresh the access token through
 * auth.openai.com's `refresh_token` grant when it is at or past the
 * configured leeway, and persist the rotated values back in the CLI's own
 * document format. Values never reach diagnostics: a refresh failure names
 * the issuer's error code, and nothing about the credential is ever quoted.
 * @module @shres-code/shres-code-codex-credential/session
 */

import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { LlmError } from '@shres-code/shres-code-llm'

/** OAuth issuer the Codex CLI's ChatGPT login authenticates against. */
export const OIDC_ISSUER = 'https://auth.openai.com'

/** Token endpoint the issuer's `refresh_token` grant posts to. */
export const TOKEN_URL = `${OIDC_ISSUER}/oauth/token`

/**
 * OAuth client id the Codex CLI binds its ChatGPT login to; the refresh
 * grant echoes it. Source: the CLI's own `oauth_client_id()`.
 */
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** Permission bits outside the owner; a session document must have none of them. */
const GROUP_OTHER_BITS = 0o077

/** One selected session: the facts refresh and dispatch need. */
export interface CodexSessionEntry {
  /** Access token sent as the request's bearer credential. */
  accessToken: string
  /** OAuth refresh token for the `refresh_token` grant. */
  refreshToken: string
  /** ChatGPT account id the backend routes the subscription by. */
  accountId: string
  /** Access-token expiry in epoch milliseconds. */
  expiresAtMs: number
  /** The document's `tokens` object verbatim; rotation rewrites this object. */
  raw: Record<string, unknown>
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Decode one token's `exp` claim without verifying the signature: the
 * document was written by the CLI that obtained the token, and the codex
 * document carries no separate expiry field to back it up.
 * @param token - the access token, a JWT.
 * @returns the claim's epoch-millisecond value, or `undefined` when absent or malformed.
 */
function expiryFromToken(token: string): number | undefined {
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
  if (typeof exp !== 'number') return undefined
  if (!Number.isFinite(exp)) return undefined
  return exp * 1000
}

/**
 * Extract the session facts the document's `tokens` object carries, failing
 * loud when it no longer holds what a session needs. The message names
 * fields and the document path; values stay unquoted.
 * @param raw - the `tokens` object.
 * @param authPath - document path, quoted in diagnostics.
 * @returns the selected session facts.
 */
function toSessionEntry(raw: Record<string, unknown>, authPath: string): CodexSessionEntry {
  const accessToken = raw['access_token']
  const refreshToken = raw['refresh_token']
  if (typeof accessToken !== 'string' || accessToken.length === 0
    || typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new LlmError(
      `llm-codex-session: ${authPath} tokens carry no usable access_token/refresh_token pair;`
      + ' run "codex login" to refresh the session document',
      'MISSING_CREDENTIAL',
    )
  }
  const accountId = raw['account_id']
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new LlmError(
      `llm-codex-session: ${authPath} tokens carry no account_id, which the ChatGPT backend`
      + ' routes the subscription by; run "codex login" again',
      'MISSING_CREDENTIAL',
    )
  }
  const expiresAtMs = expiryFromToken(accessToken)
  if (expiresAtMs === undefined) {
    throw new LlmError(
      `llm-codex-session: ${authPath} access token states no usable exp claim;`
      + ' the document format is not one this adapter reads',
      'MISSING_CREDENTIAL',
    )
  }
  return { accessToken, refreshToken, accountId, expiresAtMs, raw }
}

/**
 * Parse and select the session the auth document serves. The codex document
 * is one flat object: an `OPENAI_API_KEY` that is null under the ChatGPT
 * login, and the `tokens` object `codex login` wrote.
 * @param text - the document text.
 * @param authPath - document path, quoted in diagnostics.
 * @returns the selected session, or `undefined` when the document holds no ChatGPT session at all.
 */
export function selectSessionEntry(text: string, authPath: string): CodexSessionEntry | undefined {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    /* v8 ignore next -- JSON.parse rejections are always Error instances on
       every supported runtime. */
    const name = error instanceof Error ? error.name : 'parse failed'
    throw new LlmError(
      `llm-codex-session: ${authPath} is not valid JSON (${name});`
      + ' run "codex login" to rewrite the session document',
      'MISSING_CREDENTIAL',
    )
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new LlmError(
      `llm-codex-session: ${authPath} must be a JSON object with a tokens member`,
      'MISSING_CREDENTIAL',
    )
  }
  const root = document as Record<string, unknown>
  const apiKey = root['OPENAI_API_KEY']
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    throw new LlmError(
      `llm-codex-session: ${authPath} holds an API-key login, not the ChatGPT session;`
      + ' run "codex login" to switch the subscription session in',
      'MISSING_CREDENTIAL',
    )
  }
  const tokens = root['tokens']
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) return undefined
  return toSessionEntry(tokens as Record<string, unknown>, authPath)
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
export interface CodexSessionOptions {
  /** Absolute path of the Codex CLI auth document. */
  authPath: string
  /** Refresh when the token is at or within this many milliseconds of expiry. */
  refreshLeewayMs: number
  /** Injected fetch (tests). Defaults to global fetch. */
  fetch?: typeof fetch
  /** Injected clock in epoch milliseconds (tests). Defaults to Date.now. */
  now?: () => number
}

/** The credential facts one request needs, resolved together. */
export interface CodexSessionToken {
  /** Bearer credential for the request. */
  accessToken: string
  /** Account id the request's `chatgpt-account-id` header carries. */
  accountId: string
}

/**
 * Resolve the current credential for the Codex subscription session: serve
 * the document's access token while it is valid, otherwise run one
 * `refresh_token` grant and persist the rotation. Concurrent callers share
 * one in-flight refresh instead of racing the issuer with the same (possibly
 * single-use) refresh token.
 */
export class CodexSessionManager {
  private readonly options: CodexSessionOptions
  private inFlight: Promise<CodexSessionToken> | undefined

  constructor(options: CodexSessionOptions) {
    this.options = options
  }

  /**
   * The token and account id for one request, resolved together so the
   * header always names the account the token belongs to. Concurrent callers
   * share the whole resolve — read, freshness check, and grant.
   * @returns the current session credential.
   */
  current(): Promise<CodexSessionToken> {
    this.inFlight ??= this.resolve().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /**
   * The account id the document currently names, without validating or
   * refreshing anything: the route's request header wants a value before
   * the first credential resolve runs, and a document that cannot serve one
   * is the request path's error to report.
   * @returns the account id, or the empty string when the document is absent or unreadable.
   */
  async peekAccountId(): Promise<string> {
    try {
      const text = await this.readDocumentTextOrNull()
      if (text === null) return ''
      return selectSessionEntry(text, this.options.authPath)?.accountId ?? ''
    } catch {
      // A document that cannot be read or parsed names no account; the
      // credential resolve re-reads it with the full diagnostic.
      return ''
    }
  }

  /** One shared resolve: read the document, serve a valid session, else refresh. */
  private async resolve(): Promise<CodexSessionToken> {
    const current = await this.readEntry()
    if (current.expiresAtMs - this.options.refreshLeewayMs > (this.options.now ?? Date.now)()) {
      return { accessToken: current.accessToken, accountId: current.accountId }
    }
    return this.refresh(current)
  }

  /** Read and select the document session, or fail with the not-logged-in posture. */
  private async readEntry(): Promise<CodexSessionEntry> {
    let text: string
    try {
      await this.assertOwnerOnly()
      text = await readFile(this.options.authPath, 'utf8')
    } catch (error) {
      if (isENOENT(error)) {
        throw new LlmError(
          `llm-codex-session: no Codex session at ${this.options.authPath};`
          + ' run "codex login" once, or mount the route disabled where the CLI is not signed in',
          'MISSING_CREDENTIAL',
        )
      }
      throw error
    }
    const entry = selectSessionEntry(text, this.options.authPath)
    if (entry === undefined) {
      throw new LlmError(
        `llm-codex-session: ${this.options.authPath} holds no ChatGPT session tokens;`
        + ' run "codex login" to create them',
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
        `llm-codex-session: ${this.options.authPath} is readable beyond its owner (mode ${mode.toString(8)});`
        + ` run "chmod 600 ${this.options.authPath}" before starting again`,
        'MISSING_CREDENTIAL',
      )
    }
  }

  /** Whether one session still holds a usable token under the refresh leeway. */
  private isValid(entry: CodexSessionEntry, leewayMs = 0): boolean {
    return entry.expiresAtMs - leewayMs > (this.options.now ?? Date.now)()
  }

  /**
   * Run the refresh grant for one expired session. A sibling process (the
   * CLI itself, or another harness) may refresh the same document
   * concurrently, so both failure and success re-read the disk before
   * concluding: a valid session another writer persisted wins over
   * re-authenticating, and a successful rotation is merged into the latest
   * document state before the atomic write.
   * @param expired - the session whose refresh token seeds the grant.
   * @returns the current session credential.
   */
  private async refresh(expired: CodexSessionEntry): Promise<CodexSessionToken> {
    /* v8 ignore next -- production runs without an injected fetch and reaches
       the real issuer; every test injects a stub instead. */
    const fetchImpl = this.options.fetch ?? fetch
    const body = JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: expired.refreshToken,
    })
    let response: Response
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
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
    const rotatedAt = expiryFromToken(accessToken)
    if (rotatedAt === undefined) {
      return await this.adoptOrThrow('token grant stated no expiry (no exp claim on the access token)')
    }
    const refreshToken = grant['refresh_token']
    const idToken = grant['id_token']
    const rotated: CodexSessionEntry = {
      accessToken,
      refreshToken: typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : expired.refreshToken,
      accountId: expired.accountId,
      expiresAtMs: rotatedAt,
      raw: {
        ...expired.raw,
        access_token: accessToken,
        ...(typeof refreshToken === 'string' && refreshToken.length > 0 ? { refresh_token: refreshToken } : {}),
        ...(typeof idToken === 'string' && idToken.length > 0 ? { id_token: idToken } : {}),
      },
    }
    return await this.persistRotation(expired, rotated)
  }

  /**
   * After a failed grant, adopt a session a concurrent writer refreshed into
   * the document; without one, the failure is the answer.
   * @param detail - human-readable grant failure, safe to surface.
   * @returns the sibling's current credential when one appeared.
   */
  private async adoptOrThrow(detail: string): Promise<CodexSessionToken> {
    const text = await this.readDocumentTextOrNull()
    if (text !== null) {
      const sibling = selectSessionEntry(text, this.options.authPath)
      if (sibling !== undefined && this.isValid(sibling)) {
        return { accessToken: sibling.accessToken, accountId: sibling.accountId }
      }
    }
    throw new LlmError(
      `llm-codex-session: refreshing the Codex session at ${this.options.authPath} failed (${detail});`
      + ' run "codex login" to sign in again',
      'AUTH_REFRESH_FAILED',
    )
  }

  /**
   * Merge one rotated session into the document and write it atomically,
   * unless a sibling already persisted a different, still-valid session —
   * its refresh token is the one the issuer expects next, so adopting it
   * beats overwriting it.
   * @param expired - the session the grant started from.
   * @param rotated - the granted session to persist.
   * @returns the credential to serve: the granted one, or a sibling's when
   *   its fresher rotation won the document race.
   */
  private async persistRotation(expired: CodexSessionEntry, rotated: CodexSessionEntry): Promise<CodexSessionToken> {
    const text = await this.readDocumentTextOrNull()
    if (text !== null) {
      const sibling = selectSessionEntry(text, this.options.authPath)
      if (sibling !== undefined && sibling.refreshToken !== expired.refreshToken && this.isValid(sibling)) {
        return { accessToken: sibling.accessToken, accountId: sibling.accountId }
      }
    }
    const lastRefresh = new Date((this.options.now ?? Date.now)()).toISOString()
    const document = text === null
      ? { OPENAI_API_KEY: null, auth_mode: 'chatgpt', last_refresh: lastRefresh, tokens: rotated.raw }
      : {
        ...(JSON.parse(text) as Record<string, unknown>),
        tokens: rotated.raw,
        last_refresh: lastRefresh,
      }
    const staging = join(dirname(this.options.authPath), `.auth.json.shres-${process.pid}-${randomBytes(4).toString('hex')}`)
    await writeFile(staging, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 })
    await chmod(staging, 0o600)
    await rename(staging, this.options.authPath)
    return { accessToken: rotated.accessToken, accountId: rotated.accountId }
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
