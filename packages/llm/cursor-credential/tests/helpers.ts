/**
 * Test fixtures: Cursor session credentials whose JWTs encode their own
 * expiry, plus an in-memory keychain stand-in.
 * @module tests/helpers
 */

/** Encode one JWT-shaped token whose `exp` claim carries the given instant. */
export function tokenWithExp(expiresAtMs: number): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return [encode({ alg: 'RS256', typ: 'JWT' }), encode({ exp: Math.floor(expiresAtMs / 1000) }), 'signature'].join('.')
}

/** A far-future instant a served token comfortably outlives. */
export function farFuture(): number {
  return Date.now() + 10 * 24 * 3600 * 1000
}

/** An instant in the past: the token has expired. */
export function expired(): number {
  return Date.now() - 60 * 1000
}

/** An in-memory keychain: service -> secret, recorded per read. */
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
