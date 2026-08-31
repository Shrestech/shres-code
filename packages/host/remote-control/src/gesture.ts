/**
 * The gesture-token ledger for the remoteAdmin gateway: one-shot,
 * verb(+alias)-scoped nonces proving a local user gesture stood behind one
 * mutation. Tokens live only in the serving process's memory — never
 * persisted, never logged — so a token minted by one daemon is meaningless on
 * another, and a replayed or re-fired request cannot cause a second mutation.
 * @module @shres-code/shres-code-host-remote-control/gesture
 */

import { randomBytes } from 'node:crypto'
import type { AdminGestureVerb } from './types.ts'

/**
 * Token validity window, sized for the trust modal's dwell time. A security
 * invariant of the gate, not a deployment tunnable: it bounds how long a
 * captured token stays spendable.
 */
export const GESTURE_TTL_MS = 120_000
/** Outstanding-token bound; the oldest token is evicted when the cap is hit. */
export const MAX_OUTSTANDING_TOKENS = 32

/** One minted, unspent gesture authorization. */
export interface MintedGesture {
  /** 128-bit hex nonce; the only wire form of the authorization. */
  token: string
  /** Epoch milliseconds after which the token is dead. */
  expiresAt: number
}

/**
 * Mint and consume one-shot gesture tokens. Consumption is delete-first: a
 * presented token is spent whatever the verdict, so a wrong-scope or expired
 * attempt cannot leave a re-usable authorization behind.
 */
export class GestureLedger {
  readonly #outstanding = new Map<string, { verb: AdminGestureVerb; alias: string | null; expiresAt: number }>()

  /**
   * Mint one token bound to the (verb, alias) mutation it authorizes.
   * @param verb - the mutation verb the token authorizes.
   * @param alias - the alias it is scoped to; null only for registry-add.
   * @param now - epoch milliseconds of the minting instant.
   * @returns the token and its deadline.
   */
  mint(verb: AdminGestureVerb, alias: string | null, now: number): MintedGesture {
    if (this.#outstanding.size >= MAX_OUTSTANDING_TOKENS) {
      // The cap is at least one, so the oldest insertion exists.
      // oxlint-disable-next-line typescript/no-non-null-assertion -- size is at the cap here
      this.#outstanding.delete(this.#outstanding.keys().next().value!)
    }
    const token = randomBytes(16).toString('hex')
    const expiresAt = now + GESTURE_TTL_MS
    this.#outstanding.set(token, { verb, alias, expiresAt })
    return { token, expiresAt }
  }

  /**
   * Spend one presented token: present-and-unspent, unexpired, and matching
   * the (verb, alias) scope are all required, and the token is consumed
   * before the verdict either way.
   * @param token - the presented nonce.
   * @param verb - the verb the caller is about to perform.
   * @param alias - the alias that verb targets; null only for registry-add.
   * @param now - epoch milliseconds of the consumption instant.
   * @returns true when the token authorizes this exact mutation.
   */
  consume(token: string, verb: AdminGestureVerb, alias: string | null, now: number): boolean {
    const entry = this.#outstanding.get(token)
    if (entry === undefined) return false
    this.#outstanding.delete(token)
    return entry.expiresAt > now && entry.verb === verb && entry.alias === alias
  }
}
