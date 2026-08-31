/**
 * Connected badge: the strip above the remote rows listing every alias whose
 * GUI-owned tunnel is open, with the new-tab hand-off and the disconnect
 * control. Pure props; the section derives the open set from the view store.
 */
import { Button } from '@shres-code/shres-code-client-ui-primitives'
import type { Translate } from '@shres-code/shres-code-client-ui-slots'
import css from './ConnectedBadge.module.css'
import type { RemoteKey } from './locales.ts'

/** One open tunnel the badge renders. */
export interface ConnectedTunnel {
  /** Registry alias. */
  alias: string
  /** `user@host` target shown beside the alias. */
  target: string
  /** Local loopback port the tunneled origin serves on. */
  localPort: number
}

/** Badge props. */
export type ConnectedBadgeProps = {
  /** Open tunnels, registry order. */
  open: readonly ConnectedTunnel[]
  /** Namespace translate seat. */
  t: Translate<RemoteKey>
  /** Open the tunneled origin in a new tab. */
  onOpen: (localPort: number) => void
  /** Tear one alias's tunnel down. */
  onDisconnect: (alias: string) => void
}

/**
 * Render the connected strip.
 * @param props - open tunnels plus the two actions.
 * @returns the badge element, or null when nothing is open.
 */
export function ConnectedBadge({ open, t, onOpen, onDisconnect }: ConnectedBadgeProps) {
  if (open.length === 0) return null
  return (
    <div className={css.badges} role="list" aria-label={t('badge.aria')}>
      {open.map(tunnel => (
        <div key={tunnel.alias} role="listitem" className={css.badge}>
          <span className={css.label} title={t('status.open')}>
            <span className={css.arrow} aria-hidden="true">⟶</span>
            {tunnel.alias}
            <span className={css.target}>{tunnel.target}</span>
          </span>
          <span className={css.actions}>
            <Button size="sm" aria-label={t('badge.openTab')} onClick={() => { onOpen(tunnel.localPort) }}>
              {t('badge.openTab')}
            </Button>
            <Button size="sm" aria-label={t('badge.disconnect')} onClick={() => { onDisconnect(tunnel.alias) }}>
              {t('badge.disconnect')}
            </Button>
          </span>
        </div>
      ))}
    </div>
  )
}
