/**
 * Game mode switch beside the sidebar wordmark. Writes the `game` settings
 * namespace; the Goal fight arena reads the same document.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import type { GameModeToggleInjected } from './slots.ts'
import { gameSettingsEnabled } from './game-settings.ts'
import css from './GameModeToggle.module.css'

/** Full props of the brand-row switch. */
export type GameModeToggleProps =
  PropsRuntime<'sidebar.brand.action'>
  & InjectFace<GameModeToggleInjected>
  & PropsLocale<'goal'>

/**
 * Render the Game mode switch.
 * @param props - settings hook, column state, and copy.
 * @returns the labeled switch, or null on the collapsed rail.
 */
export function GameModeToggle({ wide, useGameSettings, setEnabled, t }: GameModeToggleProps) {
  if (!wide) return null
  const settings = useGameSettings(current => current)
  const enabled = gameSettingsEnabled(settings)
  const disabled = settings.status !== 'ready' || !settings.writable
  return (
    <div className={css.wrap} data-game-mode={enabled ? 'on' : 'off'}>
      <span className={css.label}>{t('game.mode')}</span>
      <button
        type="button"
        className={css.switch}
        role="switch"
        aria-checked={enabled}
        aria-label={enabled ? t('game.off') : t('game.on')}
        disabled={disabled}
        onClick={() => { void setEnabled(!enabled) }}
      >
        <span className={css.thumb} />
      </button>
    </div>
  )
}
