import { describe, expect, it } from 'vitest'
import {
  assertRolePair,
  boundRole,
  isWikiPath,
  resolveEngine,
  resolveLog,
  resolveWrite,
  titleFrom,
  WikiError,
} from '../src/resolve.ts'

describe('isWikiPath', () => {
  it('accepts posix-relative markdown and rejects escapes and reserved names', () => {
    expect(isWikiPath('notes.md')).toBe(true)
    expect(isWikiPath('topics/a.md')).toBe(true)
    expect(isWikiPath('../x.md')).toBe(false)
    expect(isWikiPath('/abs.md')).toBe(false)
    expect(isWikiPath('index.md')).toBe(false)
    expect(isWikiPath('config.yaml')).toBe(false)
    expect(isWikiPath('log/2026-01-01.md')).toBe(false)
    expect(isWikiPath('notes.txt')).toBe(false)
  })
})

describe('titleFrom', () => {
  it('prefers the first heading and falls back to the path stem', () => {
    expect(titleFrom('# Hello\n\nbody', 'x.md')).toBe('Hello')
    expect(titleFrom('no heading', 'dir/stem.md')).toBe('stem')
    expect(titleFrom('#   \n', 'plain.md')).toBe('plain')
  })
})

describe('resolveWrite', () => {
  it('defaults tags and contradicts and keeps a supplied title', () => {
    expect(resolveWrite({
      path: 'p.md',
      body: 'body',
      title: 'T',
      superseded_by: 'old.md',
    })).toEqual({
      path: 'p.md',
      title: 'T',
      body: 'body',
      tags: [],
      contradicts: [],
      superseded_by: 'old.md',
    })
  })

  it('rejects blank path, illegal path, non-string body, and blank title', () => {
    expect(() => resolveWrite({ path: '  ', body: 'b' })).toThrow(WikiError)
    expect(() => resolveWrite({ path: '../x.md', body: 'b' })).toThrow(/legal wiki-relative/)
    expect(() => resolveWrite({ path: 'p.md', body: 1 as unknown as string })).toThrow(/body string/)
    expect(() => resolveWrite({ path: 'p.md', body: 'b', title: '   ' })).toThrow(/non-empty title/)
  })
})

describe('resolveLog', () => {
  it('accepts a non-empty body and rejects a blank one', () => {
    expect(resolveLog({ body: 'entry' })).toEqual({ body: 'entry' })
    expect(() => resolveLog({ body: '  ' })).toThrow(WikiError)
  })
})

describe('resolveEngine', () => {
  it('accepts ordered positive integers and rejects inverted or non-integer values', () => {
    expect(resolveEngine({ hotDays: 1, warmDays: 2, demoteDays: 3, indexMaxLines: 8 }))
      .toEqual({ hotDays: 1, warmDays: 2, demoteDays: 3, indexMaxLines: 8 })
    expect(() => resolveEngine({ hotDays: 5, warmDays: 4, demoteDays: 10, indexMaxLines: 8 }))
      .toThrow(/warmDays/)
    expect(() => resolveEngine({ hotDays: 1, warmDays: 10, demoteDays: 5, indexMaxLines: 8 }))
      .toThrow(/demoteDays/)
    expect(() => resolveEngine({ hotDays: 0, warmDays: 2, demoteDays: 3, indexMaxLines: 8 }))
      .toThrow(/hotDays/)
  })
})

describe('boundRole', () => {
  it('requires both trimmed fields', () => {
    expect(boundRole(undefined)).toBeUndefined()
    expect(boundRole({})).toBeUndefined()
    expect(boundRole({ provider: 'p' })).toBeUndefined()
    expect(boundRole({ provider: '  ', model: 'm' })).toBeUndefined()
    expect(boundRole({ provider: 'p', model: 'm' })).toEqual({ provider: 'p', model: 'm' })
  })
})

describe('assertRolePair', () => {
  it('accepts unbound or fully bound pairs and rejects a half pair', () => {
    expect(() => { assertRolePair(undefined) }).not.toThrow()
    expect(() => { assertRolePair({}) }).not.toThrow()
    expect(() => { assertRolePair({ provider: 'p', model: 'm' }) }).not.toThrow()
    expect(() => { assertRolePair({ provider: 'p' }) }).toThrow(/together/)
    expect(() => { assertRolePair({ model: 'm' }) }).toThrow(/together/)
  })
})
