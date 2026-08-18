// Node half registers the `game` settings namespace when a settings service exists.

import { Context } from '@shres-code/cordis'
import { describe, expect, it } from 'vitest'
import { apply, Config, GAME_SETTINGS_HOOKS, GAME_SETTINGS_NAMESPACE } from '../src/index.ts'

describe('ui-goal node apply', () => {
  it('is a no-op without a context', () => {
    expect(() => { apply() }).not.toThrow()
  })

  it('wires the game settings section onto a context', () => {
    const ctx = new Context()
    apply(ctx)
    GAME_SETTINGS_HOOKS.setSource(() => ({ enabled: false }))
    GAME_SETTINGS_HOOKS.onChange()
    expect(GAME_SETTINGS_NAMESPACE).toBe('game')
    expect(Config(undefined)).toEqual({ enabled: false })
  })
})
