import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@shres-code/shres-code-session'
import {
  decodeJspaceCard,
  decodeJspaceClosed,
  foldJspace,
  formatJspaceCard,
  formatJspaceCheckedElision,
  formatJspaceOpenElision,
  matchesCoverageTerms,
  DEFAULT_CHECKED_REPRINT_LIMIT,
  DEFAULT_OPEN_REPRINT_LIMIT,
  JSPACE_ALWAYS_OPEN_GOAL,
  JSPACE_ALWAYS_OPEN_NEXT,
  JSPACE_AVAILABLE_LINE,
} from '../src/fold.ts'
import type { JspaceCard } from '../src/types.ts'

const owner = 'sess-a'

function card(overrides: Partial<JspaceCard> = {}): JspaceCard {
  return {
    seq: 1,
    sessionId: owner,
    goal: 'Ship the feature',
    core: ['seat'],
    checked: [],
    open: [],
    next: 'Write the fold',
    goalOpenedSeq: 1,
    ...overrides,
  }
}

function event(type: 'jspace/card' | 'jspace/closed', data: unknown, seq = 0): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

describe('foldJspace', () => {
  it('returns an empty projection for a log with no jspace events', () => {
    expect(foldJspace([], owner)).toEqual({
      card: null,
      closed: false,
      inherited: null,
    })
  })

  it('takes the highest native seq as the live card', () => {
    const first = card()
    const second = card({ seq: 2, next: 'Write tests' })
    const folded = foldJspace([
      event('jspace/card', first, 0),
      event('jspace/card', second, 1),
    ], owner)
    expect(folded.card?.next).toBe('Write tests')
    expect(folded.card?.seq).toBe(2)
    expect(folded.fault).toBeUndefined()
  })

  it('treats a native close as a tombstone', () => {
    const folded = foldJspace([
      event('jspace/card', card(), 0),
      event('jspace/closed', { seq: 2, sessionId: owner }, 1),
    ], owner)
    expect(folded.card).toBeNull()
    expect(folded.closed).toBe(true)
  })

  it('keeps the last good snapshot when a native close seq regresses', () => {
    const folded = foldJspace([
      event('jspace/card', card({ seq: 2 }), 0),
      event('jspace/closed', { seq: 1, sessionId: owner }, 1),
    ], owner)
    expect(folded.card?.seq).toBe(2)
    expect(folded.fault).toMatch(/regresses/)
  })

  it('keeps the last good snapshot when a native seq regresses', () => {
    const first = card()
    const folded = foldJspace([
      event('jspace/card', first, 0),
      event('jspace/card', card({ seq: 1, next: 'clobber' }), 1),
    ], owner)
    expect(folded.card?.next).toBe('Write the fold')
    expect(folded.fault).toMatch(/regresses/)
  })

  it('records a foreign write after the native origin as a fault', () => {
    const folded = foldJspace([
      event('jspace/card', card(), 0),
      event('jspace/card', card({ seq: 2, sessionId: 'sess-b', next: 'hostile' }), 1),
    ], owner)
    expect(folded.card?.next).toBe('Write the fold')
    expect(folded.fault).toMatch(/cross-session/)
  })

  it('keeps a foreign card as inherited before any native origin', () => {
    const parent = card({ sessionId: 'sess-parent' })
    const folded = foldJspace([event('jspace/card', parent, 0)], owner)
    expect(folded.card).toBeNull()
    expect(folded.inherited?.sessionId).toBe('sess-parent')
    expect(folded.fault).toBeUndefined()
  })

  it('rebuilds to the last good snapshot when a later event is malformed', () => {
    const folded = foldJspace([
      event('jspace/card', card(), 0),
      event('jspace/card', { seq: 2, sessionId: owner }, 1),
    ], owner)
    expect(folded.card?.goal).toBe('Ship the feature')
    expect(folded.fault).toMatch(/must be/)
  })

  it('decodes optional evidence, verified, and settles', () => {
    const decoded = decodeJspaceCard(card({
      checked: [{ n: 1, check: 'a', by: 'unit tests', evidence: 'c1', verified: true }],
      open: [{ question: 'q', settles: 's' }],
    }))
    expect(decoded.checked[0]).toEqual({
      n: 1,
      check: 'a',
      by: 'unit tests',
      evidence: 'c1',
      verified: true,
    })
    expect(decoded.open[0]?.settles).toBe('s')
  })

  it('rejects a reused checked number at decode', () => {
    expect(() => decodeJspaceCard(card({
      checked: [
        { n: 1, check: 'a', by: 'unit tests' },
        { n: 1, check: 'b', by: 'unit tests' },
      ],
    }))).toThrow(/reused/)
  })

  it.each([
    [null, /must be a record/],
    [{ ...card(), core: 'x' }, /core must be an array/],
    [{ ...card(), core: ['a', 'b', 'c'] }, /at most two/],
    [{ ...card(), checked: 'x' }, /checked must be an array/],
    [{ ...card(), checked: [null] }, /checked line must be a record/],
    [{ ...card(), checked: [{ n: 1, check: 'a', by: 'b', evidence: '' }] }, /evidence/],
    [{ ...card(), checked: [{ n: 1, check: 'a', by: 'b', verified: false }] as never }, /verified/],
    [{ ...card(), open: 'x' }, /open must be an array/],
    [{ ...card(), open: [null] }, /open line must be a record/],
    [{ ...card(), open: [{ question: 'q', settles: '' }] }, /settles/],
    [{ ...card(), seq: 0 }, /positive/],
  ])('rejects a malformed card', (value, message) => {
    expect(() => decodeJspaceCard(value)).toThrow(message)
  })

  it('rejects a malformed close', () => {
    expect(() => decodeJspaceClosed(null)).toThrow(/must be a record/)
  })

  it('records a foreign close after the native origin as a fault', () => {
    const folded = foldJspace([
      event('jspace/card', card(), 0),
      event('jspace/closed', { seq: 2, sessionId: 'sess-b' }, 1),
    ], owner)
    expect(folded.card?.goal).toBe('Ship the feature')
    expect(folded.fault).toMatch(/cross-session/)
  })

  it('clears inherited state when the parent closed', () => {
    const folded = foldJspace([
      event('jspace/card', card({ sessionId: 'sess-parent' }), 0),
      event('jspace/closed', { seq: 2, sessionId: 'sess-parent' }, 1),
    ], owner)
    expect(folded.inherited).toBeNull()
    expect(folded.card).toBeNull()
  })

  it('ignores unrelated events', () => {
    const folded = foldJspace([
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as SessionEvent,
    ], owner)
    expect(folded.card).toBeNull()
  })
})

const reprint = {
  checkedReprintLimit: DEFAULT_CHECKED_REPRINT_LIMIT,
  openReprintLimit: DEFAULT_OPEN_REPRINT_LIMIT,
}

describe('formatJspaceCard', () => {
  it('emits harness-authored labels, not content-supplied ones', () => {
    const text = formatJspaceCard(card({
      core: ['seat', 'fold'],
      checked: [{ n: 1, check: 'replay', by: 'unit tests' }],
      open: [{ question: 'UI?', settles: 'W5' }],
    }), reprint)
    expect(text).toBe([
      'Goal:      Ship the feature',
      'Core:      seat; fold',
      'Checked:   ✓1 replay — unit tests',
      'Open:      UI? [W5]',
      'Next:      Write the fold',
    ].join('\n'))
    expect(JSPACE_AVAILABLE_LINE).toMatch(/Open a card/)
    expect(JSPACE_ALWAYS_OPEN_GOAL).toBe('J-Space is on')
    expect(JSPACE_ALWAYS_OPEN_NEXT).toBe('State the first action')
    expect(matchesCoverageTerms('I looked')).toBe(false)
    expect(matchesCoverageTerms('unit tests')).toBe(true)
    expect(matchesCoverageTerms('the community reviewed the latest notes')).toBe(false)
    expect(matchesCoverageTerms('覆盖全部', ['覆盖'])).toBe(true)
    expect(formatJspaceCard(card({ core: [], checked: [], open: [{ question: 'alone' }] }), reprint)).toContain('Core:      (none)')
    expect(formatJspaceCard(card({ checked: [], open: [] }), reprint).split('\n')[2]).toBe('Checked:   (none)')
  })

  it('prints the last N Checked and last M Open lines and prepends elision counts', () => {
    const checked = [1, 2, 3, 4, 5, 6, 7].map(n => ({
      n,
      check: `c${String(n)}`,
      by: 'unit tests',
    }))
    const open = [1, 2, 3, 4].map(n => ({ question: `q${String(n)}` }))
    const text = formatJspaceCard(card({ checked, open }), {
      checkedReprintLimit: 3,
      openReprintLimit: 2,
    })
    expect(text).toBe([
      'Goal:      Ship the feature',
      'Core:      seat',
      formatJspaceCheckedElision(4),
      'Checked:   ✓5 c5 — unit tests; ✓6 c6 — unit tests; ✓7 c7 — unit tests',
      formatJspaceOpenElision(2),
      'Open:      q3; q4',
      'Next:      Write the fold',
    ].join('\n'))
  })

  it('omits the elision line when a section has exactly the reprint limit', () => {
    const checked = [1, 2, 3, 4, 5].map(n => ({
      n,
      check: `c${String(n)}`,
      by: 'unit tests',
    }))
    const text = formatJspaceCard(card({ checked, open: [] }), reprint)
    expect(text).toBe([
      'Goal:      Ship the feature',
      'Core:      seat',
      'Checked:   ✓1 c1 — unit tests; ✓2 c2 — unit tests; ✓3 c3 — unit tests; ✓4 c4 — unit tests; ✓5 c5 — unit tests',
      'Open:      (none)',
      'Next:      Write the fold',
    ].join('\n'))
    expect(text).not.toContain('elided')
  })
})

describe('matchesCoverageTerms', () => {
  it('accepts verification-method claims written as natural prose', () => {
    expect(matchesCoverageTerms('covering roe.py, targets.py, and runner.py')).toBe(true)
    expect(matchesCoverageTerms('direct source reads: git show d7eabfb diff; grep redeem across src')).toBe(true)
    expect(matchesCoverageTerms('bash git-history scan over the last 200 commits')).toBe(true)
    expect(matchesCoverageTerms('hygiene check via git ls-files')).toBe(true)
    expect(matchesCoverageTerms('Verifier: ox-alpha. Coverage: full unit suite.')).toBe(true)
  })

  it('keeps vague social claims and word-internal matches out', () => {
    expect(matchesCoverageTerms('I looked')).toBe(false)
    expect(matchesCoverageTerms('the community reviewed the latest notes')).toBe(false)
    expect(matchesCoverageTerms('test_http_app_target.py')).toBe(false)
  })
})
