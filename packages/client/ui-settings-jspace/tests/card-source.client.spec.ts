/** Last-known J-Space card view from the selected session projection. */

import { describe, expect, it, vi } from 'vitest'
import {
  createJSpaceViewSource,
  foldJSpaceCardView,
  readJSpaceView,
  subscribeJSpaceView,
  type JSpaceSessionRead,
} from '../src/client/card-source.ts'

function sessions(partial: {
  current?: string
  raw?: unknown
  listed?: boolean
}): JSpaceSessionRead & {
  listListeners: Set<() => void>
  faceListeners: Set<() => void>
} {
  const listListeners = new Set<() => void>()
  const faceListeners = new Set<() => void>()
  const listed = partial.listed ?? true
  const face = {
    getSnapshot: () => partial.raw,
    subscribe: (listener: () => void) => {
      faceListeners.add(listener)
      return () => { faceListeners.delete(listener) }
    },
  }
  return {
    listListeners,
    faceListeners,
    list: {
      getSnapshot: () => ({ current: partial.current }),
      subscribe: (listener: () => void) => {
        listListeners.add(listener)
        return () => { listListeners.delete(listener) }
      },
    },
    binding: (id: string) => {
      if (!listed || id !== partial.current) return undefined
      return { session: { projections: { faceOf: () => face } } }
    },
  }
}

describe('foldJSpaceCardView', () => {
  it('keeps the previous view when the snapshot is absent', () => {
    const previous = { open: true, checked: 4 }
    expect(foldJSpaceCardView(undefined, previous)).toBe(previous)
    expect(foldJSpaceCardView({}, previous)).toBe(previous)
  })

  it('reads an open card and a close tombstone', () => {
    expect(foldJSpaceCardView({ card: { checked: ['a', 'b'] } }, undefined)).toEqual({
      open: true,
      checked: 2,
    })
    expect(foldJSpaceCardView({ card: null }, { open: true, checked: 2 })).toEqual({
      open: false,
      checked: 2,
    })
    expect(foldJSpaceCardView({ card: null }, undefined)).toEqual({
      open: false,
      checked: 0,
    })
    expect(foldJSpaceCardView({ card: {} }, undefined)).toEqual({
      open: true,
      checked: 0,
    })
    expect(foldJSpaceCardView(
      { card: { sessionId: 'parent', checked: ['a'] } },
      { open: false, checked: 0 },
      'child',
    )).toEqual({ open: false, checked: 0 })
    expect(foldJSpaceCardView(
      { card: { sessionId: 'parent', checked: ['a'] } },
      undefined,
      'child',
    )).toEqual({ open: false, checked: 0 })
  })

  it('returns the previous object when open and checked match', () => {
    const open = { open: true, checked: 1 }
    expect(foldJSpaceCardView({ card: { checked: ['x'] } }, open)).toBe(open)
    const closed = { open: false, checked: 2 }
    expect(foldJSpaceCardView({ card: null }, closed)).toBe(closed)
    expect(foldJSpaceCardView(
      { card: { sessionId: 'parent', checked: ['a'] } },
      closed,
      'child',
    )).toBe(closed)
    expect(foldJSpaceCardView({ card: { checked: ['a', 'b'] } }, open)).not.toBe(open)
  })
})

describe('readJSpaceView', () => {
  it('returns the previous view without a current session', () => {
    const previous = { open: true, checked: 1 }
    expect(readJSpaceView(sessions({}), previous)).toBe(previous)
  })

  it('returns the previous view when the session is not bound', () => {
    const previous = { open: false, checked: 5 }
    expect(readJSpaceView(sessions({ current: 's1', listed: false }), previous)).toBe(previous)
  })

  it('reads the selected session projection', () => {
    expect(readJSpaceView(sessions({
      current: 's1',
      raw: { card: { checked: ['one'] } },
    }), undefined)).toEqual({ open: true, checked: 1 })
  })
})

describe('createJSpaceViewSource', () => {
  it('keeps last-known counts across a missing session', () => {
    const source = createJSpaceViewSource(sessions({
      current: 's1',
      raw: { card: { checked: ['a', 'b', 'c'] } },
    }))
    expect(source.getSnapshot()).toEqual({ open: true, checked: 3 })
    const empty = createJSpaceViewSource(sessions({}))
    expect(empty.getSnapshot()).toBeUndefined()
  })

  it('returns the same snapshot object while the card is unchanged', () => {
    const source = createJSpaceViewSource(sessions({
      current: 's1',
      raw: { card: { checked: ['a'] } },
    }))
    const first = source.getSnapshot()
    expect(source.getSnapshot()).toBe(first)
    expect(source.getSnapshot()).toBe(first)
  })

  it('notifies on list and face changes and disposes both', () => {
    const handle = sessions({ current: 's1', raw: { card: null } })
    const listener = vi.fn()
    const off = subscribeJSpaceView(handle, listener)
    expect(handle.listListeners.size).toBe(1)
    expect(handle.faceListeners.size).toBe(1)
    for (const notify of handle.faceListeners) notify()
    expect(listener).toHaveBeenCalledTimes(1)
    for (const notify of handle.listListeners) notify()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    expect(handle.listListeners.size).toBe(0)
    expect(handle.faceListeners.size).toBe(0)
  })

  it('attaches no face when no session is selected or bound', () => {
    const missing = sessions({})
    const unbound = sessions({ current: 's1', listed: false })
    const listener = vi.fn()
    const offMissing = subscribeJSpaceView(missing, listener)
    const offUnbound = subscribeJSpaceView(unbound, listener)
    expect(missing.faceListeners.size).toBe(0)
    expect(unbound.faceListeners.size).toBe(0)
    for (const notify of missing.listListeners) notify()
    expect(listener).toHaveBeenCalledTimes(1)
    offMissing()
    offUnbound()
  })

  it('exposes subscribe through the source', () => {
    const handle = sessions({ current: 's1', raw: { card: null } })
    const source = createJSpaceViewSource(handle)
    const off = source.subscribe(() => {})
    expect(handle.faceListeners.size).toBe(1)
    off()
    expect(handle.faceListeners.size).toBe(0)
  })
})
