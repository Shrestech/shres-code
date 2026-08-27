import { describe, expect, it } from 'vitest'
import { CharterEntryId } from '@shres-code/shres-code-jspace'
import {
  assignCharterIds,
  charterOpenRefusal,
  expandCharterItems,
  planCharterAmend,
  refuseCharterCap,
} from '../src/charter-resolve.ts'
import { applyFailProbe } from '../src/charter-probe.ts'

describe('expandCharterItems', () => {
  const proposal = [
    { kind: 'prose' as const, id: CharterEntryId('e1'), constraint: 'Be kind to reviewers.' },
    { kind: 'prose' as const, id: CharterEntryId('e2'), constraint: 'Keep diffs small.' },
  ]

  it('expands accept-proposal first, then appends explicit adds', () => {
    const expanded = expandCharterItems([
      { kind: 'prose', constraint: 'extra rule' },
      { kind: 'accept-proposal', ids: ['e2'] },
    ], proposal)
    expect(expanded.map(entry => entry.constraint)).toEqual(['Keep diffs small.', 'extra rule'])
  })

  it('refuses an unknown accept-proposal id', () => {
    expect(() => expandCharterItems([{ kind: 'accept-proposal', ids: ['nope'] }], proposal))
      .toThrow(/not in the harness proposal/)
  })

  it('refuses an accept-proposal with no proposal event', () => {
    expect(() => expandCharterItems([{ kind: 'accept-proposal' }], undefined))
      .toThrow(/requires a jspace\/charter-proposal/)
  })

  it('refuses an id collision between accepted and explicit entries', () => {
    expect(() => expandCharterItems([
      { kind: 'accept-proposal' },
      { kind: 'prose', id: CharterEntryId('e1'), constraint: 'dup' },
    ], proposal)).toThrow(/collides/)
  })
})

describe('assignCharterIds', () => {
  it('fills omitted ids without colliding with taken ones', () => {
    const assigned = assignCharterIds(
      [{ kind: 'prose', constraint: 'a' }, { kind: 'prose', constraint: 'b' }],
      new Set(['e1']),
    )
    expect(assigned.map(entry => entry.id)).toEqual(['e2', 'e3'])
  })
})

describe('planCharterAmend', () => {
  it('drops, replaces, then appends adds', () => {
    const current = [
      { kind: 'prose' as const, id: CharterEntryId('e1'), constraint: 'keep' },
      { kind: 'prose' as const, id: CharterEntryId('e2'), constraint: 'drop-me' },
      { kind: 'prose' as const, id: CharterEntryId('e3'), constraint: 'replace-me' },
    ]
    const plan = planCharterAmend(
      current,
      ['e2'],
      [{ id: 'e3', entry: { kind: 'prose', constraint: 'replaced' } }],
      [{ kind: 'prose', constraint: 'added' }],
    )
    expect(plan.kept.map(entry => entry.id)).toEqual(['e1'])
    expect(plan.dropped).toEqual(['e2'])
    expect(plan.replaced).toEqual(['e3'])
    expect(plan.added.map(entry => entry.constraint)).toEqual(['replaced', 'added'])
  })

  it('refuses dropping an unknown id', () => {
    expect(() => planCharterAmend([], ['e1'], undefined, undefined)).toThrow(/is not on the card/)
  })
})

describe('refuseCharterCap', () => {
  it('names the cap when the resulting list would exceed it', () => {
    expect(refuseCharterCap(12, 12)).toBeUndefined()
    expect(refuseCharterCap(13, 12)).toMatch(/maxCharterEntries is 12/)
  })
})

describe('charterOpenRefusal', () => {
  it('refuses an empty list when requireCharter is set', () => {
    expect(charterOpenRefusal([], {
      requireCharter: true,
      requireExecutableCharter: false,
      charterDiscrimination: 'off',
    })).toMatch(/requires a charter/)
  })
})

describe('applyFailProbe', () => {
  it('inserts, prepends, and replaces content', () => {
    expect(applyFailProbe(undefined, { kind: 'insert', content: 'x' })).toBe('x')
    expect(applyFailProbe('body', { kind: 'prepend', content: 'head' })).toBe('headbody')
    expect(applyFailProbe('aa bb', { kind: 'replace', from: 'bb', to: 'cc' })).toBe('aa cc')
    expect(applyFailProbe(undefined, { kind: 'replace', from: 'a', to: 'b' })).toBeUndefined()
    expect(applyFailProbe('aa', { kind: 'replace', from: 'zz', to: 'b' })).toBeUndefined()
  })
})
