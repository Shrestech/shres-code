/**
 * The one Codex subscription-credential engine, as a Cordis service: reads
 * the CLI's ChatGPT-login session document (`~/.codex/auth.json`), serves the
 * access token while it is valid, refreshes through the issuer's
 * `refresh_token` grant at the configured leeway, and persists rotated values
 * back for the CLI. Consumers with different credential sources — the
 * `codex-session` HTTP adapter today — resolve one memoized
 * {@link CodexSessionManager} per credential spec through
 * `ctx.codexCredential`, so a shared document is refreshed single-flight
 * regardless of which capability asked first.
 *
 * @module @shres-code/shres-code-codex-credential
 */

import { Service, type Context } from '@shres-code/cordis'
import { CodexSessionManager } from './session.ts'
import type { CodexSessionOptions } from './session.ts'

export {
  CLIENT_ID,
  CodexSessionManager,
  OIDC_ISSUER,
  TOKEN_URL,
  selectSessionEntry,
} from './session.ts'
export type { CodexSessionEntry, CodexSessionOptions, CodexSessionToken } from './session.ts'

declare module '@shres-code/cordis' {
  interface Context {
    /** Shared single-flight Codex subscription-credential engine. */
    codexCredential: CodexCredential
  }
}

/**
 * The memoization key for one credential spec. Refreshing is tied to the
 * document and its leeway alone, so two specs sharing those facts share one
 * in-flight resolve.
 * @param spec - the credential spec.
 * @returns the key under which one manager is reused.
 */
function specKey(spec: CodexSessionOptions): string {
  return `${spec.authPath}\u0000${String(spec.refreshLeewayMs)}`
}

/**
 * Single-flight Codex session-credential service.
 *
 * {@link CodexCredential.managerFor} returns the one {@link CodexSessionManager}
 * memoized for a credential spec, preserving one shared in-flight refresh per
 * document. The memoization caches every spec key for the service's lifetime
 * (develop's single-slot resolver evicted on change); that is safe because
 * each `current()` call re-validates the document and refresh at the moment
 * it runs rather than trusting a stale cached token state.
 */
export class CodexCredential extends Service {
  private readonly managers = new Map<string, CodexSessionManager>()

  constructor(ctx: Context) {
    super(ctx, 'codexCredential')
  }

  /**
   * Resolve the credential manager for one spec, sharing the cached instance
   * across callers so concurrent requests refresh the document once.
   * @param spec - the credential spec this manager reads and refreshes.
   * @returns the manager for the spec's credential facts.
   */
  managerFor(spec: CodexSessionOptions): CodexSessionManager {
    const key = specKey(spec)
    let manager = this.managers.get(key)
    if (manager === undefined) {
      manager = new CodexSessionManager(spec)
      this.managers.set(key, manager)
    }
    return manager
  }
}

export default CodexCredential
