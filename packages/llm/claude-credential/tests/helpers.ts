/**
 * Test fixtures: Claude Code credential documents in the CLI's own
 * "claudeAiOauth" format, a deterministic clock, an in-memory keychain, and an
 * executable "security" stand-in that answers reads from a fixture file and
 * logs every invocation's argv.
 * @module tests/helpers
 */

import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fixed instant clock-driven tests read instead of the wall clock. */
export const TEST_NOW = 1_700_000_000_000

/** The expiry a grant payload states as "expires_at", in epoch milliseconds. */
export const GRANT_EXPIRES_AT = 1_800_000_000_000

/** The CLI's own "mcpOAuth" member verbatim: a rotation must leave it untouched. */
export const MCP_OAUTH: Record<string, unknown> = {
  'mcp-server': { accessToken: 'mcp-access-token', refreshToken: 'mcp-refresh-token' },
}

/** A far-future instant the real clock reaches only beyond the refresh leeway. */
export function farFuture(): number {
  return Date.now() + 10 * 24 * 3600 * 1000
}

/** An instant before the real clock: the access token is at or past expiry. */
export function expired(): number {
  return Date.now() - 60 * 1000
}

/** An instant inside a 300-second leeway of the real clock. */
export function nearlyExpired(): number {
  return Date.now() + 60 * 1000
}

/** An injected clock pinned at TEST_NOW, so grant-expiry assertions stay deterministic. */
export function testClock(): () => number {
  return () => TEST_NOW
}

/**
 * The document's "claudeAiOauth" object. "refreshTokenExpiresAt" states a
 * future instant whatever the access-token expiry is, so only a test that names
 * it exercises the refusal.
 * @param expiresAtMs - the access-token expiry the store states.
 * @param overrides - fields to replace; an "undefined" value drops the member.
 * @returns the "claudeAiOauth" object.
 */
export function oauthRaw(expiresAtMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    expiresAt: expiresAtMs,
    refreshTokenExpiresAt: Math.max(expiresAtMs, Date.now()) + 7 * 24 * 3600 * 1000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    ...overrides,
  }
}

/**
 * The document root verbatim: the subscription login beside the CLI's own
 * "mcpOAuth" member.
 * @param oauth - the "claudeAiOauth" object.
 * @param overrides - extra root members.
 * @returns the document root.
 */
export function documentRaw(oauth: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claudeAiOauth: oauth,
    mcpOAuth: MCP_OAUTH,
    ...overrides,
  }
}

/** A fresh temp directory under the OS temp root. */
export async function tempDir(prefix = 'claude-session-'): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** Write verbatim credential text at the CLI's owner-only mode; returns its path. */
export async function writeRawDocument(text: string, dir?: string): Promise<string> {
  const authPath = join(dir ?? await tempDir(), '.credentials.json')
  await writeFile(authPath, text, { mode: 0o600 })
  return authPath
}

/** Write one credential document at the CLI's owner-only mode; returns its path. */
export async function writeClaudeDocument(
  oauth: Record<string, unknown>,
  root: Record<string, unknown> = {},
  dir?: string,
): Promise<string> {
  return await writeRawDocument(JSON.stringify(documentRaw(oauth, root)), dir)
}

/** An in-memory keychain: service -> item text, recording every read. */
export function fakeKeychain(items: Record<string, string | undefined>): {
  read: (service: string) => Promise<string | undefined>
  reads: string[]
} {
  const reads: string[] = []
  return {
    read: (service: string) => {
      reads.push(service)
      return Promise.resolve(items[service])
    },
    reads,
  }
}

/** The request facts one stubbed token request observed. */
export interface GrantRequest {
  url: string
  jsonBody: string | undefined
  headers: Record<string, string>
}

/** A fetch stub answering one verbatim body; records every request. */
export function rawFetch(body: string, status = 200): { fetch: typeof fetch; requests: GrantRequest[] } {
  const requests: GrantRequest[] = []
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
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fetchImpl, requests }
}

/** A fetch stub answering one JSON body; records every request. */
export function grantFetch(payload: object, status = 200): { fetch: typeof fetch; requests: GrantRequest[] } {
  return rawFetch(JSON.stringify(payload), status)
}

/** A fetch stub that rejects, as an unreachable token endpoint does. */
export function unreachableFetch(reason: string): { fetch: typeof fetch; requests: GrantRequest[] } {
  const requests: GrantRequest[] = []
  const fetchImpl: typeof fetch = async (url) => {
    requests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      jsonBody: undefined,
      headers: {},
    })
    throw new Error(reason)
  }
  return { fetch: fetchImpl, requests }
}

/** A grant payload the token endpoint returns, stating its expiry in epoch milliseconds. */
export function grantPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'rotated-access-token',
    refresh_token: 'rotated-refresh-token',
    expires_at: GRANT_EXPIRES_AT,
    ...overrides,
  }
}

/** One temp-dir "security" stand-in: its executable path and its argv reader. */
export interface SecurityStandIn {
  /** Executable stand-in to hand the manager as "securityPath". */
  path: string
  /**
   * The most recent invocation's argv. The stand-in logs one argument per line,
   * so an argument holding newlines (the written document JSON) spans lines and
   * the caller rejoins them.
   */
  argv: () => Promise<string[]>
}

/**
 * Build an executable POSIX "security" stand-in: it logs each invocation's
 * argv, prints the fixture for a "find-generic-password" read, and runs
 * `writeBranch` for every other subcommand.
 * @param item - item text the stand-in serves for a read.
 * @param writeBranch - shell lines the write subcommand runs.
 * @returns the stand-in's executable path and its argv reader.
 */
async function securityScript(item: string, writeBranch: string): Promise<SecurityStandIn> {
  const dir = await tempDir('claude-security-')
  const fixturePath = join(dir, 'item.json')
  const logPath = join(dir, 'argv.log')
  const path = join(dir, 'security')
  await writeFile(fixturePath, item, 'utf8')
  const script = [
    '#!/bin/sh',
    ': > "' + logPath + '"',
    "printf '%s\\n' \"$@\" >> \"" + logPath + '"',
    'if [ "$1" = "find-generic-password" ]; then',
    '  cat "' + fixturePath + '"',
    '  exit 0',
    'fi',
    writeBranch,
    '',
  ].join('\n')
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  return { path, argv: async () => await readArgv(logPath) }
}

/**
 * Build a "security" stand-in that serves reads from the fixture and accepts
 * every write.
 * @param item - item text the stand-in serves for a read.
 * @returns the stand-in's executable path and its argv reader.
 */
export async function securityStandIn(item: string): Promise<SecurityStandIn> {
  return await securityScript(item, 'exit 0')
}

/**
 * Build a "security" stand-in that serves reads and refuses every write,
 * printing a diagnostic that repeats its own argv — the form Node's exec
 * rejection takes.
 * @param item - item text the stand-in serves for a read.
 * @returns the stand-in's executable path and its argv reader.
 */
export async function refusingWriteSecurityStandIn(item: string): Promise<SecurityStandIn> {
  return await securityScript(item, "printf '%s\\n' \"security: authorization refused for $*\" >&2\nexit 51")
}

/**
 * Build a "security" stand-in that serves reads and refuses every write
 * without printing anything.
 * @param item - item text the stand-in serves for a read.
 * @returns the stand-in's executable path and its argv reader.
 */
export async function silentRefusingWriteSecurityStandIn(item: string): Promise<SecurityStandIn> {
  return await securityScript(item, 'exit 51')
}

/** A "security" stand-in that fails every invocation, as an unreadable item does. */
export async function failingSecurityStandIn(): Promise<{ path: string }> {
  const path = join(await tempDir('claude-security-'), 'security')
  await writeFile(path, '#!/bin/sh\nexit 1\n', 'utf8')
  await chmod(path, 0o755)
  return { path }
}

/** Read one stand-in's argv log, one argument per line. */
async function readArgv(logPath: string): Promise<string[]> {
  const logged = await readFile(logPath, 'utf8')
  const lines = logged.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
