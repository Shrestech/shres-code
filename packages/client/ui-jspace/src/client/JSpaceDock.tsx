import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.dock entry).
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
// Type-only: the `jspace` SessionProjectionMap key merge.
import type { JspaceCard } from '@shres-code/shres-code-jspace/client'
// Type-only: the `goal` SessionProjectionMap key merge (dedupe vs GoalBar).
import type {} from '@shres-code/shres-code-goal/client'
import type { JSpaceDockInjected } from './slots.ts'
import { jspaceSettingsEnabled } from './settings.ts'
import css from './JSpaceDock.module.css'

/** Full dock props: InputZone owner share + settings hook + locale. */
export type JSpaceDockProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<JSpaceDockInjected>
  & PropsLocale<'jspace'>

/**
 * Whether the GoalBar already shows this card's Goal line.
 * @param goalObjective - current goal objective, when a non-complete goal exists.
 * @param cardGoal - J-Space Goal line.
 * @returns true when the two sentences are the same and GoalBar would render.
 */
export function goalDuplicatesCard(goalObjective: string | undefined, cardGoal: string): boolean {
  return goalObjective !== undefined && goalObjective === cardGoal
}

/**
 * Last Checked line label, or undefined when the card has none.
 * @param card - open J-Space card.
 * @returns compact `#n check` text.
 */
export function lastCheckedLabel(card: JspaceCard): string | undefined {
  const last = card.checked.at(-1)
  return last === undefined ? undefined : `#${String(last.n)} ${last.check}`
}

/**
 * J-Space strip above the composer. Hidden when Settings is off or no
 * card is open. When GoalBar already shows the same objective, the Goal
 * sentence is omitted and Core / Next / last Checked remain.
 */
export function JSpaceDock({
  useProjection, useJspaceSettings, sessionId, t,
}: JSpaceDockProps) {
  const enabled = jspaceSettingsEnabled(useJspaceSettings(s => s))
  const projection = useProjection('jspace')
  const goal = useProjection('goal')
  if (!enabled) return null
  const card = projection?.card
  if (card == null || card.sessionId !== sessionId) return null

  const goalObjective = goal != null && goal.goal.phase !== 'complete'
    ? goal.goal.objective
    : undefined
  const hideGoal = goalDuplicatesCard(goalObjective, card.goal)
  const checked = lastCheckedLabel(card)

  return (
    <div className={css.dock} data-jspace-dock>
      <div className={css.bar}>
        {!hideGoal && (
          <span className={`${css.field} ${css.fieldGrow}`}>
            <span className={css.label}>{t('dock.goal')}</span>
            <span className={css.value}>{card.goal}</span>
          </span>
        )}
        {hideGoal && card.core.length > 0 && (
          <span className={css.field}>
            <span className={css.label}>{t('dock.core')}</span>
            <span className={css.value}>{card.core.join(' · ')}</span>
          </span>
        )}
        <span className={`${css.field} ${css.fieldGrow}`}>
          <span className={css.label}>{t('dock.next')}</span>
          <span className={css.value}>{card.next}</span>
        </span>
        {hideGoal && checked !== undefined && (
          <span className={css.field}>
            <span className={css.label}>{t('dock.checked')}</span>
            <span className={css.value}>{checked}</span>
          </span>
        )}
      </div>
    </div>
  )
}
