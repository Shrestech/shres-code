/** Strict per-session header/body content inserted into the resident conversation layout. */

import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { indexSubagentDescendants } from '@shres-code/shres-code-client-runtime/client'
import type { SessionId, SessionListState, SessionSummary } from '@shres-code/shres-code-client-runtime/client'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps,
} from '../contract/slots.ts'
import type { ViewTab } from '../contract/views.ts'
import { readInspectRequest } from '../inspect.ts'
import { readActivityOpen } from '../stores.ts'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps

interface Breadcrumb {
  readonly id: SessionId
  readonly displayTitle: string
}

const DEFAULT_VIEW_ID = 'chat'

/** Resolve by id and keep stale persisted selections on the stable Chat fallback. */
function resolveActiveView(tabs: readonly ViewTab[], selectedId: string | null): ViewTab | undefined {
  const requestedId = selectedId ?? DEFAULT_VIEW_ID
  return tabs.find(view => view.id === requestedId)
    ?? tabs.find(view => view.id === DEFAULT_VIEW_ID)
}

function deriveAncestry(list: SessionListState, id: SessionId): readonly Breadcrumb[] {
  const chain: Breadcrumb[] = []
  const seen = new Set<SessionId>()
  let cursor: SessionId | undefined = id
  while (cursor !== undefined) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const summary: SessionSummary | undefined = list.byId[cursor]
    if (summary === undefined) break
    chain.unshift({ id: summary.id, displayTitle: summary.displayTitle })
    if (summary.origin !== 'subagent') break
    cursor = summary.parentId
  }
  return chain
}

function equalBreadcrumbs(left: readonly Breadcrumb[], right: readonly Breadcrumb[]): boolean {
  return left.length === right.length
    && left.every((item, index) => {
      const other = right.at(index)
      return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle
    })
}

/**
 * Renders Session header chrome and the Activity inspector above the resident
 * conversation scrollport.
 * @param props - Strict Session store, view ledger, navigation, render, and locale shares.
 * @returns the hidden blank-session header, or the visible title, the Activity
 * control carrying its running-subagent count, and the Activity panel.
 */
export function ConversationSessionHeader({
  sessionId, useSession, useSessions, useStore, actions,
  renderSlot, views, open, t,
}: ConversationSessionHeaderProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  // Chat stays the primary conversation surface. Every registered view
  // remains in the same ring so inspect handoffs can still select it, but all
  // view changes are reached from the session-local Activity inspector
  // instead of a competing top-level tab row.
  const activityViews = tabs
  const ancestry = useSessions(s => deriveAncestry(s, sessionId), equalBreadcrumbs)
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const hideChrome = blank && composerPhase === 'blank'
  // Counted from the retained list mirror rather than the panel's subagent
  // catalog: the trigger count must be current while the panel stays closed.
  const summaries = useSessions(s => s.byId)
  const runningDescendants = useMemo(
    () => indexSubagentDescendants(summaries).get(sessionId)?.runningCount ?? 0,
    [sessionId, summaries],
  )
  const activityRunningId = useId()
  // Open state lives in the session's chat store so a view's reveal closes the popover.
  const activityOpen = useStore(s => readActivityOpen(s.activityOpen))
  const activityRef = useRef<HTMLDivElement | null>(null)
  const activityPanelRef = useRef<HTMLDivElement | null>(null)
  const activityTriggerRef = useRef<HTMLButtonElement | null>(null)
  // Set by the trigger only, so focus moves into the panel on a user open and
  // never for a store value, such as a persisted open state, rendered at mount.
  const focusPanelOnOpen = useRef(false)

  /** Close from a gesture inside the header, returning focus to the trigger. */
  const closeActivity = (): void => {
    actions.setActivityOpen(false)
    queueMicrotask(() => { activityTriggerRef.current?.focus() })
  }

  useEffect(() => {
    actions.setActivityOpen(false)
  }, [actions, sessionId])

  useEffect(() => {
    if (!activityOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node) || activityRef.current?.contains(target) !== true) {
        actions.setActivityOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [actions, activityOpen])

  useEffect(() => {
    if (!activityOpen || !focusPanelOnOpen.current) return
    focusPanelOnOpen.current = false
    activityPanelRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [activityOpen])

  // Resolve the legacy action/utilities lists on every header render so their
  // registration lifecycle remains observable even while the inspector is
  // closed. The panel stays mounted but hidden below, which keeps portaled
  // dialogs owned by those contributions alive after Activity closes.
  const activityItems = (
    <>
      {renderSlot('conversation.session.activity', {})}
      {renderSlot('conversation.session.header.actions', {})}
      {renderSlot('conversation.session.header.utilities', {})}
    </>
  )

  return (
    <header
      className={clsx(css.header, hideChrome && css.headerHidden)}
      aria-hidden={hideChrome || undefined}
    >
      {!hideChrome && (
        <>
          <div className={css.titleRow}>
            <div className={css.titleCluster}>
              <nav className={css.crumbs} aria-label={t('session.hierarchy')}>
                {ancestry.map((summary, index) => {
                  const last = index === ancestry.length - 1
                  return (
                    <span key={summary.id} className={css.crumbSeg}>
                      {index > 0 && <span className={css.crumbSep}>/</span>}
                      <button
                        type="button"
                        className={clsx(css.crumb, last && css.crumbCurrent)}
                        disabled={last}
                        onClick={() => { open(summary.id) }}
                      >
                        {summary.displayTitle}
                      </button>
                    </span>
                  )
                })}
                {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
              </nav>
            </div>
            <div ref={activityRef} className={css.activity}>
              <button
                type="button"
                aria-label={t('activity.label')}
                aria-describedby={runningDescendants > 0 ? activityRunningId : undefined}
                ref={activityTriggerRef}
                className={css.activityTrigger}
                aria-expanded={activityOpen}
                aria-haspopup="dialog"
                aria-controls="shres-session-activity"
                onClick={() => {
                  if (activityOpen) closeActivity()
                  else {
                    focusPanelOnOpen.current = true
                    actions.setActivityOpen(true)
                  }
                }}
              >
                <span className={css.activityMark} aria-hidden="true">+</span>
                <span>{t('activity.label')}</span>
                {runningDescendants > 0 && (
                  <span id={activityRunningId} className={css.activityRunning}>
                    {t(
                      runningDescendants === 1 ? 'activity.running.one' : 'activity.running.other',
                      { count: runningDescendants },
                    )}
                  </span>
                )}
                {active !== undefined && active.id !== DEFAULT_VIEW_ID
                  ? <span className={css.activityCurrent}>{active.label}</span>
                  : null}
              </button>
              <div
                id="shres-session-activity"
                ref={activityPanelRef}
                className={css.activityPanel}
                role="dialog"
                aria-label={t('activity.title')}
                hidden={!activityOpen}
                inert={!activityOpen}
                onKeyDown={(event) => {
                  const target = event.target
                  if (!(target instanceof Node) || activityPanelRef.current?.contains(target) !== true) return
                  if (event.defaultPrevented || event.key !== 'Escape') return
                  event.preventDefault()
                  closeActivity()
                }}
              >
                <div className={css.activityHeading}>
                  <span className={css.activityKicker}>{t('activity.kicker')}</span>
                  <span className={css.activityTitle}>{t('activity.title')}</span>
                </div>
                {activityViews.length > 0 && (
                  <div className={css.activitySection}>
                    <span className={css.activitySectionLabel}>{t('activity.views')}</span>
                    <div className={css.activityViewList}>
                      {activityViews.map(view => (
                        <button
                          key={view.id}
                          type="button"
                          className={clsx(css.activityView, view.id === active?.id && css.activityViewActive)}
                          aria-current={view.id === active?.id ? 'page' : undefined}
                          onClick={() => {
                            actions.setView(view.id)
                            closeActivity()
                          }}
                        >
                          <span>{view.label}</span>
                          <span className={css.activityArrow} aria-hidden="true">→</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className={css.activitySection}>
                  <span className={css.activitySectionLabel}>{t('activity.tools')}</span>
                  <div className={css.activityItems}>
                    {activityItems}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </header>
  )
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession({
  sessionId, useSession, useInput, inputActions, useStore, actions,
  renderSlot, views, bindDraftMirror, releaseSessionImages, reveal, canReveal,
}: ConversationSessionProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)
  const storedInspect = useStore(s => s.inspect)
  const inspect = useMemo(() => readInspectRequest(storedInspect), [storedInspect])
  // Only the addressed view receives the request; any other active view sees
  // none, and the request waits for its view to become the active one.
  const addressed = inspect !== null && inspect.view === active?.id ? inspect : null

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  useEffect(() => () => {
    releaseSessionImages(sessionId)
  }, [releaseSessionImages, sessionId])

  if (blank && composerPhase === 'blank') return null
  return (
    <div className={css.viewArea}>
      {active !== undefined && renderSlot('conversation.view', {
        inspect: addressed,
        onInspectDone: () => { actions.setInspect(null) },
        reveal,
        canReveal,
      }, { only: active.id })}
    </div>
  )
}
