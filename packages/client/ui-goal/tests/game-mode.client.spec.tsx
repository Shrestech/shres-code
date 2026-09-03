// @vitest-environment jsdom
// Game mode switch and the settings predicate that gates the fight arena.

import { createElement, type ComponentType } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate, stubSettingsScope } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { GameModeToggle } from '../src/client/GameModeToggle.tsx'
import { gameSettingsEnabled } from '../src/client/game-settings.ts'
import { en } from '../src/client/locales.ts'
import type { GameSettings } from '../src/client/game-settings.ts'

function renderLoose(component: ComponentType<never>, props: object) {
  return render(createElement(component, props as never) as never)
}

afterEach(cleanup)

const t = makeTranslate(en, commonEn)

function mountToggle(enabled: boolean, writable = true) {
  const setEnabled = vi.fn(() => Promise.resolve())
  const host = stubSettingsScope<GameSettings>()
  host.publish({
    status: 'ready',
    value: { enabled },
    writable,
  })
  const useGameSettings = <T,>(select: (snapshot: ReturnType<typeof host.scope.getSnapshot>) => T) =>
    select(host.scope.getSnapshot())
  renderLoose(GameModeToggle, {
    session: {},
    input: {},
    useGameSettings,
    setEnabled,
    t,
  })
  return { setEnabled }
}

describe('gameSettingsEnabled', () => {
  it('is true only on a ready document with enabled: true', () => {
    expect(gameSettingsEnabled({ status: 'loading', value: { enabled: true } })).toBe(false)
    expect(gameSettingsEnabled({ status: 'ready', value: { enabled: false } })).toBe(false)
    expect(gameSettingsEnabled({ status: 'ready', value: undefined })).toBe(false)
    expect(gameSettingsEnabled({ status: 'ready', value: { enabled: true } })).toBe(true)
  })
})

describe('GameModeToggle', () => {
  it('toggles Game mode through setEnabled', () => {
    const { setEnabled } = mountToggle(false)
    expect(screen.getByRole('switch', { name: 'Turn Game mode on' })).toBeTruthy()
    fireEvent.click(screen.getByRole('switch'))
    expect(setEnabled).toHaveBeenCalledWith(true)
  })

  it('disables the switch when the document is not writable', () => {
    mountToggle(true, false)
    expect(screen.getByRole('switch', { name: 'Turn Game mode off' })).toHaveProperty('disabled', true)
  })

  it('disables the switch while settings are loading', () => {
    const setEnabled = vi.fn(() => Promise.resolve())
    renderLoose(GameModeToggle, {
      session: {},
      input: {},
      useGameSettings: () => ({ status: 'loading', value: undefined, writable: false }),
      setEnabled,
      t,
    })
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
  })
})
