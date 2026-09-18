// @vitest-environment jsdom
/**
 * RoutingChip over the `modelRouting` projection: nothing renders while the
 * capability is absent or the session is an addressed subagent; the off state
 * executes /route on, the on state reads the last decision and the held streak
 * and executes /route off, a flip in flight stays visible, and a command
 * failure surfaces as the inline error line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type { ModelRoutingProjection } from '@shres-code/shres-code-model-router/client'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { RoutingChip, type RoutingChipProps } from '../src/client/RoutingChip.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

// The framework-injected t seat, stubbed over the shipped dictionaries.
const t = makeTranslate(en, commonEn)

const CHEAP = { candidateId: 'cheap', provider: 'deepseek', model: 'deepseek-v4-flash' }

/** The off mode: the projection exists but no mode event has turned routing on. */
const OFF: ModelRoutingProjection = { active: false, pending: false }

/** An on-mode projection holding one downgraded decision and the streak it entered. */
function running(overrides: Partial<ModelRoutingProjection> = {}): ModelRoutingProjection {
  return {
    active: true,
    pending: false,
    last: { outcome: 'downgraded', reason: 'gate-passed', selection: CHEAP, confidence: 0.9111 },
    sticky: { active: true, turnsElapsed: 3, selection: CHEAP },
    ...overrides,
  }
}

function setup(options: {
  routing?: ModelRoutingProjection
  setRouting?: RoutingChipProps['setRouting']
  locked?: boolean
  available?: boolean
} = {}) {
  const store = createSnapshotStore<{ value: ModelRoutingProjection | undefined }>({ value: options.routing })
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  const setRouting = options.setRouting ?? vi.fn(() => Promise.resolve<string | null>(null))
  const props = {
    useProjection,
    locked: options.locked ?? false,
    available: options.available ?? true,
    setRouting,
    t,
  } as unknown as RoutingChipProps
  return {
    setRouting,
    // The host republishes the projection; the chip follows it.
    publish: (value: ModelRoutingProjection | undefined) => { store.set({ value }) },
    view: render(<RoutingChip {...props} />),
  }
}

const offChip = () => screen.getByRole('button', { name: 'Automatic model routing off, press to turn on' })
const onChip = () => screen.getByRole('button', { name: 'Automatic model routing on, press to turn off' })

describe('RoutingChip', () => {
  it('renders nothing while the host composes no routing projection', () => {
    const { view } = setup()
    expect(view.container.innerHTML).toBe('')
  })

  it('renders nothing for an addressed subagent session', () => {
    const { view } = setup({ routing: running(), available: false })
    expect(view.container.innerHTML).toBe('')
  })

  it('offers the Auto affordance, executes /route on, and follows the projection', async () => {
    const setRouting = vi.fn(() => Promise.resolve<string | null>(null))
    const { publish } = setup({ routing: OFF, setRouting })
    expect(offChip().textContent).toBe('Auto')

    fireEvent.click(offChip())
    expect(setRouting).toHaveBeenCalledWith(true)
    await waitFor(() => { expect((offChip() as HTMLButtonElement).disabled).toBe(false) })

    publish(running())
    await waitFor(() => { expect(onChip().textContent).toContain('auto → deepseek-v4-flash (0.91)') })
  })

  it('reads the routed selection, its confidence, and the held streak, and executes /route off', () => {
    const setRouting = vi.fn(() => Promise.resolve<string | null>(null))
    setup({ routing: running(), setRouting })
    expect(onChip().textContent).toBe('auto → deepseek-v4-flash (0.91)')
    expect(screen.getByText('turn 3')).toBeTruthy()

    fireEvent.click(onChip())
    expect(setRouting).toHaveBeenCalledWith(false)
  })

  it('renders the hint line when the last decision carries one', () => {
    // A kept-strong decision carries no selection while the manual route stands,
    // and the log holds no held streak for it yet.
    setup({
      routing: {
        active: true,
        pending: false,
        last: { outcome: 'kept-strong', reason: 'low-confidence', hint: 'consider-stronger', confidence: 0.42 },
      },
    })
    expect(onChip().textContent).toBe('auto')
    expect(screen.getByText('consider a stronger model')).toBeTruthy()
  })

  it('renders the on mode with no decision and no held streak yet', () => {
    setup({ routing: { active: true, pending: false, sticky: { active: false, turnsElapsed: 0 } } })
    expect(onChip().textContent).toBe('auto')
    expect(screen.queryByText('turn 0')).toBeNull()
    expect(screen.queryByText('consider a stronger model')).toBeNull()
  })

  it('renders the selection alone when the last decision carries no confidence', () => {
    setup({ routing: running({ last: { outcome: 'downgraded', reason: 'gate-passed', selection: CHEAP } }) })
    expect(onChip().textContent).toBe('auto → deepseek-v4-flash')
  })

  it('keeps a flip in flight visible and disabled until the command settles', async () => {
    let settle!: (value: string | null) => void
    const setRouting = vi.fn(() => new Promise<string | null>((done) => { settle = done }))
    setup({ routing: OFF, setRouting })

    fireEvent.click(offChip())
    expect((offChip() as HTMLButtonElement).disabled).toBe(true)
    expect(offChip().getAttribute('aria-busy')).toBe('true')
    fireEvent.click(offChip())
    expect(setRouting).toHaveBeenCalledTimes(1)

    settle(null)
    await waitFor(() => { expect(offChip().getAttribute('aria-busy')).toBe('false') })
  })

  it('surfaces command failures and transport faults as the inline error line', async () => {
    const setRouting = vi.fn()
      .mockResolvedValueOnce('gone (session-not-found)')
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce('socket closed')
    setup({ routing: OFF, setRouting })

    fireEvent.click(offChip())
    expect((await screen.findByText('failed to switch model routing')).getAttribute('title')).toBe('gone (session-not-found)')
    expect(offChip()).toBeTruthy()

    fireEvent.click(offChip())
    expect(await screen.findByTitle('network down')).toBeTruthy()

    fireEvent.click(offChip())
    expect(await screen.findByTitle('socket closed')).toBeTruthy()
  })

  it('disables under the locked owner prop', () => {
    setup({ routing: OFF, locked: true })
    expect((offChip() as HTMLButtonElement).disabled).toBe(true)
  })

  it('ignores in-flight fulfillment and rejection after unmount', () => {
    let resolve!: (value: string | null) => void
    const settling = setup({
      routing: OFF,
      setRouting: vi.fn(() => new Promise<string | null>((done) => { resolve = done })),
    })
    fireEvent.click(offChip())
    settling.view.unmount()
    expect(() => { resolve(null) }).not.toThrow()

    let reject!: (reason: unknown) => void
    const failing = setup({
      routing: OFF,
      setRouting: vi.fn(() => new Promise<string | null>((_done, fail) => { reject = fail })),
    })
    fireEvent.click(offChip())
    failing.view.unmount()
    expect(() => { reject(new Error('late')) }).not.toThrow()
  })
})
