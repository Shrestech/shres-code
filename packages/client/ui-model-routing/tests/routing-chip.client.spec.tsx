// @vitest-environment jsdom
/**
 * RoutingChip over the `modelRouting` projection: nothing renders while the
 * capability is absent or the session is an addressed subagent; the chip states
 * the routing mode alone and names no routed model, no confidence, no streak
 * position, and no model hint at the chat surface; the off state executes
 * /route on and the on state executes /route off; a routing-idle session reports
 * the idle state and restores the last strong entry base through the
 * model-selection face; a gesture in flight stays visible, and each failure
 * surfaces as its own inline error line.
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

/** The route the last streak was entered on: the restore target, never chip copy. */
const STRONG = { provider: 'deepseek', model: 'deepseek-v4.1' }

/** The off mode: the projection exists but no mode event has turned routing on. */
const OFF: ModelRoutingProjection = { active: false, pending: false }

/** An on-mode projection holding one downgraded decision and the streak it entered. */
function running(overrides: Partial<ModelRoutingProjection> = {}): ModelRoutingProjection {
  return {
    active: true,
    pending: false,
    last: { outcome: 'downgraded', reason: 'gate-passed', selection: CHEAP, confidence: 0.9111 },
    sticky: { active: true, stepsElapsed: 3, selection: CHEAP },
    ...overrides,
  }
}

/**
 * The routing-idle dead end: routing is on, every decision resolves the
 * candidate the session already runs, and the last streak's entry route is the
 * only route a restore can point the selection back at.
 */
function idle(overrides: Partial<ModelRoutingProjection> = {}): ModelRoutingProjection {
  return {
    active: true,
    pending: false,
    last: { outcome: 'kept-strong', reason: 'candidate-equals-base', confidence: 0.93 },
    lastStrong: STRONG,
    ...overrides,
  }
}

/**
 * The same idle dead end on a session that never entered a downgraded streak:
 * the projection carries no entry base, so there is no route to restore.
 */
const IDLE_WITHOUT_BASE: ModelRoutingProjection = {
  active: true,
  pending: false,
  last: { outcome: 'kept-strong', reason: 'candidate-equals-base', confidence: 0.93 },
}

function setup(options: {
  routing?: ModelRoutingProjection
  setRouting?: RoutingChipProps['setRouting']
  restoreStrong?: RoutingChipProps['restoreStrong']
  locked?: boolean
  available?: boolean
  reveal?: RoutingChipProps['reveal']
} = {}) {
  const store = createSnapshotStore<{ value: ModelRoutingProjection | undefined }>({ value: options.routing })
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  const setRouting = options.setRouting ?? vi.fn(() => Promise.resolve<string | null>(null))
  const restoreStrong = options.restoreStrong ?? vi.fn(() => Promise.resolve<string | null>(null))
  const props = {
    useProjection,
    locked: options.locked ?? false,
    reveal: options.reveal,
    available: options.available ?? true,
    setRouting,
    restoreStrong,
    t,
  } as unknown as RoutingChipProps
  return {
    setRouting,
    restoreStrong,
    // The host republishes the projection; the chip follows it.
    publish: (value: ModelRoutingProjection | undefined) => { store.set({ value }) },
    view: render(<RoutingChip {...props} />),
  }
}

const offChip = () => screen.getByRole('button', { name: 'Automatic model routing off, press to turn on' })
const onChip = () => screen.getByRole('button', { name: 'Automatic model routing on, press to turn off' })
const restoreChip = () => screen.getByRole('button', { name: en['idle.restore.title'] })
const idleWarning = () => screen.getByText(en['idle.warning'])

describe('RoutingChip', () => {
  it('opens this session\'s Routing view from Routing details, even while locked', () => {
    const reveal = vi.fn()
    setup({ routing: OFF, reveal, locked: true })
    fireEvent.click(screen.getByRole('button', { name: en['chip.details'] }))
    expect(reveal).toHaveBeenCalledWith({ view: 'routing', target: { kind: 'none' } })
  })

  it('offers no Routing details without the session\'s reveal', () => {
    setup({ routing: OFF })
    expect(screen.queryByRole('button', { name: en['chip.details'] })).toBeNull()
  })

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
    const { view, publish } = setup({ routing: OFF, setRouting })
    expect(offChip().textContent).toBe('Auto')

    fireEvent.click(offChip())
    expect(setRouting).toHaveBeenCalledWith(true)
    await waitFor(() => { expect((offChip() as HTMLButtonElement).disabled).toBe(false) })

    publish(running())
    await waitFor(() => { expect(onChip().textContent).toBe('auto') })
    // The routed route stays out of the chat surface: the mode wordmark is all
    // the on state renders.
    expect(view.container.textContent).toBe('auto')
  })

  it('names no routed model, no confidence, and no streak position while executing /route off', () => {
    const setRouting = vi.fn(() => Promise.resolve<string | null>(null))
    const { view } = setup({ routing: running(), setRouting })

    expect(onChip().textContent).toBe('auto')
    expect(view.container.textContent).not.toContain(CHEAP.model)
    expect(view.container.textContent).not.toContain('0.91')
    expect(view.container.textContent).not.toContain('turn 3')
    expect(screen.queryByText('turn 3')).toBeNull()

    fireEvent.click(onChip())
    expect(setRouting).toHaveBeenCalledWith(false)
  })

  it('renders no hint line for a kept-strong decision that carries one', () => {
    // A kept-strong decision carries no selection while the manual route stands,
    // and the log holds no held streak for it yet.
    const { view } = setup({
      routing: {
        active: true,
        pending: false,
        last: { outcome: 'kept-strong', reason: 'low-confidence', hint: 'consider-stronger', confidence: 0.42 },
      },
    })

    expect(onChip().textContent).toBe('auto')
    expect(view.container.textContent).not.toContain('consider a stronger model')
    expect(screen.queryByText('consider a stronger model')).toBeNull()
  })

  it('names no routed model for a decision whose selection carries no confidence', () => {
    const { view } = setup({ routing: running({ last: { outcome: 'downgraded', reason: 'gate-passed', selection: CHEAP } }) })

    expect(onChip().textContent).toBe('auto')
    expect(view.container.textContent).not.toContain(CHEAP.model)
    expect(view.container.textContent).not.toContain(CHEAP.candidateId)
  })

  it('renders the on mode with no decision and no held streak yet as the mode alone', () => {
    const { view } = setup({ routing: { active: true, pending: false, sticky: { active: false, stepsElapsed: 0 } } })

    expect(onChip().textContent).toBe('auto')
    expect(view.container.textContent).toBe('auto')
    expect(screen.queryByText('turn 0')).toBeNull()
  })

  it('reports the idle state and offers the restore of the last strong route', () => {
    const { view } = setup({ routing: idle() })

    expect(idleWarning()).toBeTruthy()
    expect(restoreChip()).toBeTruthy()
    // Neither the warning nor the restore control names a routed model.
    expect(view.container.textContent).not.toContain(CHEAP.model)
    expect(view.container.textContent).not.toContain(STRONG.model)
  })

  it('reports the unlisted-base idle state with its own warning and the restore', () => {
    setup({ routing: idle({ last: { outcome: 'kept-strong', reason: 'base-unlisted' } }) })

    expect(screen.getByText(en['idle.unlisted'])).toBeTruthy()
    expect(screen.queryByText(en['idle.warning'])).toBeNull()
    expect(restoreChip()).toBeTruthy()
  })

  it('reports the idle state without a restore while no streak has recorded a route', () => {
    setup({ routing: IDLE_WITHOUT_BASE })

    expect(idleWarning()).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['idle.restore.title'] })).toBeNull()
  })

  it('restores the last strong entry base through the model-selection face', async () => {
    const restoreStrong = vi.fn(() => Promise.resolve<string | null>(null))
    setup({ routing: idle(), restoreStrong })

    fireEvent.click(restoreChip())
    expect(restoreStrong).toHaveBeenCalledWith(STRONG)
    await waitFor(() => { expect(restoreChip().getAttribute('aria-busy')).toBe('false') })
    expect(screen.queryByText('failed to restore the strong model')).toBeNull()
    // The gesture is a selection, not a mode switch.
    expect(idleWarning()).toBeTruthy()
  })

  it('surfaces a refused restore as its own inline error line while the chip stays', async () => {
    const restoreStrong = vi.fn()
      .mockResolvedValueOnce('session.selectModel failed: model-unavailable: this route does not serve chat turns')
      .mockRejectedValueOnce(new Error('network down'))
    setup({ routing: idle(), restoreStrong })

    fireEvent.click(restoreChip())
    const refused = await screen.findByText('failed to restore the strong model')
    expect(refused.getAttribute('title')).toBe('session.selectModel failed: model-unavailable: this route does not serve chat turns')
    expect(idleWarning()).toBeTruthy()

    fireEvent.click(restoreChip())
    expect(await screen.findByTitle('network down')).toBeTruthy()
    expect(onChip()).toBeTruthy()
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

  it('disables the restore while a mode flip is in flight', () => {
    let settle!: (value: string | null) => void
    setup({ routing: idle(), setRouting: vi.fn(() => new Promise<string | null>((done) => { settle = done })) })

    fireEvent.click(onChip())
    expect((restoreChip() as HTMLButtonElement).disabled).toBe(true)
    settle(null)
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

  it('disables both controls under the locked owner prop while routing is idle', () => {
    setup({ routing: idle(), locked: true })
    expect((onChip() as HTMLButtonElement).disabled).toBe(true)
    expect((restoreChip() as HTMLButtonElement).disabled).toBe(true)
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
      routing: idle(),
      restoreStrong: vi.fn(() => new Promise<string | null>((_done, fail) => { reject = fail })),
    })
    fireEvent.click(restoreChip())
    failing.view.unmount()
    expect(() => { reject(new Error('late')) }).not.toThrow()
  })
})
