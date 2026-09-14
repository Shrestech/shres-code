/**
 * The one Cursor subscription-credential engine, as a Cordis service: reads
 * the Cursor Agent CLI's login credential (macOS login keychain by default,
 * its file store otherwise), serves the access token while its JWT is valid,
 * and adopts the CLI's rotations on the next resolve — the issuer is not
 * publicly resolvable, so the CLI owns refresh and this engine never runs a
 * grant itself. Consumers — a future `cursor-session` HTTP adapter — resolve
 * one memoized {@link CursorSessionManager} per credential spec through
 * `ctx.cursorCredential`, so a shared store is read single-flight regardless
 * of which capability asked first.
 *
 * @module @shres-code/shres-code-cursor-credential
 */

import { Service, type Context } from '@shres-code/cordis'
import { CursorSessionManager } from './session.ts'
import type { CursorSessionOptions } from './session.ts'

export {
  CursorSessionManager,
  DEFAULT_AUTH_PATH,
  DEFAULT_SECURITY_PATH,
  KEYCHAIN_ACCESS_SERVICE,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_REFRESH_SERVICE,
  expiryFromToken,
  toSessionEntry,
} from './session.ts'
export type { CursorSessionEntry, CursorSessionOptions, CursorSessionToken } from './session.ts'

declare module '@shres-code/cordis' {
  interface Context {
    /** Shared single-flight Cursor subscription-credential engine. */
    cursorCredential: CursorCredential
  }
}

/**
 * The memoization key for one credential spec. A resolve is tied to the
 * source facts alone, so two specs sharing those facts share one in-flight
 * read.
 * @param spec - the credential spec.
 * @returns the key under which one manager is reused.
 */
function specKey(spec: CursorSessionOptions): string {
  return `${spec.useKeychain ? 'keychain' : 'file'}\u0000${spec.securityPath}\u0000${spec.authPath}`
}

/**
 * Single-flight Cursor session-credential service.
 *
 * {@link CursorCredential.managerFor} returns the one {@link CursorSessionManager}
 * memoized for a credential spec, preserving one shared in-flight read per
 * source. The memoization caches every spec key for the service's lifetime;
 * that is safe because each `current()` call re-reads the store at the
 * moment it runs rather than trusting a cached token.
 */
export class CursorCredential extends Service {
  private readonly managers = new Map<string, CursorSessionManager>()

  constructor(ctx: Context) {
    super(ctx, 'cursorCredential')
  }

  /**
   * Resolve the credential manager for one spec, sharing the cached instance
   * across callers so concurrent requests read the store once.
   * @param spec - the credential spec this manager reads.
   * @returns the manager for the spec's credential facts.
   */
  managerFor(spec: CursorSessionOptions): CursorSessionManager {
    const key = specKey(spec)
    let manager = this.managers.get(key)
    if (manager === undefined) {
      manager = new CursorSessionManager(spec)
      this.managers.set(key, manager)
    }
    return manager
  }
}

export default CursorCredential
