/**
 * The workspace overview's reader: one `modelRouting.stats` read per
 * workspace and range, polled while the overview is mounted and the page is
 * visible. The snapshot holds what the card shows; nothing here is persisted.
 */

import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { SessionId, SnapshotStore, WorkspaceListState } from '@shres-code/shres-code-client-runtime/client'
import type { ModelRoutingStatsRange, ModelRoutingStatsRequest, ModelRoutingWorkspaceStats } from '@shres-code/shres-code-model-router/client'
import { messageOf } from './model.ts'
import type { RemoteOutcome } from './model.ts'

/**
 * How often a visible overview reads again, in milliseconds. The Host pushes
 * no workspace statistics, so a poll is how the numbers follow the sessions.
 */
export const OVERVIEW_POLL_MS = 60_000

/**
 * The workspace the overview reads: the one accounting the current session,
 * else the most recently used one.
 * @param list - the workspace list.
 * @param current - the current session, if any.
 * @returns the workspace's list row, or undefined when there is none.
 */
export function overviewWorkspace(
  list: Pick<WorkspaceListState, 'items' | 'recentWorkspaceId'>,
  current: SessionId | undefined,
): WorkspaceListState['items'][number] | undefined {
  const owning = current === undefined ? undefined : list.items.find(item => item.sessionIds.includes(current))
  return owning ?? list.items.find(item => item.workspaceId === list.recentWorkspaceId)
}

/** What the overview card shows. */
export interface OverviewState {
  /** The workspace being read, or null before the card first mounts. */
  workspaceId: string | null
  range: ModelRoutingStatsRange
  /** `loading` only while no result for the current workspace and range exists. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The latest result for the current workspace and range. */
  stats: ModelRoutingWorkspaceStats | null
  /** The latest read's failure; the previous result stays shown beside it. */
  error: string | null
}

/** The overview's reader. */
export interface OverviewController {
  readonly store: SnapshotStore<OverviewState>
  /**
   * Read one workspace now, and again every {@link OVERVIEW_POLL_MS} while the
   * document is visible; a hidden page stops the timer, and becoming visible
   * reads at once when the last read is at least that old. One workspace is
   * watched at a time: a second call stops the first.
   * @param workspaceId - the workspace to read.
   * @returns the function that stops watching.
   */
  watch(workspaceId: string): () => void
  /**
   * Select the range, read it now, and restart the poll timer.
   * @param range - the range.
   */
  setRange(range: ModelRoutingStatsRange): void
  /**
   * Read the current workspace and range now.
   * @returns resolution once the read settled.
   */
  refresh(): Promise<void>
  /** Stop watching and ignore any read still in flight. */
  dispose(): void
}

/**
 * Create the overview reader.
 * @param read - the `modelRouting.stats` Remote method.
 * @returns the reader; nothing is read until {@link OverviewController.watch}.
 */
export function createOverviewController(
  read: (request: ModelRoutingStatsRequest) => Promise<RemoteOutcome<ModelRoutingWorkspaceStats>>,
): OverviewController {
  const store = createSnapshotStore<OverviewState>({ workspaceId: null, range: '24h', status: 'idle', stats: null, error: null })
  let generation = 0
  let lastReadAt = -Infinity
  let timer: ReturnType<typeof setInterval> | undefined
  let stopWatching: (() => void) | undefined

  const visible = (): boolean => document.visibilityState === 'visible'

  const refresh = async (): Promise<void> => {
    const { workspaceId, range } = store.getSnapshot()
    if (workspaceId === null) return
    const current = ++generation
    lastReadAt = Date.now()
    store.update((s) => { if (s.stats === null) s.status = 'loading' })
    let outcome: RemoteOutcome<ModelRoutingWorkspaceStats>
    try {
      outcome = await read({ workspaceId, range })
    } catch (error) {
      if (current === generation) store.update((s) => { s.status = 'error'; s.error = messageOf(error) })
      return
    }
    if (current !== generation) return
    store.update((s) => {
      if (outcome.ok) {
        s.status = 'ready'
        s.stats = outcome.value
        s.error = null
      } else {
        s.status = 'error'
        s.error = outcome.error.message
      }
    })
  }

  const stopTimer = (): void => {
    clearInterval(timer)
    timer = undefined
  }
  const startTimer = (): void => {
    stopTimer()
    if (visible()) timer = setInterval(() => { void refresh() }, OVERVIEW_POLL_MS)
  }
  const onVisibility = (): void => {
    if (!visible()) {
      stopTimer()
      return
    }
    if (Date.now() - lastReadAt >= OVERVIEW_POLL_MS) void refresh()
    startTimer()
  }

  /** Point the snapshot at a workspace and range, dropping a result for another. */
  const select = (workspaceId: string, range: ModelRoutingStatsRange): void => {
    const state = store.getSnapshot()
    if (state.workspaceId === workspaceId && state.range === range) return
    // A read of the previous selection must not land on this one.
    generation++
    store.update((s) => {
      s.workspaceId = workspaceId
      s.range = range
      s.stats = null
      s.error = null
      s.status = 'loading'
    })
  }

  const dispose = (): void => {
    stopWatching?.()
    generation++
  }

  return {
    store,
    watch(workspaceId) {
      stopWatching?.()
      select(workspaceId, store.getSnapshot().range)
      void refresh()
      startTimer()
      document.addEventListener('visibilitychange', onVisibility)
      const stop = (): void => {
        if (stopWatching !== stop) return
        stopWatching = undefined
        stopTimer()
        document.removeEventListener('visibilitychange', onVisibility)
      }
      stopWatching = stop
      return stop
    },
    setRange(range) {
      const { workspaceId } = store.getSnapshot()
      if (workspaceId === null) {
        store.update((s) => { s.range = range })
        return
      }
      select(workspaceId, range)
      void refresh()
      if (stopWatching !== undefined) startTimer()
    },
    refresh,
    dispose,
  }
}
