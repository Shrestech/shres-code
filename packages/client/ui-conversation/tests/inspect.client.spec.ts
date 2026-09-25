// @vitest-environment jsdom
/** Persisted-snapshot read of the inspect request, and the reveal write through the chat store. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReveal, readInspectRequest, TRAJECTORY_VIEW_ID } from '../src/client/inspect.ts'
import { createChatStore, readActivityOpen } from '../src/client/stores.ts'

const KEY = 'shres.conversation.chat'

beforeEach(() => {
  localStorage.clear()
})

describe('readInspectRequest', () => {
  it('returns a current call or event request as the same object', () => {
    const call = { view: 'trajectory', target: { kind: 'call', callId: 'c1' } }
    const event = { view: 'routing', target: { kind: 'event', seq: 0 } }
    expect(readInspectRequest(call)).toBe(call)
    expect(readInspectRequest(event)).toBe(event)
  })

  it('reads the legacy { callId } value as a Trajectory call target', () => {
    expect(readInspectRequest({ callId: 'c1' })).toEqual({
      view: TRAJECTORY_VIEW_ID, target: { kind: 'call', callId: 'c1' },
    })
  })

  it('reads an absent or malformed value as null', () => {
    for (const value of [
      undefined, null, 'c1', 7,
      {}, { callId: '' }, { callId: 3 },
      { view: '', target: { kind: 'call', callId: 'c1' } },
      { view: 4, target: { kind: 'call', callId: 'c1' } },
      { view: 'trajectory' },
      { target: { kind: 'call', callId: 'c1' } },
      { view: 'trajectory', target: null },
      { view: 'trajectory', target: 'c1' },
      { view: 'trajectory', target: { kind: 'call', callId: '' } },
      { view: 'trajectory', target: { kind: 'call' } },
      { view: 'trajectory', target: { kind: 'event', seq: -1 } },
      { view: 'trajectory', target: { kind: 'event', seq: 1.5 } },
      { view: 'trajectory', target: { kind: 'event', seq: '4' } },
      { view: 'trajectory', target: { kind: 'file', path: 'a.ts' } },
    ]) {
      expect(readInspectRequest(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('reads a rehydrated legacy snapshot through the store the header and session share', () => {
    localStorage.setItem(`${KEY}.s1`, JSON.stringify({
      selection: null, draft: '', view: 'trajectory', inspect: { callId: 'c9' },
    }))
    const store = createChatStore().create('s1')
    const snapshot = store.store.getSnapshot()
    expect(readInspectRequest(snapshot.inspect)).toEqual({
      view: 'trajectory', target: { kind: 'call', callId: 'c9' },
    })
    // A snapshot written before the Activity field reads as closed.
    expect(readActivityOpen(snapshot.activityOpen)).toBe(false)
    expect(readActivityOpen(true)).toBe(true)
  })
})

describe('createReveal', () => {
  it('writes the request, then selects its view, then closes Activity', () => {
    const calls: string[] = []
    const reveal = createReveal({
      setInspect: vi.fn(() => { calls.push('setInspect') }),
      setView: vi.fn((view: string) => { calls.push(`setView:${view}`) }),
      setActivityOpen: vi.fn((open: boolean) => { calls.push(`setActivityOpen:${String(open)}`) }),
    })
    reveal({ view: 'routing', target: { kind: 'event', seq: 6 } })
    expect(calls).toEqual(['setInspect', 'setView:routing', 'setActivityOpen:false'])
  })

  it('selects the view without storing a request for a none target', () => {
    const store = createChatStore().create()
    store.actions.setInspect({ view: 'trajectory', target: { kind: 'call', callId: 'c1' } as never })
    createReveal(store.actions)({ view: 'routing', target: { kind: 'none' } })
    expect(store.store.getSnapshot()).toMatchObject({ inspect: null, view: 'routing', activityOpen: false })
  })

  it('lands in the session store as one addressed request with Activity closed', () => {
    const store = createChatStore().create()
    store.actions.setActivityOpen(true)
    const request = { view: 'trajectory', target: { kind: 'event', seq: 12 } } as const
    createReveal(store.actions)(request)
    expect(store.store.getSnapshot()).toMatchObject({ inspect: request, view: 'trajectory', activityOpen: false })
  })
})
