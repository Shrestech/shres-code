/**
 * Game mode switch in the composer tool row, beside J-Space. Writes the
 * `game` settings namespace; the Goal fight arena reads the same document.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
import type { GameModeToggleInjected } from './slots.ts'
import { gameSettingsEnabled } from './game-settings.ts'
import css from './GameModeToggle.module.css'

/** Full props of the composer-row switch. */
export type GameModeToggleProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<GameModeToggleInjected>
  & PropsLocale<'goal'>

/**
 * Render the Game mode switch.
 * @param props - settings hook and copy.
 * @returns the labeled switch.
 */
export function GameModeToggle({ useGameSettings, setEnabled, t }: GameModeToggleProps) {
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
