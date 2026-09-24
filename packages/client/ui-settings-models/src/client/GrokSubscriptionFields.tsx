/** Subscription requirements and opt-in sharing of Grok's hosted X operations. */
import type { ReactNode } from 'react'
import { getPath } from '@shres-code/shres-code-client-schema-form'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Fields owned by the Grok subscription settings section. */
type GrokSwitch = 'hostedWebSearch' | 'hostedXSearch' | 'agentXTools'

/** Read-only projection and staged edits supplied by the provider editor. */
export interface GrokSubscriptionFieldsProps {
  draft: Record<string, unknown>
  inherited: unknown
  disabled: boolean
  credentialOnly: boolean
  t: (key: keyof typeof en) => string
  onChange: (field: GrokSwitch, value: boolean) => void
}

/**
 * Show subscription requirements without probing credentials or entitlement.
 * @param props - Resolved settings, staged edits, and localized copy.
 * @returns The Grok access notice, controls, and described X tools.
 */
export function GrokSubscriptionFields(props: GrokSubscriptionFieldsProps): ReactNode {
  const { t } = props
  const value = (field: GrokSwitch | 'enabled'): boolean =>
    (getPath(props.draft, [field]) ?? getPath(props.inherited, [field])) === true
  const canShare = value('enabled') && value('hostedXSearch')
  return (
    <section className={styles['hostedTools']} aria-label={t('grokToolsSection')}>
      <p className={styles['advancedHint']}>{t('grokSubscriptionAccess')}</p>
      {props.credentialOnly ? null : (
        <>
          <div className={styles['hostedTools']}>
            {([
              ['hostedWebSearch', 'grokHostedWebSearch', 'grokHostedWebDescription'],
              ['hostedXSearch', 'grokHostedXSearch', 'grokHostedXDescription'],
              ['agentXTools', 'grokShareXTools', 'grokShareXDescription'],
            ] as const).map(([field, label, description]) => {
              const shared = field === 'agentXTools'
              const checked = value(field) && (!shared || canShare)
              return (
                <div key={field}>
                  <div className={styles['hostedToolRow']}>
                    <span className={styles['fieldLabel']}>{t(label)}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-label={t(label)}
                      aria-checked={checked}
                      className={[styles['rowSwitch'], styles[checked ? 'rowSwitchOn' : 'rowSwitchOff']].join(' ')}
                      disabled={props.disabled || (shared && !canShare)}
                      onClick={() => { props.onChange(field, !checked) }}
                    >
                      <span className={styles['rowSwitchThumb']} />
                    </button>
                  </div>
                  <p className={styles['advancedHint']}>{t(description)}</p>
                </div>
              )
            })}
          </div>
          {!canShare && <p className={styles['advancedHint']}>{t('grokShareXPrerequisite')}</p>}
          <dl className={styles['grokToolDescriptions']}>
            {([
              ['x_keyword_search', 'grokKeywordDescription'],
              ['x_semantic_search', 'grokSemanticDescription'],
              ['x_user_search', 'grokUserDescription'],
              ['x_thread_fetch', 'grokThreadDescription'],
            ] as const).map(([name, description]) => (
              <div key={name}>
                <dt><code>{name}</code></dt>
                <dd>{t(description)}</dd>
              </div>
            ))}
          </dl>
          <p className={styles['advancedHint']}>{t('grokShareXQuota')}</p>
        </>
      )}
    </section>
  )
}
