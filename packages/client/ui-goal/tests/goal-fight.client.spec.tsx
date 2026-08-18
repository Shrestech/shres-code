// @vitest-environment jsdom
// GoalFight plays a lunge/slash/scatter when a remaining unit leaves the list.

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIGHT_FOLLOW_MS, FIGHT_LUNGE_MS, FIGHT_SLASH_MS, GoalFight } from '../src/client/GoalFight.tsx'
import type { FightUnit } from '../src/client/units.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})

const two: FightUnit[] = [
  { id: 'a#0', kind: 'zombie' },
  { id: 'b#0', kind: 'zombie-2' },
]

describe('GoalFight', () => {
  it('draws the girl and each remaining unit', () => {
    const { container } = render(<GoalFight units={two} frozen={false} createdAt={undefined} />)
    expect(container.querySelector('[data-goal-fight]')).toBeTruthy()
    expect(container.querySelector('[data-pose="idle"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-unit]')).toHaveLength(2)
    expect(container.querySelector('.clock, [class*="clock"]')).toBeNull()
  })

  it('shows elapsed time from createdAt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T12:00:30Z'))
    const { container } = render(
      <GoalFight units={[]} frozen={false} createdAt={Date.parse('2026-08-18T12:00:00Z')} />,
    )
    expect(container.textContent).toContain('0:30')
  })

  it('lunges, slashes, and drops a unit that left the list', async () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<GoalFight units={two} frozen={false} createdAt={undefined} />)
    rerender(<GoalFight units={[two[1]!]} frozen={false} createdAt={undefined} />)

    await act(async () => { await vi.advanceTimersByTimeAsync(FIGHT_LUNGE_MS) })
    expect(container.querySelector('[data-pose="slash"], [data-pose="lunge"]')).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(FIGHT_SLASH_MS) })
    expect(container.querySelector('[data-life="scatter"]')).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(FIGHT_FOLLOW_MS) })
    expect(container.querySelector('[data-unit="a#0"]')).toBeNull()
    expect(container.querySelector('[data-unit="b#0"]')).toBeTruthy()
    expect(container.querySelector('[data-pose="idle"]')).toBeTruthy()
  })

  it('drops missing units immediately when frozen', () => {
    const { container, rerender } = render(<GoalFight units={two} frozen={true} createdAt={undefined} />)
    rerender(<GoalFight units={[]} frozen={true} createdAt={undefined} />)
    expect(container.querySelectorAll('[data-unit]')).toHaveLength(0)
  })

  it('drops missing units immediately when reduced motion is requested', () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    } as MediaQueryList)
    const { container, rerender } = render(<GoalFight units={two} frozen={false} createdAt={undefined} />)
    rerender(<GoalFight units={[]} frozen={false} createdAt={undefined} />)
    expect(container.querySelectorAll('[data-unit]')).toHaveLength(0)
  })

  it('clears the clock when createdAt disappears', () => {
    const { container, rerender } = render(
      <GoalFight units={[]} frozen={false} createdAt={1} />,
    )
    expect(container.textContent).toMatch(/\d+:\d{2}/)
    rerender(<GoalFight units={[]} frozen={false} createdAt={undefined} />)
    expect(container.textContent).not.toMatch(/\d+:\d{2}/)
  })

  it('appends newly remaining units without dropping the living ones', () => {
    const { container, rerender } = render(<GoalFight units={[two[0]!]} frozen={false} createdAt={undefined} />)
    rerender(<GoalFight units={two} frozen={false} createdAt={undefined} />)
    expect(container.querySelectorAll('[data-unit]')).toHaveLength(2)
  })
})
