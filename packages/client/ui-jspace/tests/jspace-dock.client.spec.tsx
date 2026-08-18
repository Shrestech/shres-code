// @vitest-environment jsdom
/**
 * JSpaceDock: hidden when Settings is off or the projection card is
 * null; shows Goal and Next; omits a Goal sentence already on GoalBar and
 * keeps Core / Next / last Checked.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { SettingsScopeSnapshot } from '@shres-code/shres-code-client-runtime/client'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type { GoalProjection } from '@shres-code/shres-code-goal/client'
import type { JspaceCard, JspaceProjection } from '@shres-code/shres-code-jspace/client'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { en } from '../src/client/locales.ts'
import type { JSpaceSettings } from '../src/client/settings.ts'
import {
  goalDuplicatesCard, lastCheckedLabel, JSpaceDock, type JSpaceDockProps,
} from '../src/client/JSpaceDock.tsx'

afterEach(cleanup)

const t: JSpaceDockProps['t'] = makeTranslate(en, commonEn)

function card(over: Partial<JspaceCard> = {}): JspaceCard {
  return {
    seq: 1,
    sessionId: 's1',
    goal: 'Ship the redesign',
    core: ['Types', 'Tests'],
    checked: [{ n: 1, check: 'types pass', by: 'tsc covers src' }],
    open: [],
    next: 'Write the dock',
    goalOpenedSeq: 1,
    ...over,
  }
}

function settingsOn(): SettingsScopeSnapshot<JSpaceSettings> {
  return {
    status: 'ready',
    value: { enabled: true },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
  }
}

function settingsOff(): SettingsScopeSnapshot<JSpaceSettings> {
  return { ...settingsOn(), value: { enabled: false } }
}

function goalProjection(objective: string, phase: GoalProjection['goal']['phase'] = 'active'): GoalProjection {
  return {
    goal: {
      id: 'g-1' as GoalProjection['goal']['id'],
      revision: 1,
      objective,
      phase,
      maxGoalRounds: 8,
    },
    roundsStarted: 1,
    createdAt: 10,
    updatedAt: 20,
  }
}

function setup(
  settings: SettingsScopeSnapshot<JSpaceSettings>,
  jspace: JspaceProjection | undefined,
  goal: GoalProjection | null | undefined = undefined,
) {
  const settingsStore = createSnapshotStore(settings)
  const useJspaceSettings = bindSnapshotSelector(settingsStore)
  const useProjection = (key: string) => {
    if (key === 'jspace') return jspace
    if (key === 'goal') return goal
    return undefined
  }
  const props = { useProjection, useJspaceSettings, sessionId: 's1', t } as unknown as JSpaceDockProps
  return render(<JSpaceDock {...props} />)
}

describe('JSpaceDock', () => {
  it('renders nothing when Settings is off or no card is open', () => {
    const off = setup(settingsOff(), { card: card(), closed: false })
    expect(off.container.firstChild).toBeNull()
    cleanup()
    const empty = setup(settingsOn(), { card: null, closed: false })
    expect(empty.container.firstChild).toBeNull()
    cleanup()
    const absent = setup(settingsOn(), undefined)
    expect(absent.container.firstChild).toBeNull()
    cleanup()
    const inherited = setup(settingsOn(), { card: card({ sessionId: 'parent' }), closed: false })
    expect(inherited.container.firstChild).toBeNull()
  })

  it('shows Goal and Next when GoalBar is not showing the same sentence', () => {
    setup(settingsOn(), { card: card(), closed: false })
    expect(screen.getByText('Goal')).toBeTruthy()
    expect(screen.getByText('Ship the redesign')).toBeTruthy()
    expect(screen.getByText('Next')).toBeTruthy()
    expect(screen.getByText('Write the dock')).toBeTruthy()
    expect(screen.queryByText('Core')).toBeNull()
    expect(screen.queryByText('Checked')).toBeNull()
  })

  it('omits a duplicated Goal and shows Core / Next / last Checked', () => {
    setup(
      settingsOn(),
      { card: card(), closed: false },
      goalProjection('Ship the redesign'),
    )
    expect(screen.queryByText('Goal')).toBeNull()
    expect(screen.getByText('Core')).toBeTruthy()
    expect(screen.getByText('Types · Tests')).toBeTruthy()
    expect(screen.getByText('Next')).toBeTruthy()
    expect(screen.getByText('Checked')).toBeTruthy()
    expect(screen.getByText('#1 types pass')).toBeTruthy()
  })

  it('omits empty Core and Checked when Goal is already on GoalBar', () => {
    setup(
      settingsOn(),
      { card: card({ core: [], checked: [] }), closed: false },
      goalProjection('Ship the redesign'),
    )
    expect(screen.queryByText('Goal')).toBeNull()
    expect(screen.queryByText('Core')).toBeNull()
    expect(screen.queryByText('Checked')).toBeNull()
    expect(screen.getByText('Next')).toBeTruthy()
  })

  it('still shows Goal when the live goal is complete or a different sentence', () => {
    setup(
      settingsOn(),
      { card: card(), closed: false },
      goalProjection('Ship the redesign', 'complete'),
    )
    expect(screen.getByText('Goal')).toBeTruthy()
    cleanup()
    setup(
      settingsOn(),
      { card: card(), closed: false },
      goalProjection('A different objective'),
    )
    expect(screen.getByText('Goal')).toBeTruthy()
    expect(screen.getByText('Ship the redesign')).toBeTruthy()
  })
})

describe('jspace dock helpers', () => {
  it('treats only an identical live objective as a GoalBar duplicate', () => {
    expect(goalDuplicatesCard(undefined, 'Ship')).toBe(false)
    expect(goalDuplicatesCard('Other', 'Ship')).toBe(false)
    expect(goalDuplicatesCard('Ship', 'Ship')).toBe(true)
  })

  it('formats the last Checked line and skips an empty list', () => {
    expect(lastCheckedLabel(card({ checked: [] }))).toBeUndefined()
    expect(lastCheckedLabel(card())).toBe('#1 types pass')
  })
})
