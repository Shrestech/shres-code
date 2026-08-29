import { describe, expect, it } from 'vitest'
import { apply, name } from '../src/invariant.ts'

describe('invariant companion', () => {
  it('registers an empty installer under its declared name', async () => {
    expect(name).toBe('host-remote-control-invariant')
    const registered: string[] = []
    const disposer = await apply({ invariants: { register: (pkg: string) => { registered.push(pkg); return () => undefined } } } as never)
    expect(registered).toEqual(['@shres-code/shres-code-host-remote-control'])
    expect(typeof disposer).toBe('function')
    disposer()
  })
})
