// ChatView: the default conversation view — one stable keyed parent list over
// final business Nodes, plus paging, pending steering and bottom-follow.
// Each row dispatches through 'conversation.chat.node'; ui-tool owns the
// tool-call renderer and its recursive root/subcall composition.
//
// Scroll: when nested under `[data-conversation-scroll]` (active conversation
// column), that host is the scrollport and this view is flow content; when
// mounted alone (unit tests), `.scroll` owns overflow. Bottom-follow and
// prepend anchoring always target the resolved scrollport.
//
// Render economics: order changes only when rows enter, leave or move. Each
// ChatNodeSeat subscribes to one Node key, so Assistant deltas and Tool
// lifecycle updates replace only their own row without remounting it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { elementScroll, measureElement, observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import type { ConversationTimelineSnapshot } from '@shres-code/shres-code-client-runtime/client'
import { IconChevronDownOutline14 } from '@shres-code/shres-code-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { PendingSteeringBubble } from './MessageItem.tsx'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { formatRunDuration } from './message-chrome.ts'
import css from './ChatView.module.css'

const FOLLOW_THRESHOLD = 24
const COLUMN_GAP = 16

/** Active column host when present; otherwise the view-local scroller. */
function scrollerOf(from: HTMLElement): HTMLElement {
  return (from.closest('[data-conversation-scroll]')) ?? from
}

interface PagingAnchor {
  /** Stable node/call identity, independent of boundary-spanning group keys. */
  key: string
  /** Enclosing chat-node identity used by the virtualizer for nested calls. */
  flowKey?: string
  /** Row top relative to the scrollport after the latest user scroll. */
  top: number
}

/** Find an already-rendered settled row without interpolating a selector. */
function anchorElement(list: HTMLElement, key: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    if (row.dataset.chatAnchorKey === key) return row
  }
  return null
}

/** Row position in scrollport coordinates (viewport-independent). */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/** Resolve the outer virtual row for a node or nested tool-call anchor. */
function flowKeyOf(row: HTMLElement): string | undefined {
  return row.closest<HTMLElement>('[data-chat-flow-key]')?.dataset.chatFlowKey
}

/** Select a visible stable node/call identity, falling back only when layout
 * has not exposed a visible box yet. */
function pagingAnchor(list: HTMLElement, scrollport: HTMLElement): HTMLElement | null {
  const viewport = scrollport.getBoundingClientRect()
  const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
  const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
  const rows = [...list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
  const visibleRows = rows.filter((row) => {
    const rect = row.getBoundingClientRect()
    return rect.bottom > viewport.top && rect.top < visibleBottom
  })
  return visibleRows[0] ?? rows[0] ?? null
}

type ChatScrollPosition = NonNullable<ReturnType<ChatViewSlotProps['chatScroll']['read']>>

/** Capture a reflow-resistant reader position from the current rendered window. */
function scrollPosition(list: HTMLElement, scrollport: HTMLElement): ChatScrollPosition | null {
  const row = pagingAnchor(list, scrollport)
  const anchorKey = row?.dataset.chatAnchorKey
  if (row === null || anchorKey === undefined) return null
  const flowKey = flowKeyOf(row)
  return {
    anchorKey,
    ...(flowKey === undefined ? {} : { flowKey }),
    anchorTop: flowTop(row, scrollport),
    scrollTop: scrollport.scrollTop,
  }
}

function runningTurnStartTime(timeline: ConversationTimelineSnapshot): number | null {
  let latest: number | null = null
  for (const turn of timeline.turns.values()) {
    if (turn.status === 'open' && turn.start !== undefined) latest = turn.start.time
  }
  return latest
}

/** Turn-level model activity label retained across first-token, tool, and streaming phases. */
function TurnStatus({ startTime, t }: {
  /** The running turn's logged `turn/start` time; null falls back to mount
   *  time when that boundary is outside the window. */
  startTime: number | null
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}) {
  const [mountedAt] = useState(() => Date.now())
  // Anchored to turn/start so a mid-turn reload keeps the real
  // elapsed time and the final footer's Ran-for label matches this clock.
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => {
      setElapsedMs(Math.max(0, Date.now() - anchor))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor])
  // Short turns keep the plain label; the clock only appears once the turn
  // has clearly been running for a while.
  const showClock = elapsedMs >= 15_000
  return (
    <div className={css.turnStatus} role="status" aria-live="polite">
      Deep diving...
      {showClock && (
        <span className={css.turnStatusClock} aria-hidden>
          {formatRunDuration(elapsedMs, t)}
        </span>
      )}
    </div>
  )
}

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt,
  fileMentions, t, useVirtual,
}: ChatViewSlotProps) {
  const virtual = useVirtual(value => value)
  const order = useSession(s => s.chat.order)
  const nodeStore = useSession(s => s.chat.nodes)
  const timeline = useSession(s => s.chat.timeline)
  const inbox = useSession(s => s.queue)
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const running = useSession(s => s.running)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const selectedCallId = useStore(s => (s.selection !== null && 'callId' in s.selection ? s.selection.callId : undefined))

  const pendingSteering = useMemo(
    () => inbox.filter(item => item.placement === 'steering'),
    [inbox],
  )
  const runningTurnStart = useMemo(() => runningTurnStartTime(timeline), [timeline])

  const listRef = useRef<HTMLDivElement | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const virtualPrefixRef = useRef<HTMLDivElement | null>(null)
  const pendingRestoreRef = useRef<ChatScrollPosition | null>(null)
  const restoreFrameRef = useRef<number | null>(null)
  const [virtualPrefixHeight, setVirtualPrefixHeight] = useState(0)
  const initialScrollRef = useRef(chatScroll.read())
  const atBottomRef = useRef(initialScrollRef.current === null)
  const [atBottom, setAtBottom] = useState(initialScrollRef.current === null)
  /** Last position delivered or written on the main thread. */
  const observedTopRef = useRef(0)
  /** Paging anchor: semantic row/position at click, updated by reader scrolls
   * while the request is pending and restored after the prepend lands. */
  const anchorRef = useRef<PagingAnchor | null>(null)
  const firstSeqRef = useRef<number | null>(null)
  const openedRef = useRef(false)
  const lastKeyRef = useRef<string | null>(null)
  const lastSteeringIdRef = useRef<string | null>(null)
  /** Flow tip signature — follow-scroll only when this moves, never on a
   *  scroll-driven at-bottom chrome re-render (which would snap inertial
   *  scrolls the rest of the way to the floor). */
  const followSigRef = useRef<string | null>(null)

  const firstKey = order[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const lastNode = lastKey === null ? undefined : nodeStore.get(lastKey)
  const lastSteeringId = pendingSteering[pendingSteering.length - 1]?.id ?? null
  const followSig = `${openState}:${firstSeq}:${lastKey}:${order.length}:${running ? 1 : 0}:${lastSteeringId ?? ''}`
  // Keep the mounted window bounded from the first render, including when a
  // view is hidden or has not received layout metrics yet. The initial rect
  // gives the virtualizer a useful estimate until the real scrollport reports.
  const virtualizationEnabled = order.length > 0
  const virtualPrefixHasContent = openState === 'loading'
    || (openState === 'error' && openError !== null)
    || hasMore
  const getVirtualScrollElement = useCallback(() => {
    const local = listRef.current
    return local === null ? null : scrollerOf(local)
  }, [])
  const estimateVirtualItemSize = useCallback(() => virtual.estimatedRowHeight, [virtual.estimatedRowHeight])
  const getVirtualItemKey = useCallback((index: number) => order[index] ?? index, [order])
  const rowVirtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: virtualizationEnabled ? order.length : 0,
    enabled: virtualizationEnabled,
    estimateSize: estimateVirtualItemSize,
    getItemKey: getVirtualItemKey,
    getScrollElement: getVirtualScrollElement,
    initialRect: { width: 0, height: virtual.initialViewportHeight },
    observeElementRect: (instance, callback) => observeElementRect(instance, (rect) => {
      // Hidden views retain their last measurable viewport instead of
      // replacing it with a zero-sized range during a tab transition.
      if (rect.width > 0 && rect.height > 0) callback(rect)
    }),
    measureElement: (element, entry, instance) => {
      if (element.getClientRects().length === 0) {
        const index = Number(element.dataset.index)
        return instance.getVirtualItems().find(item => item.index === index)?.size ?? virtual.estimatedRowHeight
      }
      return measureElement(element, entry, instance)
    },
    scrollToFn: (offset, options, instance) => {
      elementScroll(offset, options, instance)
      const element = instance.scrollElement
      if (element !== null) observedTopRef.current = element.scrollTop
    },
    anchorTo: 'end',
    gap: COLUMN_GAP,
    overscan: virtual.overscanRows,
    scrollMargin: virtualPrefixHeight,
    scrollEndThreshold: FOLLOW_THRESHOLD,
    onChange: (instance, sync) => {
      // The composer seat is a real sibling after the virtual window. TanStack
      // can therefore finish measuring rows while its own virtual range is
      // already at the end but the host still has a non-virtual suffix. Keep
      // the host's actual floor authoritative while the reader is pinned.
      if (!virtualizationEnabled || sync || !atBottomRef.current) return
      const el = instance.scrollElement
      if (el === null) return
      const floor = Math.max(0, el.scrollHeight - el.clientHeight)
      if (Math.abs(el.scrollTop - floor) > 0.5) {
        el.scrollTop = floor
        observedTopRef.current = el.scrollTop
      }
    },
  })
  const virtualItems = virtualizationEnabled ? rowVirtualizer.getVirtualItems() : []

  useLayoutEffect(() => {
    const measured = virtualPrefixRef.current?.offsetHeight ?? 0
    if (measured !== virtualPrefixHeight) setVirtualPrefixHeight(measured)
  }, [
    hasMore,
    loadingOlder,
    openError?.code,
    openError?.message,
    openState,
    virtualPrefixHeight,
  ])

  const toBottom = (el: HTMLElement): void => {
    anchorRef.current = null
    pendingRestoreRef.current = null
    if (restoreFrameRef.current !== null) {
      cancelAnimationFrame(restoreFrameRef.current)
      restoreFrameRef.current = null
    }
    if (virtualizationEnabled) {
      rowVirtualizer.scrollToOffset(Math.max(0, el.scrollHeight - el.clientHeight), { behavior: 'auto' })
    } else {
      el.scrollTop = el.scrollHeight
    }
    observedTopRef.current = el.scrollTop
    atBottomRef.current = true
    setAtBottom(true)
    chatScroll.save(null)
  }

  const restoreSavedPosition = (
    local: HTMLElement,
    el: HTMLElement,
    saved: ChatScrollPosition,
    settled = false,
  ): boolean => {
    const row = anchorElement(local, saved.anchorKey)
    if (row === null) return false
    const correction = flowTop(row, el) - saved.anchorTop
    if (virtualizationEnabled) {
      // scrollToOffset cancels a preceding scrollToIndex target, so the
      // semantic row is brought into range before this exact correction.
      rowVirtualizer.scrollToOffset(el.scrollTop + correction, { behavior: 'auto' })
    } else {
      el.scrollTop += correction
    }
    observedTopRef.current = el.scrollTop
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    const normalized = isAtBottom ? null : scrollPosition(local, el)
    if (isAtBottom) chatScroll.save(null)
    else if (normalized !== null) chatScroll.save(normalized)
    if (settled || typeof requestAnimationFrame !== 'function') {
      pendingRestoreRef.current = null
    } else {
      pendingRestoreRef.current = saved
      if (restoreFrameRef.current === null) {
        // Row measurements can commit after the prepend's first layout. Keep
        // the semantic anchor through that commit before releasing restoration.
        restoreFrameRef.current = requestAnimationFrame(() => {
          restoreFrameRef.current = requestAnimationFrame(() => {
            restoreFrameRef.current = null
            const pending = pendingRestoreRef.current
            if (pending !== null && local.isConnected) restoreSavedPosition(local, el, pending, true)
          })
        })
      }
    }
    return true
  }

  useLayoutEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */
    if (local === null) return
    const el = scrollerOf(local)
    if (openState !== 'open') {
      // Reconnect reopens the same Session without remounting this view.
      openedRef.current = false
      pendingRestoreRef.current = null
      if (restoreFrameRef.current !== null) {
        cancelAnimationFrame(restoreFrameRef.current)
        restoreFrameRef.current = null
      }
      return
    }
    // Open completed: jump to the bottom once — unless a scroll position
    // survives from a previous mount (view-tab switch away and back), which
    // is restored instead of snapping the reader back to the floor.
    if (!openedRef.current) {
      openedRef.current = true
      const saved = chatScroll.read()
      if (saved === null) {
        toBottom(el)
      } else if (virtualizationEnabled && order.includes(saved.flowKey ?? saved.anchorKey)) {
        pendingRestoreRef.current = saved
        atBottomRef.current = false
        setAtBottom(false)
        rowVirtualizer.scrollToIndex(order.indexOf(saved.flowKey ?? saved.anchorKey), { behavior: 'auto', align: 'start' })
        if (!restoreSavedPosition(local, el, saved)) observedTopRef.current = el.scrollTop
      } else {
        atBottomRef.current = false
        setAtBottom(false)
        el.scrollTop = saved.scrollTop
        if (!restoreSavedPosition(local, el, saved)) {
          observedTopRef.current = el.scrollTop
          const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
          atBottomRef.current = isAtBottom
          setAtBottom(isAtBottom)
          if (isAtBottom) chatScroll.save(null)
        }
      }
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    const appendedUser = lastKey !== lastKeyRef.current && lastNode?.kind === 'user'
    const appendedSteering = lastSteeringId !== null && lastSteeringId !== lastSteeringIdRef.current
    if (appendedUser || appendedSteering) {
      toBottom(el)
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    const pendingRestore = pendingRestoreRef.current
    if (pendingRestore !== null) {
      if (restoreSavedPosition(local, el, pendingRestore)) {
        firstSeqRef.current = firstSeq
        lastKeyRef.current = lastKey
        lastSteeringIdRef.current = lastSteeringId
        followSigRef.current = followSig
        return
      }
      const restoreIndex = order.indexOf(pendingRestore.flowKey ?? pendingRestore.anchorKey)
      if (virtualizationEnabled && restoreIndex >= 0) {
        atBottomRef.current = false
        setAtBottom(false)
        rowVirtualizer.scrollToIndex(restoreIndex, { behavior: 'auto', align: 'start' })
        observedTopRef.current = el.scrollTop
        return
      }
      pendingRestoreRef.current = null
    }
    // Prepend (head seq decreased): preserve the same settled row at the
    // position established by the reader's latest scroll. This excludes
    // unrelated tail/composer growth while the request was in flight.
    if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
      const anchor = anchorRef.current
      const row = anchorElement(local, anchor.key)
      if (row !== null) {
        anchorRef.current = null
        restoreSavedPosition(local, el, {
          anchorKey: anchor.key,
          ...(anchor.flowKey === undefined ? {} : { flowKey: anchor.flowKey }),
          anchorTop: anchor.top,
          scrollTop: el.scrollTop,
        })
      } else if (virtualizationEnabled) {
        const anchorIndex = order.indexOf(anchor.flowKey ?? anchor.key)
        if (anchorIndex >= 0) {
          // A newly prepended page can move the old visible row outside the
          // virtual range. Recenter by its stable key, then let the pending
          // semantic restore apply the exact pre-page top on the next layout.
          pendingRestoreRef.current = {
            anchorKey: anchor.key,
            ...(anchor.flowKey === undefined ? {} : { flowKey: anchor.flowKey }),
            anchorTop: anchor.top,
            scrollTop: el.scrollTop,
          }
          atBottomRef.current = false
          setAtBottom(false)
          rowVirtualizer.scrollToIndex(anchorIndex, { behavior: 'auto', align: 'start' })
          observedTopRef.current = el.scrollTop
          anchorRef.current = null
          return
        }
        anchorRef.current = null
      } else {
        anchorRef.current = null
      }
      observedTopRef.current = el.scrollTop
      firstSeqRef.current = firstSeq
      /* v8 ignore next -- ?? arm: a prepend adds nodes, so the flow list here is never empty. */
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    firstSeqRef.current = firstSeq
    const tipMoved = followSigRef.current !== followSig
    lastKeyRef.current = lastKey
    lastSteeringIdRef.current = lastSteeringId
    followSigRef.current = followSig
    // Follow new flow content while pinned; do NOT re-pin on every render
    // merely because atBottomRef is true (scroll threshold → setState → snap).
    if (tipMoved && atBottomRef.current) toBottom(el)
  })

  useEffect(() => () => {
    if (restoreFrameRef.current !== null) cancelAnimationFrame(restoreFrameRef.current)
  }, [])

  const onScrollRef = useRef(() => {})
  onScrollRef.current = () => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the handler only fires while mounted. */
    if (local === null) return
    const el = scrollerOf(local)
    if (openState !== 'open' || pendingRestoreRef.current !== null) {
      observedTopRef.current = el.scrollTop
      return
    }
    // Only reader input may make raw scroll geometry change follow ownership:
    // a delivered position that deviates from the observed-top ledger (every
    // programmatic write records itself there synchronously). This covers
    // wheel, touch, scrollbar, and keyboard alike without naming devices.
    // Browser shrink-clamps land exactly on the floor min and delayed
    // programmatic deliveries land on the ledger itself, so both preserve
    // the current ownership state.
    const floor = Math.max(0, el.scrollHeight - el.clientHeight)
    const movedByReader = Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5
    const isAtBottom = movedByReader
      ? floor - el.scrollTop <= FOLLOW_THRESHOLD + 1
      : atBottomRef.current
    if (!movedByReader && isAtBottom) {
      toBottom(el)
      return
    }
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    const position = isAtBottom ? null : scrollPosition(local, el)
    if (isAtBottom) {
      anchorRef.current = null
    } else if (anchorRef.current !== null && position !== null) {
      anchorRef.current = {
        key: position.anchorKey,
        ...(position.flowKey === undefined ? {} : { flowKey: position.flowKey }),
        top: position.anchorTop,
      }
    }
    // Continuous save (unmount happens after ref detach, so saving there is
    // too late); pinned-to-bottom clears so a remount keeps following.
    if (isAtBottom) chatScroll.save(null)
    else if (position !== null) chatScroll.save(position)
    observedTopRef.current = el.scrollTop
  }

  // Bind the scroll listener on the resolved scrollport once per mount;
  // reader-input attribution rides the observed-top ledger, not per-device
  // input listeners.
  useEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: effect runs after the list node commits. */
    if (local === null) return
    const el = scrollerOf(local)
    const onScroll = (): void => { onScrollRef.current() }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

  // The ref starts null and is assigned every render, so the placeholder
  // initializer a function initial value would need never exists.
  const followRef = useRef<(() => void) | null>(null)
  followRef.current = () => {
    const local = listRef.current
    if (openState === 'open' && local !== null && atBottomRef.current) {
      const el = scrollerOf(local)
      el.scrollTop = el.scrollHeight
      observedTopRef.current = el.scrollTop
      chatScroll.save(null)
    }
  }
  // Streaming, tool disclosures, and other flow changes resize the column;
  // the sticky composer resizes outside it. This observer owns ChatView's
  // dynamic-height follow decisions and writes only while the reader is pinned.
  useEffect(() => {
    const column = columnRef.current
    const local = listRef.current
    if (column === null || local === null || typeof ResizeObserver === 'undefined') return
    const scrollport = scrollerOf(local)
    const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
    const prefix = virtualPrefixRef.current
    const updatePrefix = (): void => {
      const measured = prefix?.offsetHeight ?? 0
      setVirtualPrefixHeight(previous => previous === measured ? previous : measured)
      followRef.current?.()
    }
    const observer = new ResizeObserver(updatePrefix)
    observer.observe(column)
    if (composer !== null) observer.observe(composer)
    if (prefix !== null) observer.observe(prefix)
    return () => { observer.disconnect() }
  }, [virtualizationEnabled])

  // A failed/empty page leaves the head unchanged. Once the request leaves
  // its busy state there is no future prepend for the saved anchor to own.
  useEffect(() => {
    if (!loadingOlder) anchorRef.current = null
  }, [loadingOlder])

  const loadOlderAnchored = (): void => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
    if (local !== null) {
      const el = scrollerOf(local)
      const row = pagingAnchor(local, el)
      if (row !== null && row.dataset.chatAnchorKey !== undefined) {
        const flowKey = flowKeyOf(row)
        anchorRef.current = {
          key: row.dataset.chatAnchorKey,
          ...(flowKey === undefined ? {} : { flowKey }),
          top: flowTop(row, el),
        }
      }
    }
    loadOlder()
  }

  const historyControls = (
    <>
      {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
      {openState === 'error' && openError !== null && (
        <div className={css.openError}>
          {t('chat.loadError', { message: openError.message, code: openError.code })}
        </div>
      )}
      {hasMore && (
        <div className={css.older}>
          <button type="button" disabled={loadingOlder} onClick={loadOlderAnchored}>
            {loadingOlder ? t('loading') : t('chat.loadOlder')}
          </button>
        </div>
      )}
    </>
  )
  const renderNode = (nodeKey: string) => (
    <ChatNodeSeat
      key={nodeKey}
      nodeKey={nodeKey}
      useSession={useSession}
      selectedCallId={selectedCallId}
      cwd={cwd}
      openFile={openFile}
      inspectCall={inspectCall}
      forkAt={forkAt}
      loadImage={loadImage}
      fileMentions={fileMentions}
      renderSlot={renderSlot}
      t={t}
    />
  )
  const liveTail = (
    <>
      {/* No pending placeholders: questions (ui-user-questions) and approvals
          (ApprovalPanel) both take over the composer, so a flow card would
          double-render the same wait. */}
      {/* Turn-level loading signal: rides the whole running turn (first-token
          wait, tool execution, streaming) so it never flickers per step. */}
      {running && <TurnStatus startTime={runningTurnStart} t={t} />}
      {pendingSteering.map(item => (
        <PendingSteeringBubble key={item.id} content={item.content} loadImage={loadImage} t={t} />
      ))}
    </>
  )

  return (
    <div className={css.root}>
      <div ref={listRef} className={css.scroll}>
        <div
          ref={columnRef}
          className={virtualizationEnabled ? `${css.column} ${css.virtualColumn}` : css.column}
          data-chat-flow=""
          data-chat-node-count={order.length}
          data-chat-turn-count={timeline.turns.size}
        >
          {virtualizationEnabled ? (
            <>
              <div
                ref={virtualPrefixRef}
                className={css.virtualPrefix}
                style={{ paddingBottom: virtualPrefixHasContent ? COLUMN_GAP : 0 }}
              >
                {historyControls}
              </div>
              <div
                className={css.virtualWindow}
                style={{ height: rowVirtualizer.getTotalSize() }}
              >
                {virtualItems.map((item) => {
                  const nodeKey = order[item.index]
                  if (nodeKey === undefined) return null
                  return (
                    <div
                      key={String(item.key)}
                      ref={rowVirtualizer.measureElement}
                      data-index={item.index}
                      data-chat-virtual-item=""
                      className={css.virtualItem}
                      style={{
                        transform: `translateY(${item.start - virtualPrefixHeight}px)`,
                      }}
                    >
                      {renderNode(nodeKey)}
                    </div>
                  )
                })}
              </div>
              {(running || pendingSteering.length > 0) && (
                <div className={css.virtualSuffix}>{liveTail}</div>
              )}
            </>
          ) : (
            <>
              {historyControls}
              {order.map(nodeKey => renderNode(nodeKey))}
              {liveTail}
            </>
          )}
        </div>
        {!atBottom && (
          <div className={css.toBottomSlot}>
            <button
              type="button"
              className={css.toBottom}
              aria-label={t('chat.toBottom')}
              onClick={() => {
                const local = listRef.current
                /* v8 ignore next -- ref-null guard: the button only renders alongside the mounted list. */
                if (local !== null) toBottom(scrollerOf(local))
              }}
            >
              <IconChevronDownOutline14 />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
