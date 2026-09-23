/**
 * Claude Code session credential: read the subscription login the Claude Code
 * CLI stores — the macOS login keychain's `Claude Code-credentials` item by
 * default, `~/.claude/.credentials.json` elsewhere — serve the OAuth access
 * token while `expiresAt` holds, refresh it through
 * console.anthropic.com's `refresh_token` grant at the configured leeway, and
 * persist the rotated values back in the CLI's own document format. Values
 * never reach diagnostics: a refresh failure names the issuer's error code,
 * and nothing about the credential is ever quoted.
 * @module @shres-code/shres-code-claude-credential/session
 */

import { execFile } from 'node:child_process'
import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { LlmError } from '@shres-code/shres-code-llm'

const execFileAsync = promisify(execFile)

/** OAuth token endpoint the Claude Code CLI's subscription login refreshes against. */
export const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'

/**
 * OAuth client id the Claude Code CLI binds its subscription login to; the
 * refresh grant echoes it. Source: the CLI's own login client.
 */
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/** Login keychain service the CLI stores the credential document under. */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** Default path of the macOS security tool that reads the login keychain. */
export const DEFAULT_SECURITY_PATH = '/usr/bin/security'

/** Permission bits outside the owner; a session document must have none of them. */
const GROUP_OTHER_BITS = 0o077

/**
 * Default auth document: the Claude Code CLI's own credential store, used
 * wherever the login keychain is not.
 * @returns the absolute path of `~/.claude/.credentials.json` for the current user.
 */
export function defaultAuthPath(): string {
  return join(homedir(), '.claude', '.credentials.json')
}

/** One selected session: the facts refresh and dispatch need. */
export interface ClaudeSessionEntry {
  /** OAuth access token sent as the request's bearer credential. */
  accessToken: string
  /** OAuth refresh token for the `refresh_token` grant. */
  refreshToken: string
  /**
   * Access-token expiry in epoch milliseconds. Zero states that the store
   * holds no access token at all, which is at-or-past expiry by construction.
   */
  expiresAtMs: number
  /** Refresh-token expiry in epoch milliseconds, when the store states a usable one. */
  refreshTokenExpiresAtMs: number | undefined
  /** The document's `claudeAiOauth` object verbatim; rotation rewrites this object. */
  raw: Record<string, unknown>
  /** Where the entry was read from, quoted in diagnostics. */
  source: string
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Describe one failed `security` invocation without quoting what it was handed.
 * Node's exec rejection echoes the whole command line — service, account, and
 * the rotated document itself — so this frame reports the exit status and a
 * summary of the tool's own stderr, with the values it knows replaced wherever
 * that summary repeats them. A tool that never started reports no exit status,
 * and one that printed nothing reports the status alone.
 * @param error - the rejection the `security` invocation produced.
 * @param values - values the summary must not carry.
 * @returns the exit status with the tool's redacted summary, safe for diagnostics.
 */
function describeSecurityFailure(error: unknown, values: readonly string[]): string {
  const failure = error as { code?: unknown; stderr?: unknown }
  const status = typeof failure.code === 'number' ? `exit ${String(failure.code)}` : 'no exit status'
  let stderr = ''
  /* v8 ignore else -- execFile's rejection carries a string stderr on every path
     it produces: an exit-code failure prints the tool's diagnostic, and a spawn
     failure (a tool that never started) an empty string. */
  if (typeof failure.stderr === 'string') {
    stderr = failure.stderr.trim()
  }
  if (stderr.length === 0) return status
  let summary = stderr
  for (const value of values) {
    if (value.length > 0) summary = summary.replaceAll(value, '<credential>')
  }
  return `${status}: ${summary}`
}

/** Whether one document field states a finite number. */
function statedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The refresh-token expiry the store states, when it is a positive instant.
 * @param value - the document field.
 * @returns the epoch-millisecond instant, or `undefined` when the store states none.
 */
function refreshExpiry(value: unknown): number | undefined {
  const stated = statedNumber(value)
  return stated !== undefined && stated > 0 ? stated : undefined
}

/**
 * The sign-in step every not-logged-in diagnostic names: the CLI writes this
 * document only from its own interactive login.
 */
const SIGN_IN_STEP = 'run "claude" and sign in with /login'

/**
 * Extract the session facts the document's `claudeAiOauth` object carries,
 * failing loud when it no longer holds what a session needs. The message names
 * the source and the fields; values stay unquoted.
 * @param raw - the `claudeAiOauth` object.
 * @param source - source description, quoted in diagnostics.
 * @returns the selected session facts.
 */
function toSessionEntry(raw: Record<string, unknown>, source: string): ClaudeSessionEntry {
  const refreshToken = raw['refreshToken']
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new LlmError(
      `llm-claude-session: ${source} claudeAiOauth carries no refreshToken, so it can neither serve`
      + ` a request nor refresh one; ${SIGN_IN_STEP} to rewrite the credential`,
      'MISSING_CREDENTIAL',
    )
  }
  const accessToken = raw['accessToken']
  const expiresAtMs = statedNumber(raw['expiresAt'])
  if (expiresAtMs === undefined) {
    throw new LlmError(
      `llm-claude-session: ${source} claudeAiOauth states no usable expiresAt;`
      + ' the credential format is not one this adapter reads',
      'MISSING_CREDENTIAL',
    )
  }
  // Zero states that the store holds no access token — a login whose token the
  // CLI has not written yet — and is refreshed rather than refused. Any other
  // expiry beside an absent token is a document this engine cannot serve.
  if (expiresAtMs !== 0 && (typeof accessToken !== 'string' || accessToken.length === 0)) {
    throw new LlmError(
      `llm-claude-session: ${source} claudeAiOauth carries no accessToken beside a non-zero expiresAt;`
      + ` ${SIGN_IN_STEP} to rewrite the credential`,
      'MISSING_CREDENTIAL',
    )
  }
  return {
    accessToken: typeof accessToken === 'string' ? accessToken : '',
    refreshToken,
    expiresAtMs,
    // Only a positive instant is a stated expiry; zero or a negative value is
    // the CLI's way of stating none, which leaves the grant to the issuer.
    refreshTokenExpiresAtMs: refreshExpiry(raw['refreshTokenExpiresAt']),
    raw,
    source,
  }
}

/**
 * Parse and select the session the credential document serves. The Claude Code
 * document is one object whose `claudeAiOauth` member holds the subscription
 * login beside the CLI's own `mcpOAuth` member, which this engine leaves
 * untouched.
 * @param text - the document text.
 * @param source - source description, quoted in diagnostics.
 * @returns the selected session facts.
 * @throws LlmError `MISSING_CREDENTIAL` when the document is unparseable, is not an object, or carries no usable `claudeAiOauth` session.
 */
export function selectSessionEntry(text: string, source: string): ClaudeSessionEntry {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    /* v8 ignore next -- JSON.parse rejections are always Error instances on
       every supported runtime. */
    const name = error instanceof Error ? error.name : 'parse failed'
    throw new LlmError(
      `llm-claude-session: ${source} is not valid JSON (${name}); ${SIGN_IN_STEP} to rewrite it`,
      'MISSING_CREDENTIAL',
    )
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new LlmError(
      `llm-claude-session: ${source} must be a JSON object with a claudeAiOauth member`,
      'MISSING_CREDENTIAL',
    )
  }
  const raw = (document as Record<string, unknown>)['claudeAiOauth']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LlmError(
      `llm-claude-session: ${source} holds no claudeAiOauth member; ${SIGN_IN_STEP} to create it`,
      'MISSING_CREDENTIAL',
    )
  }
  return toSessionEntry(raw as Record<string, unknown>, source)
}

/**
 * One JSON error body the token endpoint returns; only its code and
 * description are quoted, never a token.
 */
interface TokenErrorBody {
  error?: unknown
  error_description?: unknown
}

/** Transport and source hooks the manager runs through; tests substitute them. */
export interface ClaudeSessionOptions {
  /** Whether the login keychain holds the document; the file store answers otherwise. */
  useKeychain: boolean
  /** macOS security tool path used for both keychain reads and the rotation write. */
  securityPath: string
  /** Credential document path, read only when `useKeychain` is false. */
  authPath: string
  /** Keychain account a rotation write stores its item under. */
  keychainAccount: string
  /** Refresh when the token is at or within this many milliseconds of expiry. */
  refreshLeewayMs: number
  /** Injected fetch (tests). Defaults to global fetch. */
  fetch?: typeof fetch
  /** Injected clock in epoch milliseconds (tests). Defaults to Date.now. */
  now?: () => number
  /** Injected keychain reader (tests). Defaults to the security tool. */
  readKeychain?: (service: string) => Promise<string | undefined>
  /** Injected keychain writer (tests). Defaults to the security tool. */
  writeKeychain?: (service: string, account: string, json: string) => Promise<void>
}

/** The credential facts one request needs, resolved together. */
export interface ClaudeSessionToken {
  /** Bearer credential for the request. */
  accessToken: string
}

/**
 * Resolve the current credential for the Claude subscription session: serve
 * the stored access token while it is valid, otherwise run one
 * `refresh_token` grant and persist the rotation. Concurrent callers share one
 * in-flight resolve instead of racing the issuer with the same (possibly
 * single-use) refresh token.
 */
export class ClaudeSessionManager {
  private readonly options: ClaudeSessionOptions
  private inFlight: Promise<ClaudeSessionToken> | undefined

  constructor(options: ClaudeSessionOptions) {
    this.options = options
  }

  /**
   * The bearer credential for one request. Concurrent callers share the whole
   * resolve — read, freshness check, and grant.
   * @returns the current session credential.
   */
  current(): Promise<ClaudeSessionToken> {
    this.inFlight ??= this.resolve().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /** One shared resolve: read the store, serve a valid session, else refresh. */
  private async resolve(): Promise<ClaudeSessionToken> {
    const current = await this.readEntry()
    if (current.expiresAtMs - this.options.refreshLeewayMs > this.now()) {
      return { accessToken: current.accessToken }
    }
    return await this.refresh(current)
  }

  /** The clock every freshness decision reads. */
  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** How diagnostics name the configured source. */
  private sourceLabel(): string {
    return this.options.useKeychain ? `the login keychain item "${KEYCHAIN_SERVICE}"` : this.options.authPath
  }

  /** Read and select the document session, or fail with the not-logged-in posture. */
  private async readEntry(): Promise<ClaudeSessionEntry> {
    if (!this.options.useKeychain) {
      try {
        // The CLI stores the document at owner-only mode; serving a token out
        // of a file other OS users can read would defeat that promise. The
        // stat runs first, so its own ENOENT is the absent document's.
        await this.assertOwnerOnly()
      } catch (error) {
        if (isENOENT(error)) throw this.noSession()
        throw error
      }
    }
    const text = await this.readDocumentTextOrNull()
    if (text === null) throw this.noSession()
    return selectSessionEntry(text, this.sourceLabel())
  }

  /** The not-logged-in failure every absent source reports. */
  private noSession(): LlmError {
    return new LlmError(
      `llm-claude-session: no Claude Code session in ${this.sourceLabel()};`
      + ` ${SIGN_IN_STEP} once, or mount the route disabled where the CLI is not signed in`,
      'MISSING_CREDENTIAL',
    )
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
        `llm-claude-session: ${this.options.authPath} is readable beyond its owner (mode ${mode.toString(8)});`
        + ` run "chmod 600 ${this.options.authPath}" before starting again`,
        'MISSING_CREDENTIAL',
      )
    }
  }

  /** The document text, or `null` when the configured source holds none. */
  private async readDocumentTextOrNull(): Promise<string | null> {
    if (this.options.useKeychain) {
      const read = this.options.readKeychain ?? this.readViaSecurity.bind(this)
      const text = await read(KEYCHAIN_SERVICE)
      return text === undefined || text.length === 0 ? null : text
    }
    try {
      return await readFile(this.options.authPath, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return null
      throw error
    }
  }

  /**
   * One keychain read through the security tool. Every tool failure reads as an
   * absent credential — an absent binary, a locked keychain, and an item the
   * login never created are one posture to the caller, which reports the
   * sign-in step — so this frame swallows the tool's own diagnostic rather than
   * distinguishing causes the manager cannot act on.
   */
  private async readViaSecurity(service: string): Promise<string | undefined> {
    let stdout: string
    try {
      const result = await execFileAsync(this.options.securityPath, [
        'find-generic-password', '-w',
        '-s', service,
      ])
      stdout = result.stdout
    } catch {
      // Swallowed on purpose: the tool's failure is the absent-credential
      // posture, which the caller reports; nothing else reaches this frame.
      return undefined
    }
    const value = stdout.trim()
    return value.length > 0 ? value : undefined
  }

  /**
   * One keychain write through the security tool, replacing any existing item.
   * A refusal is reported by {@link describeSecurityFailure} alone: this frame
   * is handed the rotated document, and the exec rejection quotes the whole
   * command line it was given.
   */
  private async writeViaSecurity(service: string, account: string, json: string): Promise<void> {
    try {
      await execFileAsync(this.options.securityPath, [
        'add-generic-password', '-U',
        '-s', service,
        '-a', account,
        '-w', json,
      ])
    } catch (error) {
      throw new LlmError(
        `llm-claude-session: the login keychain refused the rotated credential (${describeSecurityFailure(error, [json, account])});`
        + ` the store still holds the previous values, so ${SIGN_IN_STEP} again`,
        'AUTH_REFRESH_FAILED',
      )
    }
  }

  /** Whether one session still holds a usable token under the refresh leeway. */
  private isValid(entry: ClaudeSessionEntry, leewayMs = 0): boolean {
    return entry.expiresAtMs - leewayMs > this.now()
  }

  /**
   * Run the refresh grant for one expired session. A sibling process (the CLI
   * itself, or another harness) may refresh the same store concurrently, so
   * both failure and success re-read it before concluding: a valid session
   * another writer persisted wins over re-authenticating, and a successful
   * rotation is merged into the latest document state before the write.
   * @param expired - the session whose refresh token seeds the grant.
   * @returns the current session credential.
   */
  private async refresh(expired: ClaudeSessionEntry): Promise<ClaudeSessionToken> {
    // A refresh token past its own expiry cannot be granted, and the CLI may
    // have signed in again since this session was read, so the refusal runs
    // the same adoption step a failed grant does before it fails.
    if (expired.refreshTokenExpiresAtMs !== undefined && this.now() >= expired.refreshTokenExpiresAtMs) {
      return await this.adoptOrThrow('the stored refresh token has expired')
    }
    /* v8 ignore next -- production runs without an injected fetch and reaches
       the real issuer; every test injects a stub instead. */
    const fetchImpl = this.options.fetch ?? fetch
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: expired.refreshToken,
      client_id: CLIENT_ID,
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
    // The grant rotates both tokens; a refresh token it withheld would leave
    // the store holding the one the issuer has already consumed.
    const refreshToken = grant['refresh_token']
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      return await this.adoptOrThrow('token grant carried no rotated refresh_token')
    }
    const rotatedAt = this.grantedExpiry(grant)
    if (rotatedAt === undefined) {
      return await this.adoptOrThrow('token grant stated no expiry (neither expires_at nor expires_in)')
    }
    return await this.persistRotation(expired, {
      accessToken,
      refreshToken,
      expiresAtMs: rotatedAt,
      refreshTokenExpiresAtMs: expired.refreshTokenExpiresAtMs,
      // The store's own field names, so the CLI reads the rotation back.
      raw: { ...expired.raw, accessToken, refreshToken, expiresAt: rotatedAt },
      source: expired.source,
    })
  }

  /**
   * The access-token expiry one grant states: `expires_at`, the store's own
   * epoch-millisecond field, then `expires_in` seconds counted from now.
   * @param grant - the parsed grant body.
   * @returns the expiry in epoch milliseconds, or `undefined` when the grant states none.
   */
  private grantedExpiry(grant: Record<string, unknown>): number | undefined {
    const statedAt = statedNumber(grant['expires_at'])
    if (statedAt !== undefined && statedAt > 0) return statedAt
    const expiresIn = statedNumber(grant['expires_in'])
    if (expiresIn !== undefined && expiresIn > 0) return this.now() + expiresIn * 1000
    return undefined
  }

  /**
   * After a failed grant, adopt a session a concurrent writer refreshed into
   * the store; without one, the failure is the answer.
   * @param detail - human-readable grant failure, safe to surface.
   * @returns the sibling's current credential when one appeared.
   */
  private async adoptOrThrow(detail: string): Promise<ClaudeSessionToken> {
    const text = await this.readDocumentTextOrNull()
    if (text !== null) {
      const sibling = selectSessionEntry(text, this.sourceLabel())
      if (this.isValid(sibling)) return { accessToken: sibling.accessToken }
    }
    throw new LlmError(
      `llm-claude-session: refreshing the Claude Code session in ${this.sourceLabel()} failed (${detail});`
      + ` ${SIGN_IN_STEP} to sign in again`,
      'AUTH_REFRESH_FAILED',
    )
  }

  /**
   * Merge one rotated session into the latest document state and write it,
   * unless a sibling already persisted a different, still-valid session — its
   * refresh token is the one the issuer expects next, so adopting it beats
   * overwriting it.
   * @param expired - the session the grant started from.
   * @param rotated - the granted session to persist.
   * @returns the credential to serve: the granted one, or a sibling's when
   *   its fresher rotation won the store race.
   */
  private async persistRotation(expired: ClaudeSessionEntry, rotated: ClaudeSessionEntry): Promise<ClaudeSessionToken> {
    const text = await this.readDocumentTextOrNull()
    let latest: Record<string, unknown> | undefined
    if (text !== null) {
      const sibling = selectSessionEntry(text, this.sourceLabel())
      if (sibling.refreshToken !== expired.refreshToken && this.isValid(sibling)) {
        return { accessToken: sibling.accessToken }
      }
      latest = JSON.parse(text) as Record<string, unknown>
    }
    // The CLI's own members survive the rotation: `mcpOAuth` and unknown
    // siblings at the root, and any `claudeAiOauth` field the grant does not
    // restate.
    const document = latest === undefined
      ? { claudeAiOauth: rotated.raw }
      : {
        ...latest,
        claudeAiOauth: { ...(latest['claudeAiOauth'] as Record<string, unknown>), ...rotated.raw },
      }
    const json = JSON.stringify(document, null, 2)
    if (this.options.useKeychain) {
      const write = this.options.writeKeychain ?? this.writeViaSecurity.bind(this)
      await write(KEYCHAIN_SERVICE, this.options.keychainAccount, json)
    } else {
      const staging = join(
        dirname(this.options.authPath),
        `.credentials.json.shres-${process.pid}-${randomBytes(4).toString('hex')}`,
      )
      await writeFile(staging, `${json}\n`, { mode: 0o600 })
      await chmod(staging, 0o600)
      await rename(staging, this.options.authPath)
    }
    return { accessToken: rotated.accessToken }
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
