/**
 * The one Grok Build subscription-credential engine, as a Cordis service:
 * reads the CLI's OIDC session document (`~/.grok/auth.json`), serves the
 * access token while it is valid, refreshes through the issuer's
 * `refresh_token` grant at the configured leeway, and persists rotated values
 * back for the CLI. Consumers with different credential sources — the
 * `grok-session` HTTP adapter today, an image-generation tool tomorrow —
 * resolve one memoized {@link GrokSessionManager} per credential spec through
 * `ctx.grokCredential`, so a shared document is refreshed single-flight
 * regardless of which capability asked first.
 *
 * @module @shres-code/shres-code-grok-credential
 */

import { Service, type Context } from '@shres-code/cordis'
import { GrokSessionManager } from './session.ts'
import type { GrokSessionOptions } from './session.ts'

export { GrokSessionManager, OIDC_ISSUER, ENTRY_KEY_PREFIX, selectSessionEntry } from './session.ts'
export type { GrokSessionEntry, GrokSessionOptions } from './session.ts'

declare module '@shres-code/cordis' {
  interface Context {
    /** Shared single-flight Grok Build subscription-credential engine. */
    grokCredential: GrokCredential
  }
}

/**
 * The memoization key for one credential spec. Refreshing is tied to the
 * document and its leeway alone, so two specs sharing those facts share one
 * in-flight resolve.
 * @param spec - the credential spec.
 * @returns the key under which one manager is reused.
 */
function specKey(spec: GrokSessionOptions): string {
  return `${spec.authPath}\u0000${String(spec.refreshLeewayMs)}`
}

/**
 * Single-flight Grok Build session-credential service.
 *
 * {@link GrokCredential.managerFor} returns the one {@link GrokSessionManager}
 * memoized for a credential spec, preserving one shared in-flight refresh per
 * document. The memoization caches every spec key for the service's lifetime
 * (develop's single-slot resolver evicted on change); that is safe because
 * each `accessToken()` call re-validates the document and refresh at the
 * moment it runs rather than trusting a stale cached token state.
 */
export class GrokCredential extends Service {
  private readonly managers = new Map<string, GrokSessionManager>()

  constructor(ctx: Context) {
    super(ctx, 'grokCredential')
  }

  /**
   * Resolve the credential manager for one spec, sharing the cached instance
   * across callers so concurrent requests refresh the document once.
   * @param spec - the credential spec this manager reads and refreshes.
   * @returns the manager for the spec's credential facts.
   */
  managerFor(spec: GrokSessionOptions): GrokSessionManager {
    const key = specKey(spec)
    let manager = this.managers.get(key)
    if (manager === undefined) {
      manager = new GrokSessionManager(spec)
      this.managers.set(key, manager)
    }
    return manager
  }
}

export default GrokCredential
