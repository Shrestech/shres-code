/** Global destinations and searchable full-page settings; the workspace stays mounted underneath. */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { workspaceTitleOf } from '@shres-code/shres-code-client-runtime/client'
import {
  IconAgentPresetOutline16, IconCloseOutline16, IconDataOutline16,
  IconFolderOpen16, IconFollowsystemOutline16, IconPersonalizationOutline16,
  IconMicOutline16, IconCodeOutline16, IconThinkOutline16,
  IconSearchOutline16, IconSettingsOutline16, IconBranchOutline16,
} from '@shres-code/shres-code-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

type Destination = 'settings' | 'teams' | 'customize'

/** Unknown contributed sections remain discoverable in Settings. */
function destination(id: string): Destination {
  if (id === 'teams') return 'teams'
  if (id === 'plugins' || id === 'agent-presets') return 'customize'
  return 'settings'
}

function NavIcon({ id }: { id: string }) {
  if (id === 'models') return <IconDataOutline16 size={18} />
  if (id === 'model-routing') return <IconBranchOutline16 size={18} />
  if (id === 'appearance') return <IconFollowsystemOutline16 size={18} />
  if (id === 'audio') return <IconMicOutline16 size={18} />
  if (id === 'jspace') return <IconThinkOutline16 size={18} />
  if (id === 'shield') return <IconCodeOutline16 size={18} />
  if (id === 'general') return <IconPersonalizationOutline16 size={18} />
  if (id === 'agent-presets' || id === 'teams') return <IconAgentPresetOutline16 size={18} />
  if (id === 'plugins') return <IconPersonalizationOutline16 size={18} />
  return <IconSettingsOutline16 size={18} />
}

/**
 * Render global navigation, the active destination, and the ordered onboarding flow.
 * @param props - Frame navigation, slot ledgers, locale, and session shares.
 * @returns The navigation bar and selected page.
 */
export function SettingsRoot({
  page, navigate, useSections, useOnboardingSteps, useSessions, renderSlot, t,
}: SettingsRootComponentProps) {
  const rows = useSections(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const cwd = useSessions(s => s.current === undefined ? undefined : s.byId[s.current]?.cwd)
  const [query, setQuery] = useState('')
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const heading = useRef<HTMLHeadingElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const open = page !== null
  const activeDestination = destination(page ?? 'general')
  const close = useCallback(() => { navigate(null); (opener.current ?? trigger.current)?.focus() }, [navigate])
  const openSection = useCallback((id: string, source?: HTMLButtonElement) => {
    opener.current = source ?? trigger.current
    setQuery('')
    navigate(id)
  }, [navigate])
  const navRows: readonly SettingsSectionRow[] = rows.flatMap(row => row.id === 'general'
    ? [row, { id: 'appearance', order: row.order + 1, label: t('appearance.nav') }]
    : [row])
  const destinationRows = navRows.filter(row => destination(row.id) === activeDestination)
  const active = destinationRows.find(row => row.id === page) ?? destinationRows[0]
  const filtered = destinationRows.filter(row => row.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const sectionId = active?.id === 'appearance' ? 'general' : active?.id
  const title = activeDestination === 'settings' ? t('title') : t(`navigation.${activeDestination}`)
  const general = active?.id === 'general'

  useEffect(() => {
    if (!open) return
    heading.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) close()
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [open, page, close])

  const onboardingActive = useSessions(state => state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined
  useEffect(() => {
    if (!onboardingActive) setCompletedOnboarding(new Set())
  }, [onboardingActive])
  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding(previous => previous.has(id) ? previous : new Set([...previous, id]))
  }, [])

  return <>
    <header className={css.topbar}>
      <button className={css.wordmark} onClick={() => { navigate(null) }} aria-label={t('navigation.home')}>SHRES</button>
      <nav className={css.destinations} aria-label={t('navigation.label')}>
        <button className={clsx(css.destination, !open && css.selected)} aria-current={!open ? 'page' : undefined} onClick={() => { navigate(null) }}>{t('navigation.workspace')}</button>
        {(['teams', 'customize'] as const).map((group) => {
          const first = rows.find(row => destination(row.id) === group)
          return first === undefined ? null : <button key={group}
            className={clsx(css.destination, open && activeDestination === group && css.selected)}
            aria-current={open && activeDestination === group ? 'page' : undefined}
            onClick={(event) => { openSection(first.id, event.currentTarget) }}>{t(`navigation.${group}`)}</button>
        })}
      </nav>
      {cwd !== undefined && <button className={css.workspace} onClick={() => { navigate(null) }} title={cwd}>
        <IconFolderOpen16 size={18} /><span>{workspaceTitleOf(cwd)}</span>
      </button>}
      <button ref={trigger} type="button"
        className={clsx(css.destination, css.settingsTrigger, open && activeDestination === 'settings' && css.selected)}
        aria-expanded={open && activeDestination === 'settings'}
        aria-current={open && activeDestination === 'settings' ? 'page' : undefined}
        onClick={(event) => { openSection('general', event.currentTarget) }}>
        {renderSlot('settings.trigger', { wide: true })}
      </button>
    </header>
    {open && <section className={css.page} role="region" aria-label={title}>
      <aside className={css.nav}>
        <div className={css.navHeading}>
          <h2>{activeDestination === 'settings' ? renderSlot('settings.header', {}) : title}</h2>
          <button className={css.close} onClick={close}>
            <IconCloseOutline16 size={16} /><span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
          </button>
        </div>
        <label className={css.search}>
          <IconSearchOutline16 size={16} />
          <input ref={search} type="search" value={query} onChange={(event) => { setQuery(event.target.value) }}
            placeholder={t('search')} aria-label={t('search')} />
          <kbd>⌘ K</kbd>
        </label>
        <nav className={css.navList} aria-label={title}>
          {filtered.map(row => <button key={row.id} type="button"
            className={clsx(css.navCell, row.id === active?.id && css.active)}
            aria-current={row.id === active?.id ? 'page' : undefined}
            onClick={() => { navigate(row.id) }}>
            <NavIcon id={row.id} /><span>{row.label}</span>
          </button>)}
          {filtered.length === 0 && <p className={css.noResults} role="status">{t('search.empty')}</p>}
        </nav>
      </aside>
      <div className={css.content}>
        <div className={css.contentInner}>
          <div className={css.pageHeader}>
            <div className={css.eyebrow}>{title}</div>
            <h1 id={titleId} ref={heading} tabIndex={-1}>{general ? t('general.heading') : active?.label ?? title}</h1>
            <p>{general ? t('general.description') : t(`description.${activeDestination}`)}</p>
          </div>
          <div className={css.options}>
            {sectionId !== undefined && renderSlot('settings.section', {
              close, ...(active?.id === 'appearance' ? { item: 'appearance' } : {}),
            }, { only: sectionId })}
          </div>
          {activeDestination === 'settings' && <footer className={css.actions}>{renderSlot('settings.action', {})}</footer>}
        </div>
      </div>
    </section>}
    {onboardingStep !== undefined && renderSlot('settings.onboarding', {
      stepId: onboardingStep.id, complete: () => { completeOnboardingStep(onboardingStep.id) }, openSection,
    }, { only: onboardingStep.id })}
  </>
}
