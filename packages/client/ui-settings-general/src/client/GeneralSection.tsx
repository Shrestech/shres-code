/** Numbered preference groups assembled from feature-owned rows. */
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import css from './GeneralSection.module.css'

/** Live preference identities, preserving extension rows in the final group. */
export interface GeneralSectionInjected {
  hooks: { items: HostObservable<readonly string[]> }
}

/** Section selection, contributed items, and the shell's group labels. */
export type GeneralSectionComponentProps = PropsRuntime<'settings.section'>
  & PropsRenderSlots<'settings.general.item'> & PropsLocale<'settings'> & InjectFace<GeneralSectionInjected>

const GROUPS = [
  { id: 'defaults', items: ['agent-preset', 'permission'] },
  { id: 'interaction', items: ['composer-enter', 'language'] },
  { id: 'appearance', items: ['appearance'] },
] as const

/**
 * Render grouped preferences or one focused preference selected in navigation.
 * @param props - Registered row identities, optional focused item, rendering and locale shares.
 * @returns The preference groups.
 */
export function GeneralSection({ renderSlot, useItems, item, t }: GeneralSectionComponentProps) {
  const items = useItems(s => s)
  const known = new Set<string>(GROUPS.flatMap(group => [...group.items]))
  const groups = [
    ...GROUPS.map(group => ({ id: group.id, items: group.items.filter(id => items.includes(id)) })),
    { id: 'more' as const, items: items.filter(id => !known.has(id)) },
  ].filter(group => group.items.length > 0)
  if (item !== undefined) return <div className={css.focused}>{renderSlot('settings.general.item', {}, { only: item })}</div>
  return <div className={css.section}>
    {groups.map((group, index) => <section className={css.group} key={group.id} aria-label={t(`group.${group.id}`)}>
      <div className={css.caption}>
        <span className={css.number}>{String(index + 1).padStart(2, '0')}</span>
        <h2>{t(`group.${group.id}`)}</h2>
        <p>{t(`group.${group.id}.description`)}</p>
      </div>
      <div className={css.rows}>
        {group.items.map(id => <div className={css.item} key={id}>{renderSlot('settings.general.item', {}, { only: id })}</div>)}
      </div>
    </section>)}
  </div>
}
