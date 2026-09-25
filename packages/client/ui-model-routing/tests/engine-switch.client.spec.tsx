// @vitest-environment jsdom
/**
 * One engine switch reaches every open surface: two sessions' Routing views
 * and Auto chips share the plugin's one engine source, so after the host
 * announces a new selection and the source re-reads it, both status lines
 * name the new judge and both chips ask before turning routing on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { en } from '../src/client/locales.ts'
import { createRoutingEngineSource, type EngineSnapshotResult } from '../src/client/engine-source.ts'
import { RoutingChip, type RoutingChipProps } from '../src/client/RoutingChip.tsx'
import { RoutingView, type RoutingViewProps } from '../src/client/view/RoutingView.tsx'
import { engines } from './fixtures/engines.client.ts'
import { decisionDetail, GATE, liveStats, OFF } from './fixtures/routing-stats.client.ts'

afterEach(cleanup)

const t = makeTranslate(en, commonEn)

describe('an engine switch', () => {
  it('updates both sessions\' status lines and both chips', async () => {
    const read = vi.fn<() => Promise<EngineSnapshotResult>>().mockResolvedValue({ ok: true, value: engines('laya') })
    const source = createRoutingEngineSource(read)
    source.refresh()
    const useRoutingEngine = bindSnapshotSelector(source)
    const surfaces = (id: string) => {
      const values: Record<string, unknown> = { modelRoutingStats: liveStats(), modelRouting: OFF }
      const store = createSnapshotStore({ values })
      const useProjection = (key: string, selector?: (value: unknown) => unknown) =>
        bindSnapshotSelector(store)(s => (selector ?? (value => value))(s.values[key]))
      const shared = { useProjection, useRoutingEngine, loadGate: () => Promise.resolve(GATE), t }
      const view = {
        ...shared,
        useRouterSettings: (selector: (value: { status: string }) => unknown) => selector({ status: 'ready' }),
        useSession: (selector: (value: { openState: string }) => unknown) => selector({ openState: 'open' }),
        available: true,
        loadDecision: () => Promise.resolve(decisionDetail()),
        inspect: null,
      } as unknown as RoutingViewProps
      const setRouting = vi.fn(() => Promise.resolve<string | null>(null))
      const chip = { ...shared, locked: false, available: true, setRouting, restoreStrong: vi.fn() } as unknown as RoutingChipProps
      return {
        setRouting,
        node: (
          <div data-testid={id}>
            <RoutingView {...view} />
            <RoutingChip {...chip} />
          </div>
        ),
      }
    }
    const one = surfaces('one')
    const two = surfaces('two')
    render(<>{one.node}{two.node}</>)
    const line = (id: string) => [...within(screen.getByTestId(id)).getAllByRole('paragraph')]
      .find(node => (node.textContent ?? '').includes('Judge (all sessions):'))!.textContent
    await vi.waitFor(() => { expect(line('one')).toContain('Laya (local, MLX)') })
    expect(line('two')).toContain('Laya (local, MLX)')

    // The host commits another selection and announces it; the source re-reads.
    read.mockResolvedValue({ ok: true, value: engines('typesafe') })
    await act(async () => { source.refresh() })
    await vi.waitFor(() => { expect(line('one')).toContain('Jev (TypeSafe)') })
    expect(line('two')).toContain('Jev (TypeSafe)')
    expect(line('two')).toContain('Remote · egress')

    for (const [id, surface] of [['one', one], ['two', two]] as const) {
      fireEvent.click(within(screen.getByTestId(id)).getByRole('button', { name: 'Automatic model routing off, press to turn on' }))
      expect(screen.getByRole('dialog', { name: en['confirm.title'] })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: en['confirm.cancel'] }))
      expect(surface.setRouting).not.toHaveBeenCalled()
    }
    source.dispose()
  })
})
