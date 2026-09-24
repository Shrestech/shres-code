/**
 * `provideProfileRuntime` provides under its documented key with a frozen
 * bundle copy, so a later mutation of the caller's array cannot change what
 * injected plugins observe.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@shres-code/cordis'
import { PROFILE_RUNTIME_KEY, provideProfileRuntime, type ProfileRuntime } from '../src/profile-runtime.ts'

interface Recorded {
  key: string
  value: ProfileRuntime
}

function recordingContext(): { ctx: Context; recorded: Recorded[] } {
  const recorded: Recorded[] = []
  const ctx = { provide: (key: string, value: unknown): void => { recorded.push({ key, value: value as ProfileRuntime }) } }
  return { ctx: ctx as unknown as Context, recorded }
}

describe('provideProfileRuntime', () => {
  it('provides the booted profile facts under the profileRuntime key', () => {
    const { ctx, recorded } = recordingContext()
    provideProfileRuntime(ctx, { profileDir: '/profiles/main', bootBundles: ['base', 'demo'], pluginMutations: 'enabled' })
    expect(recorded).toEqual([{ key: PROFILE_RUNTIME_KEY, value: { profileDir: '/profiles/main', bootBundles: ['base', 'demo'], pluginMutations: 'enabled' } }])
  })

  it('freezes the bundle copy against later caller mutations', () => {
    const { ctx, recorded } = recordingContext()
    const bootBundles = ['base']
    provideProfileRuntime(ctx, { profileDir: '/profiles/main', bootBundles, pluginMutations: 'unsupported' })
    bootBundles.push('late-comer')
    expect(recorded[0]?.value.bootBundles).toEqual(['base'])
    expect(Object.isFrozen(recorded[0]?.value.bootBundles)).toBe(true)
  })
})
