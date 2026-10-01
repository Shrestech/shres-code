// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { ThresholdsCard } from '../src/client/ThresholdsCard.tsx'
import type { ModelRoutingState } from '../src/client/model.ts'
import { en } from '../src/client/locales.ts'
import { GATE, TYPESAFE, snapshot } from './fixtures.client.ts'
import { ready, t } from './helpers.client.tsx'

afterEach(cleanup)

/** Mount the thresholds card over one page state. */
function mount(overrides: Partial<ModelRoutingState> = {}): void {
  render(<ThresholdsCard state={ready(overrides)} t={t as never} />)
}

describe('the read-only thresholds card', () => {
  it('renders nothing until the router gate is read', () => {
    const { container } = render(<ThresholdsCard state={ready({ gate: null })} t={t as never} />)
    expect(container.textContent).toBe('')
  })

  it('shows the global floors, difficulty band, deadline, hold, and state cap as read-only values', () => {
    mount()
    expect(screen.getByText(en.thresholdsTitle)).toBeTruthy()
    const tile = (label: string): string => screen.getByText(label).nextElementSibling?.textContent ?? ''
    expect(tile(en.thresholdConfidence)).toBe('0.80')
    expect(tile(en.thresholdMargin)).toBe('0.10')
    expect(tile(en.thresholdDifficulty)).toBe('2 / 3')
    expect(tile(en.thresholdDeadline)).toBe('1,500 ms')
    expect(tile(en.thresholdHold)).toBe('20 / 40')
    expect(tile(en.thresholdStateCap)).toBe('12,000 characters')
    // Read-only: no control in the card changes anything.
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('badges each engine the gate lists and shows its operating point over the global floors', () => {
    mount({
      gate: {
        ...GATE,
        operatingPoints: [{ engine: 'laya', downgradeThreshold: 0.7, downgradeMargin: 0.2, calibratedBy: 'routing-eval-2026-09', acceptVerbalized: false }],
        engines: [
          { engine: 'typesafe', calibration: { kind: 'global' } },
          { engine: 'laya', calibration: { kind: 'calibrated', by: 'routing-eval-2026-09' } },
        ],
      },
    })
    const table = screen.getByRole('table', { name: en.operatingPointsTitle })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(within(rows[1]!).getByText('Jev (TypeSafe)')).toBeTruthy()
    expect(within(rows[1]!).getByText('0.80 / 0.10 (global)')).toBeTruthy()
    expect(within(rows[1]!).getByText(en.uncalibratedGlobal).getAttribute('title')).toBe(en.uncalibratedGlobalTitle)
    expect(within(rows[2]!).getByText('Laya (local MLX)')).toBeTruthy()
    expect(within(rows[2]!).getByText('0.70 / 0.20')).toBeTruthy()
    expect(within(rows[2]!).getByText('Calibrated (routing-eval-2026-09)').getAttribute('title'))
      .toBe(t('calibratedTitle', { by: 'routing-eval-2026-09' }))
  })

  it('badges the card head with how the router gates the engine it asks', () => {
    mount()
    // Both listed engines are uncalibrated, and the routed engine repeats its badge in the head.
    expect(screen.getAllByText(en.uncalibratedGlobal)).toHaveLength(3)

    // A router override retargets the head badge to the overridden engine.
    cleanup()
    mount({
      engines: snapshot([TYPESAFE], 'typesafe', { overrides: { 'model-router': 'laya' } }),
      gate: { ...GATE, engines: [{ engine: 'laya', calibration: { kind: 'calibrated', by: 'routing-eval-2026-09' } }] },
    })
    // The head badge and the laya row agree; no uncalibrated badge remains.
    expect(screen.getAllByText('Calibrated (routing-eval-2026-09)')).toHaveLength(2)
    expect(screen.queryByText(en.uncalibratedGlobal)).toBeNull()
  })

  it('shows an uncalibrated operating point as such, and omits the table when the gate lists no engine', () => {
    mount({
      gate: {
        ...GATE,
        operatingPoints: [{ engine: 'typesafe', downgradeThreshold: 0.75, downgradeMargin: 0.15, acceptVerbalized: false }],
        engines: [{ engine: 'typesafe', calibration: { kind: 'point' } }],
      },
    })
    expect(screen.getAllByText(en.uncalibratedPoint)[0]?.getAttribute('title')).toBe(en.uncalibratedPointTitle)
    expect(screen.getByText('0.75 / 0.15')).toBeTruthy()
    expect(screen.queryByText('Calibrated')).toBeNull()

    cleanup()
    mount({ gate: { ...GATE, engines: [] } })
    expect(screen.queryByRole('table')).toBeNull()
  })
})
