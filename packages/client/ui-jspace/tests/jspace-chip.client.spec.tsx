// @vitest-environment jsdom
/**
 * JSpaceChip over Settings enabled and the jspace projection: hidden
 * while Settings is off; off-state opens via /j-space on; on-state
 * closes via /j-space off and stays visible through failures.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { SettingsScopeSnapshot } from '@shres-code/shres-code-client-runtime/client'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type { JspaceCard, JspaceProjection } from '@shres-code/shres-code-jspace/client'
import { JSpaceChip, type JSpaceChipProps } from '../src/client/JSpaceChip.tsx'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { en } from '../src/client/locales.ts'
import type { JSpaceSettings } from '../src/client/settings.ts'

afterEach(cleanup)

const t: JSpaceChipProps['t'] = makeTranslate(en, commonEn)

function card(over: Partial<JspaceCard> = {}): JspaceCard {
  return {
    seq: 1,
    sessionId: 's1',
    goal: 'Ship the redesign',
    core: [],
    checked: [],
    open: [],
    next: 'Write the dock',
    goalOpenedSeq: 1,
    charter: [],
    ...over,
  }
}

function settingsSnap(enabled: boolean | undefined, status: SettingsScopeSnapshot<JSpaceSettings>['status'] = 'ready'): SettingsScopeSnapshot<JSpaceSettings> {
  return {
    status,
    value: enabled === undefined ? undefined : { enabled },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
  }
}

function setup(
  settings: SettingsScopeSnapshot<JSpaceSettings>,
  jspace: JspaceProjection | undefined,
  closeCard = vi.fn(() => Promise.resolve<string | null>(null)),
  openCard = vi.fn(() => Promise.resolve<string | null>(null)),
) {
  const settingsStore = createSnapshotStore(settings)
  const projectionStore = createSnapshotStore<{ value: JspaceProjection | undefined }>({ value: jspace })
  const useJspaceSettings = bindSnapshotSelector(settingsStore)
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(projectionStore)(s => (selector ?? (v => v))(s.value))
  const props = {
    useProjection, useJspaceSettings, closeCard, openCard, sessionId: 's1', t,
  } as unknown as JSpaceChipProps
  const view = render(<JSpaceChip {...props} />)
  return { settingsStore, projectionStore, closeCard, openCard, view }
}

describe('JSpaceChip', () => {
  it('renders nothing while Settings is loading, unavailable, or disabled', () => {
    const loading = setup(settingsSnap(undefined, 'loading'), { card: null, closed: false })
    expect(loading.view.container.innerHTML).toBe('')
    cleanup()
    const unavailable = setup(settingsSnap(undefined, 'unavailable'), { card: null, closed: false })
    expect(unavailable.view.container.innerHTML).toBe('')
    cleanup()
    const off = setup(settingsSnap(false), { card: card(), closed: false })
    expect(off.view.container.innerHTML).toBe('')
  })

  it('treats an inherited parent card as off', () => {
    setup(settingsSnap(true), { card: card({ sessionId: 'parent' }), closed: false })
    expect(screen.getByRole('button', { name: 'J-Space off, press to turn on' })).toBeTruthy()
  })

  it('renders the off-state chip when Settings is on and no card is open', () => {
    setup(settingsSnap(true), { card: null, closed: false })
    const button = screen.getByRole('button', { name: 'J-Space off, press to turn on' })
    expect(button.textContent).toBe('J-Space')
  })

  it('renders the on-state chip when a card is open and closes it', async () => {
    const { closeCard } = setup(settingsSnap(true), { card: card(), closed: false })
    const button = screen.getByRole('button', { name: 'J-Space on, press to turn off' })
    expect(button.textContent).toBe('J-Space')
    fireEvent.click(button)
    expect(closeCard).toHaveBeenCalledTimes(1)
  })

  it('opens a card from the off-state chip', () => {
    const { openCard } = setup(settingsSnap(true), { card: null, closed: true })
    fireEvent.click(screen.getByRole('button', { name: 'J-Space off, press to turn on' }))
    expect(openCard).toHaveBeenCalledTimes(1)
  })

  it('surfaces admission and transport failures while staying visible', async () => {
    const closeCard = vi.fn()
      .mockResolvedValueOnce('host said no')
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce('socket closed')
    setup(settingsSnap(true), { card: card(), closed: false }, closeCard)
    fireEvent.click(screen.getByRole('button', { name: 'J-Space on, press to turn off' }))
    expect((await screen.findByText('failed to close J-Space')).getAttribute('title')).toBe('host said no')
    fireEvent.click(screen.getByRole('button', { name: 'J-Space on, press to turn off' }))
    expect(await screen.findByTitle('network down')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'J-Space on, press to turn off' }))
    expect(await screen.findByTitle('socket closed')).toBeTruthy()
  })

  it('surfaces an open failure while staying on the off-state chip', async () => {
    const openCard = vi.fn().mockResolvedValueOnce('session-not-found')
    setup(settingsSnap(true), { card: null, closed: false }, vi.fn(), openCard)
    fireEvent.click(screen.getByRole('button', { name: 'J-Space off, press to turn on' }))
    expect((await screen.findByText('failed to open J-Space')).getAttribute('title')).toBe('session-not-found')
  })

  it('ignores in-flight fulfillment and rejection after unmount', () => {
    let resolve!: (value: string | null) => void
    const successful = setup(
      settingsSnap(true),
      { card: card(), closed: false },
      vi.fn(() => new Promise<string | null>((done) => { resolve = done })),
    )
    fireEvent.click(screen.getByRole('button', { name: 'J-Space on, press to turn off' }))
    successful.view.unmount()
    expect(() => { resolve(null) }).not.toThrow()

    let reject!: (reason: unknown) => void
    const { view } = setup(
      settingsSnap(true),
      { card: null, closed: false },
      vi.fn(),
      vi.fn(() => new Promise<string | null>((_done, fail) => { reject = fail })),
    )
    fireEvent.click(screen.getByRole('button', { name: 'J-Space off, press to turn on' }))
    view.unmount()
    expect(() => { reject(new Error('late')) }).not.toThrow()
  })
})
