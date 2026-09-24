/**
 * The one Claude subscription-credential engine, as a Cordis service: reads
 * the login the Claude Code CLI stored (the macOS login keychain's
 * `Claude Code-credentials` item by default, `~/.claude/.credentials.json`
 * elsewhere), serves the OAuth access token while `expiresAt` holds, refreshes
 * it through console.anthropic.com's `refresh_token` grant at the configured
 * leeway, and persists rotated values back for the CLI. Consumers — the
 * `claude-session` HTTP adapter today — resolve one memoized
 * {@link ClaudeSessionManager} per credential spec through
 * `ctx.claudeCredential`, so a shared store is refreshed single-flight
 * regardless of which capability asked first.
 *
 * @module @shres-code/shres-code-claude-credential
 */

import { Service, type Context } from '@shres-code/cordis'
import { ClaudeSessionManager } from './session.ts'
import type { ClaudeSessionOptions } from './session.ts'

export {
  CLIENT_ID,
  ClaudeSessionManager,
  DEFAULT_SECURITY_PATH,
  KEYCHAIN_SERVICE,
  TOKEN_URL,
  defaultAuthPath,
  selectSessionEntry,
} from './session.ts'
export type { ClaudeSessionEntry, ClaudeSessionOptions, ClaudeSessionToken } from './session.ts'

declare module '@shres-code/cordis' {
  interface Context {
    /** Shared single-flight Claude subscription-credential engine. */
    claudeCredential: ClaudeCredential
  }
}

/**
 * The memoization key for one credential spec. A resolve is tied to the source
 * facts and the leeway alone, so two specs sharing those facts share one
 * in-flight resolve.
 * @param spec - the credential spec.
 * @returns the key under which one manager is reused.
 */
function specKey(spec: ClaudeSessionOptions): string {
  return [
    spec.useKeychain ? 'keychain' : 'file',
    spec.securityPath,
    spec.authPath,
    spec.keychainAccount,
    String(spec.refreshLeewayMs),
  ].join('\u0000')
}

/**
 * Single-flight Claude session-credential service.
 *
 * {@link ClaudeCredential.managerFor} returns the one {@link ClaudeSessionManager}
 * memoized for a credential spec, preserving one shared in-flight resolve per
 * source. The memoization caches every spec key for the service's lifetime;
 * that is safe because each `current()` call re-reads the store and re-checks
 * freshness at the moment it runs rather than trusting a cached token.
 */
export class ClaudeCredential extends Service {
  private readonly managers = new Map<string, ClaudeSessionManager>()

  constructor(ctx: Context) {
    super(ctx, 'claudeCredential')
  }

  /**
   * Resolve the credential manager for one spec, sharing the cached instance
   * across callers so concurrent requests refresh the store once.
   * @param spec - the credential spec this manager reads and refreshes.
   * @returns the manager for the spec's credential facts.
   */
  managerFor(spec: ClaudeSessionOptions): ClaudeSessionManager {
    const key = specKey(spec)
    let manager = this.managers.get(key)
    if (manager === undefined) {
      manager = new ClaudeSessionManager(spec)
      this.managers.set(key, manager)
    }
    return manager
  }
}

export default ClaudeCredential
