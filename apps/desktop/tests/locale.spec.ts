import { describe, expect, it } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLocale } from '../src/locale.ts'

describe('desktop locale dictionary', () => {
  it('resolves every Electron locale to the shipped English dictionary', () => {
    expect(resolveDesktopLocale('en')).toEqual({ id: 'en', messages: en })
    expect(resolveDesktopLocale('en-US')).toEqual({ id: 'en', messages: en })
    expect(resolveDesktopLocale('fr-FR')).toEqual({ id: 'en', messages: en })
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })
})
