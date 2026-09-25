import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../src/runtime/sessions.ts'

const owner = 'owner-a' as never
const other = 'owner-b' as never
const session = (id: string) => id as never
const instance = (id: string) => id as never

describe('SessionRegistry', () => {
  it('registers, lists, and unregisters per owner', () => {
    const registry = new SessionRegistry()
    registry.register(owner, session('s1'), instance('i1'))
    registry.register(other, session('s2'), instance('i1'))
    expect(registry.listFor(owner)).toEqual([session('s1')])
    expect(registry.listFor(other)).toEqual([session('s2')])
    registry.unregister(session('s1'))
    expect(registry.listFor(owner)).toEqual([])
    expect(registry.isOwnedBy(other, session('s2'))).toBe(true)
  })

  it('never leaks one owner\'s session to another', () => {
    const registry = new SessionRegistry()
    registry.register(owner, session('s1'), instance('i1'))
    expect(registry.isOwnedBy(other, session('s1'))).toBe(false)
    expect(registry.instanceOf(session('s1'))).toBe(instance('i1'))
    expect(registry.instanceOf(session('missing'))).toBeUndefined()
  })

  it('orders shutdown independently of owners', () => {
    const registry = new SessionRegistry()
    registry.register(owner, session('s1'), instance('i1'))
    registry.register(other, session('s2'), instance('i1'))
    expect(registry.all()).toEqual([session('s1'), session('s2')])
    registry.clear()
    expect(registry.all()).toEqual([])
  })
})
