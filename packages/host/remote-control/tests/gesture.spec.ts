import { describe, expect, it } from 'vitest'
import { GestureLedger, GESTURE_TTL_MS, MAX_OUTSTANDING_TOKENS } from '../src/gesture.ts'

describe('GestureLedger', () => {
  it('mints a 128-bit hex token valid for the fixed gesture window', () => {
    const ledger = new GestureLedger()
    const minted = ledger.mint('connect', 'lab', 1_000)
    expect(minted.token).toMatch(/^[0-9a-f]{32}$/)
    expect(minted.expiresAt).toBe(1_000 + GESTURE_TTL_MS)
  })

  it('consumes a matching verb and alias exactly once', () => {
    const ledger = new GestureLedger()
    const { token } = ledger.mint('connect', 'lab', 0)
    expect(ledger.consume(token, 'connect', 'lab', 1)).toBe(true)
    expect(ledger.consume(token, 'connect', 'lab', 1)).toBe(false)
  })

  it('refuses a token minted for another verb and spends it anyway', () => {
    const ledger = new GestureLedger()
    const { token } = ledger.mint('connect', 'lab', 0)
    expect(ledger.consume(token, 'remove', 'lab', 1)).toBe(false)
    expect(ledger.consume(token, 'connect', 'lab', 1)).toBe(false)
  })

  it('refuses a token minted for another alias', () => {
    const ledger = new GestureLedger()
    const { token } = ledger.mint('connect', 'lab', 0)
    expect(ledger.consume(token, 'connect', 'prod', 1)).toBe(false)
  })

  it('refuses an expired token', () => {
    const ledger = new GestureLedger()
    const { token } = ledger.mint('connect', 'lab', 0)
    expect(ledger.consume(token, 'connect', 'lab', GESTURE_TTL_MS + 1)).toBe(false)
  })

  it('refuses a token it never minted', () => {
    expect(new GestureLedger().consume('deadbeef', 'add', null, 0)).toBe(false)
  })

  it('caps outstanding tokens by evicting the oldest', () => {
    const ledger = new GestureLedger()
    const first = ledger.mint('connect', 'lab', 0).token
    for (let minted = 1; minted < MAX_OUTSTANDING_TOKENS; minted++) {
      ledger.mint('add', null, minted)
    }
    const overflow = ledger.mint('remove', 'prod', MAX_OUTSTANDING_TOKENS).token
    expect(overflow).not.toBe(first)
    expect(ledger.consume(first, 'connect', 'lab', 0)).toBe(false)
    expect(ledger.consume(overflow, 'remove', 'prod', 0)).toBe(true)
  })

  it('keeps the security-invariant window and cap fixed', () => {
    expect(GESTURE_TTL_MS).toBe(120_000)
    expect(MAX_OUTSTANDING_TOKENS).toBe(32)
  })
})
