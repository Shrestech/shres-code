import type { Context } from '@shres-code/cordis'
import { CredentialProvider } from '@shres-code/shres-code-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@shres-code/shres-code-credentials'

/**
 * In-memory credentials provider for this package's tests: one always-writable
 * `memory` source seeded from plugin config.
 *
 * Unlike a compliant provider it reports an empty seeded value verbatim instead
 * of treating it as absent, so the engine's blank-value rejection stays
 * reachable from a test.
 */
export class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>()

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.store.get(ref)
    const configured = value !== undefined && value.length > 0
    return Promise.resolve({
      configured,
      ...configured ? { source: 'memory' } : {},
      writable: true,
    })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      return Promise.reject(new Error('memory credentials: an empty value cannot be stored; use unset'))
    }
    this.store.set(ref, value)
    this.ctx.emit('credentials/updated', ref)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    if (this.store.delete(ref)) {
      this.ctx.emit('credentials/updated', ref)
    }
    return Promise.resolve()
  }
}
