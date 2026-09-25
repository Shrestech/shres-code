// @vitest-environment jsdom
// ConversationRoot skeleton behavior: the ONE resident composer across the
// hero (blank session) and active phases — same textarea DOM node, machine-
// owned draft, and the hero workspace picker (switching = retargetWorkspace).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import {
  createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS,
} from '@shres-code/shres-code-client-runtime/client'
import type {
  ConversationSnapshot, SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceListState,
  WorkspaceView,
} from '@shres-code/shres-code-client-runtime/client'
import type { ConversationRootProps } from '../src/client/skeleton/ConversationRoot.tsx'
import type { ClientContext } from '@shres-code/shres-code-client-runtime/client'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { Modal } from '@shres-code/shres-code-client-ui-primitives'
import { createReveal } from '../src/client/inspect.ts'
import { createChatStore } from '../src/client/stores.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { en } from '../src/client/locales.ts'
import { ConversationRoot } from '../src/client/skeleton/ConversationRoot.tsx'
import { ConversationSession, ConversationSessionHeader } from '../src/client/skeleton/ConversationSession.tsx'
import { HeroShell } from '../src/client/skeleton/EmptyHero.tsx'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'
import type {
  ComposerBarOwnerProps, ConvViewOwnerProps,
} from '../src/client/contract/slots.ts'
import type { ViewTab } from '../src/client/contract/views.ts'

/** Machine-backed wiring over a sink spy. */
function fakeWiring() {
  const sink = vi.fn()
  const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink })
  return { wiring: shell, sink, shell }
}

/** jsdom has no ResizeObserver; the composer seat publishes its height through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

// Mirrors the real lookup chain (conversation namespace, then common).
const t: ConversationRootProps['t'] = makeTranslate(en, commonEn)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const SID = sid('s1')

function workspace(id = 'w1'): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title: id, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const workspaceState = (items: readonly WorkspaceView[]): WorkspaceListState => ({
  items, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  baselinesReady: true, recentWorkspaceId: undefined,
})

function conversationSnapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false,
    promptError: null, blank: false, subagent: null, lastAgentError: null,
    ...overrides,
  }
}

/** One session-list row. An absent `origin` is an ordinary fork, which ends a lineage. */
function row(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 3, ...over }
}

/** Minimal export-like utility whose dialog is portaled outside Activity. */
function PortaledExportAction(): ReactNode {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button type="button" onClick={() => { setOpen(true) }}>Export session</button>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title="Session export"
        closeLabel="Close export"
      />
    </>
  )
}

function mount(
  snapshot: ConversationSnapshot,
  workspaceRows: WorkspaceView[] = [{ ...workspace('one'), sessionIds: [SID] }],
  retargetWorkspace = vi.fn(async (_workspaceId: WorkspaceId) => {}),
  options: {
    /** When true, mimic overlay:true chain siblings (hidden fallback + takeover). */
    overlayTakeover?: boolean
    /** The session list summary's `blank` flag — independent of the snapshot's. */
    summaryBlank?: boolean
    /** Drop the session's summary row entirely (a session the list has not caught up with). */
    omitSummaryRow?: boolean
    /** Classify the selected child as a subagent instead of an ordinary fork. */
    summaryOrigin?: 'subagent'
    /** A composer block another plugin raised for this session. */
    composerBlock?: { reason: string }
    /** Talk mode flag passed onto the composer chain owner. */
    talkMode?: boolean
    /** Mutable view ledger used by registration-order regressions. */
    viewTabs?: ViewTab[]
    /** Session-list rows that seed a subagent lineage under the selected child. */
    descendants?: SessionSummary[]
    /** Nested Activity content that can consume keyboard events in a test. */
    activityAction?: ReactNode
    /** Activity utility with a portal-owned dialog, like Session export. */
    activityUtility?: ReactNode
  } = {},
) {
  const root = sid('root')
  const rootRow = { id: root, displayTitle: 'Root', running: false, blank: false, updatedAt: 1 }
  const childRow = {
    id: SID, displayTitle: 'Child', parentId: root, cwd: '/projects/one',
    running: false, blank: options.summaryBlank ?? false, updatedAt: 2,
    ...(options.summaryOrigin === undefined ? {} : { origin: options.summaryOrigin }),
  }
  const listed = options.omitSummaryRow !== true
  // Lineage seeds ride byId only: the runtime list keeps addressed rows out of ids.
  const descendants = options.descendants ?? []
  const sessions = createSnapshotStore<SessionListState>({
    ids: listed ? [root, SID] : [root],
    byId: {
      [root]: rootRow,
      ...listed && { [SID]: childRow },
      ...Object.fromEntries(descendants.map(entry => [entry.id, entry])),
    },
    current: SID,
    phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const workspaces = createSnapshotStore<WorkspaceListState>(workspaceState(workspaceRows))
  const session = createSnapshotStore<ConversationSnapshot>(snapshot)
  const useSession = bindSnapshotSelector(session)
  const chat = createChatStore().create()
  chat.actions.setDraft('ordinary draft')
  const { wiring, sink } = fakeWiring()
  const useInput = bindSnapshotSelector(wiring.state)
  const inputActions = wiring.actions
  const stop = vi.fn()
  const open = vi.fn()
  const slotCalls: string[] = []
  const viewTabs = options.viewTabs ?? [
    { id: 'chat', label: 'Chat' },
    { id: 'trajectory', label: 'Trajectory' },
  ]
  const views = {
    list: () => viewTabs,
    subscribe: () => () => {},
    version: () => 1,
  }
  /** Owner share handed to the two composer tool-row seats, per render. */
  const seatOwners: { key: string; owner: unknown }[] = []
  /** Owner share handed to the rendered view, per render, keyed by view id. */
  const viewOwners: { view: string; owner: ConvViewOwnerProps }[] = []
  let pickerOwner: unknown
  const renderSlot = ((key: string, owner: object, opts?: { only?: string }) => {
    slotCalls.push(key)
    if (key === 'conversation.input.model' || key === 'conversation.input.plan') {
      seatOwners.push({ key, owner })
    }
    if (key === 'conversation.hero.workspace') { pickerOwner = owner; return null }
    if (key === 'conversation.session.activity' && options.activityAction !== undefined) {
      return options.activityAction
    }
    if (key === 'conversation.session.header.utilities' && options.activityUtility !== undefined) {
      return options.activityUtility
    }
    if (key === 'conversation.session.header') {
      return (
        <ConversationSessionHeader
          sessionId={SID}
          SessionProvider={({ children }) => children(SID)}
          useSession={useSession}
          useSessions={props.useSessions}
          useWorkspaces={props.useWorkspaces}
          useProjection={(() => undefined)}
          useInput={useInput}
          inputActions={inputActions}
          useStore={bindSnapshotSelector(chat)}
          actions={chat.actions}
          renderSlot={renderSlot as never}
          views={views}
          open={open}
          t={t}
        />
      )
    }
    if (key === 'conversation.session') {
      return (
        <ConversationSession
          sessionId={SID}
          SessionProvider={({ children }) => children(SID)}
          useSession={useSession}
          useSessions={props.useSessions}
          useWorkspaces={props.useWorkspaces}
          useProjection={(() => undefined)}
          useInput={useInput}
          inputActions={inputActions}
          useStore={bindSnapshotSelector(chat)}
          actions={chat.actions}
          renderSlot={renderSlot as never}
          views={views}
          releaseSessionImages={vi.fn()}
          bindDraftMirror={write => wiring.bindMirror(write)}
          reveal={createReveal(chat.actions)}
          canReveal={view => viewTabs.some(tab => tab.id === view)}
        />
      )
    }
    if (key === 'conversation.composer.bar') {
      // The real entry, mounted the way the outlet composes it: standard kit
      // (shared with the root's props below) + this entry's inject + owner.
      const bar = owner as ComposerBarOwnerProps
      return (
        <InputBar
          sessionId={SID}
          SessionProvider={({ children }) => children(SID)}
          useSession={useSession}
          useSessions={props.useSessions}
          useWorkspaces={props.useWorkspaces}
          useProjection={(() => undefined)}
          useInput={useInput}
          inputActions={inputActions}
          keyboard={wiring}
          addImages={() => null}
          removeImage={() => {}}
          draftImages={() => []}
          resolveSubmitMode={() => 'queue'}
          toggleCommandMenu={vi.fn()}
          useNotices={bindSnapshotSelector(wiring.notices)}
          useLexicon={bindSnapshotSelector(wiring.lexicon)}
          useMenuLauncher={bindSnapshotSelector(createSnapshotStore<string | null>(null))}
          stop={stop}
          command={() => Promise.resolve(true)}
          t={t}
          renderSlot={((key: string, seatOwner: object) => {
            // The bar's own seats: recorded so a case can assert what share
            // each tool-row control received.
            seatOwners.push({ key, owner: seatOwner })
            return null
          }) as InputBarProps['renderSlot']}
          {...bar}
        />
      )
    }
    if (key === 'conversation.view' && opts?.only !== undefined) {
      viewOwners.push({ view: opts.only, owner })
    }
    return <div data-testid={`view-${opts?.only ?? key}`} />
  }) as ConversationRootProps['renderSlot']
  let chainOwner: unknown
  const renderSlotChain = ((_key, owner, opts) => {
    chainOwner = owner
    return options.overlayTakeover === true
      ? (
        <>
          <div data-chain-overlay-fallback="conversation.composer" style={{ display: 'none' }}>
            {opts?.fallback ?? null}
          </div>
          <div data-testid="composer-takeover">TAKEOVER</div>
        </>
      )
      : (opts?.fallback ?? null)
  }) as ConversationRootProps['renderSlotChain']
  const props: ConversationRootProps = {
    sessionId: SID,
    SessionProvider: ({ children }) => children(SID),
    useSession,
    useSessions: bindSnapshotSelector(sessions),
    useWorkspaces: bindSnapshotSelector(workspaces),
    useProjection: (() => undefined),
    useComposerBlock: select => select(options.composerBlock),
    useTalkMode: select => select(options.talkMode === true),
    useInput,
    inputActions,
    renderSlot,
    renderSlotChain,
    selectWorkspace: retargetWorkspace,
    t,
  }
  const view = render(<ConversationRoot {...props} />)
  return {
    view, chat, sink, retargetWorkspace, session, sessions, slotCalls, seatOwners, open,
    pickerOwner: () => pickerOwner,
    chainOwner: () => chainOwner,
    /** The owner share the given view received on its latest render. */
    lastViewOwner: (id: string): ConvViewOwnerProps => {
      const latest = viewOwners.findLast(entry => entry.view === id)
      if (latest === undefined) throw new Error(`view ${id} never rendered`)
      return latest.owner
    },
    rerender: () => { view.rerender(<ConversationRoot {...props} />) },
  }
}

describe('Hero chrome', () => {
  it('renders the warm hero heading without mascot or preview chrome', () => {
    const view = render(<HeroShell t={makeTranslate(en, commonEn)} />)
    expect(view.getByText('Start with an idea')).toBeTruthy()
    expect(view.queryByText('Preview')).toBeNull()
    expect(view.container.querySelector('svg')).toBeNull()
  })
})

describe('ConversationRoot resident composer', () => {
  it('renders the composer inert with the blocker\u2019s own reason', () => {
    const b = mount(conversationSnapshot(), undefined, undefined, {
      composerBlock: { reason: 'select a model first' },
    })
    const box = b.view.getByRole('textbox') as HTMLTextAreaElement
    // One disabled textarea with the blocker's placeholder, never a second
    // tree: the DOM survives the block being raised and cleared.
    expect(box.disabled).toBe(true)
    expect(box.placeholder).toBe('select a model first')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(b.sink).not.toHaveBeenCalled()

    // The model seat stays live. Locking it too would leave the composer
    // asking for the one thing it prevents — every block this contract has is
    // cleared by choosing a model.
    const seat = (key: string) => b.seatOwners.filter(call => call.key === key).at(-1)?.owner
    expect(seat('conversation.input.model')).toEqual({ locked: false })
    expect(seat('conversation.input.plan')).toEqual({ locked: true })
  })

  it('lets the no-workspace posture win over a block', () => {
    // Picking a workspace is the earlier prerequisite; naming a model first
    // would send the user somewhere they cannot act yet.
    const b = mount(conversationSnapshot({ composerPhase: 'blank' }), [], undefined, {
      summaryBlank: true,
      composerBlock: { reason: 'select a model first' },
    })
    const box = b.view.getByRole('textbox') as HTMLTextAreaElement
    expect(box.disabled).toBe(false)
    expect(box.readOnly).toBe(true)
    expect(box.getAttribute('aria-haspopup')).toBe('menu')
    expect(box.placeholder).not.toBe('select a model first')
    const modelSeat = b.seatOwners.filter(call => call.key === 'conversation.input.model').at(-1)?.owner
    expect(modelSeat).toEqual({ locked: true })
  })

  it('keeps composer text in the machine, mirrors to the chat store, and submits through the sink', () => {
    const b = mount(conversationSnapshot())
    const box = b.view.getByRole('textbox')
    expect((box as HTMLTextAreaElement).value).toBe('ordinary draft')
    fireEvent.change(box, { target: { value: 'ordinary revised' } })
    expect(b.chat.store.getSnapshot().draft).toBe('ordinary revised')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(b.sink).toHaveBeenCalledWith('ordinary revised', [], 'queue')
    expect((b.view.getByRole('button', { name: 'Child' }) as HTMLButtonElement).disabled).toBe(true)
    expect(b.view.queryByText('Root')).toBeNull()
  })

  it('shows hierarchy only for subagents and opens their ordinary owner', () => {
    const b = mount(conversationSnapshot(), undefined, undefined, { summaryOrigin: 'subagent' })
    const root = b.view.getByRole('button', { name: 'Root' })
    expect((b.view.getByRole('button', { name: 'Child' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(root)
    expect(b.open).toHaveBeenCalledWith(sid('root'))
  })

  it('active phase: fixed header outside the scrollport; sticky composer seat inside it', () => {
    const b = mount(conversationSnapshot())
    const host = b.view.container.querySelector('[data-conversation-scroll]')
    const seat = b.view.container.querySelector('[data-composer-seat]')
    const header = b.view.container.querySelector('header')
    const textarea = b.view.container.querySelector('textarea')
    expect(host).not.toBeNull()
    expect(seat).not.toBeNull()
    expect(header).not.toBeNull()
    // Header is column chrome above the scrollport; the seat sticks inside it.
    expect(host?.contains(header)).toBe(false)
    expect(host?.contains(seat)).toBe(true)
    expect(seat?.contains(textarea)).toBe(true)
    expect(b.slotCalls).toContain('conversation.session.activity')
    expect(b.slotCalls).toContain('conversation.session.header.actions')
    expect(b.slotCalls).toContain('conversation.session.header.utilities')
  })

  it('passes talkMode onto the composer chain owner', () => {
    const off = mount(conversationSnapshot())
    expect(off.chainOwner()).toMatchObject({ talkMode: false })
    const on = mount(conversationSnapshot(), undefined, undefined, { talkMode: true })
    expect(on.chainOwner()).toMatchObject({ talkMode: true })
  })

  it('sticky composer seat wraps the whole overlay chain, not only the fallback stack', () => {
    const b = mount(conversationSnapshot(), undefined, undefined, { overlayTakeover: true })
    const seat = b.view.container.querySelector('[data-composer-seat]')
    const takeover = b.view.getByTestId('composer-takeover')
    const fallback = b.view.container.querySelector('[data-chain-overlay-fallback="conversation.composer"]')
    expect(seat?.contains(takeover)).toBe(true)
    expect(seat?.contains(fallback)).toBe(true)
  })

  it('hero phase: same textarea, hero chrome, no header, picker switches the workspace', () => {
    const b = mount(
      conversationSnapshot({ composerPhase: 'blank', blank: true }),
      [
        { ...workspace('one'), sessionIds: [SID] },
        { ...workspace('second'), title: 'Selected Folder' },
      ],
    )
    // Hero chrome present, view ring absent; scroll host already wraps the
    // resident composer so the blank → active flip does not remount it.
    const host = b.view.container.querySelector('[data-conversation-scroll]')
    const header = b.view.container.querySelector('header')
    expect(host).not.toBeNull()
    expect(header?.getAttribute('aria-hidden')).toBe('true')
    expect(b.view.getByText('Start with an idea')).toBeTruthy()
    expect(b.view.queryByText('Preview')).toBeNull()
    expect(b.view.queryByTestId('view-chat')).toBeNull()
    // The same machine-backed textarea is live in the hero, and the
    // persistence mirror stays bound (ConversationSession mounts chrome-hidden
    // for blank sessions): hero typing reaches the chat store.
    const box = b.view.getByRole('textbox')
    expect(host?.contains(box)).toBe(true)
    fireEvent.change(box, { target: { value: 'draft in hero' } })
    expect(b.chat.store.getSnapshot().draft).toBe('draft in hero')
    // Picker: open through the chip; a pick switches to the other
    // workspace's blank session (draft carry is apply-layer wiring).
    fireEvent.click(b.view.getByRole('button', { name: 'Choose workspace' }))
    const owner = b.pickerOwner() as { open: boolean; onPick(id: WorkspaceId): void }
    expect(owner.open).toBe(true)
    act(() => { owner.onPick(wid('second')) })
    expect(b.retargetWorkspace).toHaveBeenCalledWith(wid('second'))
    expect(b.view.getByText('Selected Folder')).toBeTruthy()
  })

  it('settling phase: a summary that does not prove the session blank hides the composer while it opens', () => {
    const b = mount(conversationSnapshot({ composerPhase: 'blank', blank: true, openState: 'loading' }))
    const root = b.view.container.querySelector('[data-phase]')
    expect(root?.getAttribute('data-phase')).toBe('settling')
    expect(b.view.queryByText('Start with an idea')).toBeNull()
  })

  it('settling phase: a session the list has no row for settles conservatively', () => {
    const b = mount(
      conversationSnapshot({ composerPhase: 'blank', blank: true, openState: 'loading' }),
      undefined,
      undefined,
      { omitSummaryRow: true },
    )
    const root = b.view.container.querySelector('[data-phase]')
    expect(root?.getAttribute('data-phase')).toBe('settling')
  })

  it('startup auto-selection: a summary-proven blank session opens straight into the hero', () => {
    const b = mount(
      conversationSnapshot({ composerPhase: 'blank', blank: true, openState: 'loading' }),
      undefined,
      undefined,
      { summaryBlank: true },
    )
    // The summary already proves the outcome, so the settling hide would only
    // blank the column for the history round-trip.
    const root = b.view.container.querySelector('[data-phase]')
    expect(root?.getAttribute('data-phase')).toBe('hero')
    expect(b.view.getByText('Start with an idea')).toBeTruthy()
    expect(b.view.getByRole('textbox')).toBeTruthy()
  })

  it('same textarea DOM node survives the hero → active flip into the sticky scrollport', () => {
    const b = mount(conversationSnapshot({ composerPhase: 'blank', blank: true }))
    const before = b.view.getByRole('textbox')
    fireEvent.change(before, { target: { value: 'kept across flip' } })
    // First message landed: content exists, phase leaves blank. Composer
    // already sat in the resident scrollport during hero, so the textarea
    // node and InputHub draft both survive.
    b.session.set(conversationSnapshot({ composerPhase: 'active', blank: false }))
    b.rerender()
    const after = b.view.getByRole('textbox') as HTMLTextAreaElement
    expect(after).toBe(before)
    expect(after.value).toBe('kept across flip')
    expect(b.chat.store.getSnapshot().draft).toBe('kept across flip')
    expect(b.view.container.querySelector('[data-conversation-scroll]')?.contains(after)).toBe(true)
    expect(b.view.queryByText('Start with an idea')).toBeNull()
    expect(b.view.getByTestId('view-chat')).toBeTruthy()
  })

  it('keeps pending takeover interaction accessible outside the Chat view', () => {
    const b = mount(conversationSnapshot({ pending: [{} as never] }))
    act(() => { b.chat.actions.setView('trajectory') })
    expect(b.view.getByTestId('view-trajectory')).toBeTruthy()
    expect(b.view.getByRole('textbox')).toBeTruthy()
  })

  it('shows Chat for an unlisted selected view without writing the store, and the view again when it returns', () => {
    const viewTabs: ViewTab[] = [
      { id: 'chat', label: 'Chat' },
      { id: 'trajectory', label: 'Trajectory' },
      { id: 'routing', label: 'Routing' },
    ]
    const b = mount(conversationSnapshot(), undefined, undefined, { viewTabs })
    act(() => { b.chat.actions.setView('routing') })
    expect(b.view.getByTestId('view-routing')).toBeTruthy()

    // The view's owner unlisted it (its host capability went away).
    viewTabs.pop()
    b.rerender()
    expect(b.view.getByTestId('view-chat')).toBeTruthy()
    expect(b.chat.store.getSnapshot().view).toBe('routing')

    viewTabs.push({ id: 'routing', label: 'Routing' })
    b.rerender()
    expect(b.view.getByTestId('view-routing')).toBeTruthy()
  })

  it('keeps the Chat fallback selected by id when a view is inserted before it', async () => {
    const viewTabs: ViewTab[] = [
      { id: 'chat', label: 'Chat' },
      { id: 'trajectory', label: 'Trajectory' },
    ]
    const b = mount(conversationSnapshot(), undefined, undefined, { viewTabs })
    // A removed dynamic view leaves its persisted id behind. The visible
    // fallback is Chat and must stay Chat when another lower-order view lands.
    act(() => { b.chat.actions.setView('removed-view') })
    expect(b.view.getByTestId('view-chat')).toBeTruthy()

    viewTabs.unshift({ id: 'new-view', label: 'New view' })
    b.rerender()

    expect(b.view.getByTestId('view-chat')).toBeTruthy()
    expect(b.view.queryByTestId('view-new-view')).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: 'Activity' }))
    const activity = b.view.getByRole('dialog', { name: 'Inspect this session' })
    expect(activity).toBeTruthy()
    fireEvent.keyDown(activity, { key: 'Escape' })
    await act(async () => { await Promise.resolve() })
    expect(b.view.queryByRole('dialog', { name: 'Inspect this session' })).toBeNull()
    expect(document.activeElement).toBe(b.view.getByRole('button', { name: 'Activity' }))
    fireEvent.click(b.view.getByRole('button', { name: 'Activity' }))
    fireEvent.click(b.view.getByRole('button', { name: 'New view' }))
    expect(b.view.getByTestId('view-new-view')).toBeTruthy()
    expect(b.view.queryByRole('dialog', { name: 'Inspect this session' })).toBeNull()
  })

  it('keeps Activity open when a nested inspector consumes Escape', async () => {
    const b = mount(conversationSnapshot(), undefined, undefined, {
      activityAction: (
        <div
          role="dialog"
          aria-label="Nested inspector"
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.preventDefault()
          }}
        >
          Nested inspector
        </div>
      ),
    })
    fireEvent.click(b.view.getByRole('button', { name: 'Activity' }))
    const activity = b.view.getByRole('dialog', { name: 'Inspect this session' })
    fireEvent.keyDown(b.view.getByRole('dialog', { name: 'Nested inspector' }), { key: 'Escape' })
    expect(b.view.getByRole('dialog', { name: 'Inspect this session' })).toBe(activity)

    fireEvent.keyDown(activity, { key: 'Escape' })
    await act(async () => { await Promise.resolve() })
    expect(b.view.queryByRole('dialog', { name: 'Inspect this session' })).toBeNull()
    expect(document.activeElement).toBe(b.view.getByRole('button', { name: 'Activity' }))
  })

  it('keeps portaled utility dialogs alive when Activity closes', async () => {
    const b = mount(conversationSnapshot(), undefined, undefined, {
      activityUtility: <PortaledExportAction />,
    })
    const trigger = b.view.getByRole('button', { name: 'Activity' })

    fireEvent.click(trigger)
    const activity = b.view.getByRole('dialog', { name: 'Inspect this session' })
    fireEvent.click(within(activity).getByRole('button', { name: 'Export session' }))
    const dialog = b.view.getByRole('dialog', { name: 'Session export' })

    // The Modal primitive owns Escape for its body portal. Activity must not
    // close first when the React event bubbles through the portal owner.
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await act(async () => { await Promise.resolve() })
    expect(b.view.queryByRole('dialog', { name: 'Session export' })).toBeNull()
    expect(b.view.getByRole('dialog', { name: 'Inspect this session' })).toBe(activity)

    fireEvent.click(within(activity).getByRole('button', { name: 'Export session' }))
    const openDialog = b.view.getByRole('dialog', { name: 'Session export' })
    fireEvent.click(trigger)
    expect(b.view.queryByRole('dialog', { name: 'Inspect this session' })).toBeNull()
    expect(b.view.getByRole('dialog', { name: 'Session export' })).toBe(openDialog)

    fireEvent.click(within(openDialog).getByRole('button', { name: 'Close export' }))
    expect(b.view.queryByRole('dialog', { name: 'Session export' })).toBeNull()
  })

  it('rolls the pending workspace label back when switching fails', async () => {
    const selectWorkspace = vi.fn(async () => { throw new Error('connect failed') })
    const b = mount(
      conversationSnapshot({ composerPhase: 'blank', blank: true }),
      [
        { ...workspace('one'), sessionIds: [SID] },
        { ...workspace('second'), title: 'Selected Folder' },
      ],
      selectWorkspace,
    )
    fireEvent.click(b.view.getByRole('button', { name: 'Choose workspace' }))
    const owner = b.pickerOwner() as { onPick(id: WorkspaceId): void }
    await act(async () => { owner.onPick(wid('second')); await Promise.resolve() })
    expect(selectWorkspace).toHaveBeenCalledWith(wid('second'))
    expect(b.view.queryByText('Selected Folder')).toBeNull()
    expect(b.view.getByText('one')).toBeTruthy()
  })

  it('blank session keeps the interactive picker chip (workspace switchable until the first message)', () => {
    const b = mount(conversationSnapshot({ composerPhase: 'blank', blank: true }))
    const chip = b.view.getByRole('button', { name: 'Choose workspace' })
    expect((chip as HTMLButtonElement).disabled).toBe(false)
    expect(b.slotCalls).toContain('conversation.hero.workspace')
    // The agent-preset chip sits in the same row, for the same reason: both
    // choices are only open before the first message.
    expect(b.slotCalls).toContain('conversation.hero.agentPreset')
  })

  it('prompt failure renders the promptError strip (ordinary failure, no transaction UI)', () => {
    const b = mount(conversationSnapshot({
      promptError: { op: 'send', error: { code: 'offline', message: 'Message send failed' } as never },
    }))
    expect(b.view.getByRole('alert').textContent).toContain('Message send failed (offline)')
    expect(b.view.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})

describe('Activity trigger running-subagent count', () => {
  it('stays absent without a running descendant', () => {
    const b = mount(conversationSnapshot())
    const trigger = b.view.getByRole('button', { name: 'Activity' })
    expect(b.view.queryByText(/subagent running/)).toBeNull()
    // Absent, not empty: the accessibility contract is the null attribute.
    expect(trigger.getAttribute('aria-describedby')).toBeNull()
  })

  it('badges the singular count and describes the Activity control with it', () => {
    const b = mount(conversationSnapshot(), undefined, undefined, {
      descendants: [row('run-1', { parentId: SID, origin: 'subagent', running: true })],
    })
    const trigger = b.view.getByRole('button', { name: 'Activity' })
    const badge = b.view.getByText('1 subagent running')
    expect(trigger.textContent).toContain('1 subagent running')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-describedby')).toBe(badge.id)
  })

  it('badges the plural count while other descendants stay idle', () => {
    const b = mount(conversationSnapshot(), undefined, undefined, {
      descendants: [
        row('run-1', { parentId: SID, origin: 'subagent', running: true }),
        row('run-2', { parentId: SID, origin: 'subagent', running: true }),
        row('idle-1', { parentId: SID, origin: 'subagent' }),
      ],
    })
    expect(b.view.getByText('2 subagents running')).toBeTruthy()
  })

  it('counts a running grandchild reached through subagent lineage', () => {
    const b = mount(conversationSnapshot(), undefined, undefined, {
      descendants: [
        row('mid', { parentId: SID, origin: 'subagent' }),
        row('deep', { parentId: sid('mid'), origin: 'subagent', running: true }),
      ],
    })
    expect(b.view.getByText('1 subagent running')).toBeTruthy()
  })

  it('ignores ordinary forks, other owners, and parentless subagents', () => {
    const b = mount(conversationSnapshot(), undefined, undefined, {
      descendants: [
        row('fork', { parentId: SID }),
        row('fork-child', { parentId: sid('fork'), origin: 'subagent', running: true }),
        row('other-child', { parentId: sid('root'), origin: 'subagent', running: true }),
        row('orphan', { origin: 'subagent', running: true }),
      ],
    })
    expect(b.view.queryByText(/subagent running/)).toBeNull()
  })

  it('does not count the viewed session itself', () => {
    const b = mount(conversationSnapshot(), undefined, undefined, {
      // The viewed child replaces its own list row: a running subagent counts
      // under its parent, never under the session being viewed.
      descendants: [row('s1', { parentId: sid('root'), origin: 'subagent', running: true })],
    })
    const trigger = b.view.getByRole('button', { name: 'Activity' })
    expect(b.view.queryByText(/subagent running/)).toBeNull()
    expect(trigger.getAttribute('aria-describedby')).toBeNull()
  })

  it('drops the badge when the running descendant stops', () => {
    const b = mount(conversationSnapshot(), undefined, undefined, {
      descendants: [row('run-1', { parentId: SID, origin: 'subagent', running: true })],
    })
    expect(b.view.getByText('1 subagent running')).toBeTruthy()

    const stopped = b.sessions.getSnapshot()
    act(() => {
      b.sessions.set({
        ...stopped,
        byId: {
          ...stopped.byId,
          [sid('run-1')]: row('run-1', { parentId: SID, origin: 'subagent' }),
        },
      })
    })
    b.rerender()

    expect(b.view.queryByText(/subagent running/)).toBeNull()
    expect(b.view.getByRole('button', { name: 'Activity' }).getAttribute('aria-describedby')).toBeNull()
  })
})

describe('cross-view inspect handoff', () => {
  const CHAT_KEY = 'shres.conversation.chat'

  it('delivers a pending request only to the view it addresses, and the ack clears it', () => {
    const b = mount(conversationSnapshot())
    const request = { view: 'trajectory', target: { kind: 'call', callId: 'c1' } } as const
    act(() => { b.chat.actions.setInspect(request) })
    // Chat is active: it receives nothing, and the request waits in the store.
    expect(b.lastViewOwner('chat').inspect).toBeNull()
    expect(b.chat.store.getSnapshot().inspect).toEqual(request)

    act(() => { b.chat.actions.setView('trajectory') })
    const owner = b.lastViewOwner('trajectory')
    expect(owner.inspect).toEqual(request)
    act(() => { owner.onInspectDone?.() })
    expect(b.chat.store.getSnapshot().inspect).toBeNull()
    expect(b.lastViewOwner('trajectory').inspect).toBeNull()
  })

  it('hands views reveal and canReveal; reveal selects the addressed view and closes Activity', () => {
    const b = mount(conversationSnapshot())
    fireEvent.click(b.view.getByRole('button', { name: 'Activity' }))
    expect(b.view.getByRole('dialog', { name: 'Inspect this session' })).toBeTruthy()
    const chatOwner = b.lastViewOwner('chat')
    expect(chatOwner.canReveal?.('trajectory')).toBe(true)
    expect(chatOwner.canReveal?.('routing')).toBe(false)

    const request = { view: 'trajectory', target: { kind: 'event', seq: 4 } } as const
    act(() => { chatOwner.reveal?.(request) })
    expect(b.view.queryByRole('dialog', { name: 'Inspect this session' })).toBeNull()
    expect(b.view.getByTestId('view-trajectory')).toBeTruthy()
    expect(b.lastViewOwner('trajectory').inspect).toEqual(request)
  })

  it('reads a persisted legacy { callId } request as a Trajectory call target', () => {
    localStorage.setItem(CHAT_KEY, JSON.stringify({
      selection: null, draft: '', view: 'trajectory', inspect: { callId: 'c1' },
    }))
    const b = mount(conversationSnapshot())
    expect(b.lastViewOwner('trajectory').inspect).toEqual({
      view: 'trajectory', target: { kind: 'call', callId: 'c1' },
    })
  })

  it('reads a malformed persisted request as none', () => {
    localStorage.setItem(CHAT_KEY, JSON.stringify({
      selection: null, draft: '', view: 'trajectory', inspect: { view: 'trajectory', target: { kind: 'call' } },
    }))
    const b = mount(conversationSnapshot())
    expect(b.lastViewOwner('trajectory').inspect).toBeNull()
  })

  it('keeps a persisted open Activity closed at mount without moving focus into it', () => {
    localStorage.setItem(CHAT_KEY, JSON.stringify({
      selection: null, draft: '', view: null, inspect: null, activityOpen: true,
    }))
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    const b = mount(conversationSnapshot())
    expect(b.chat.store.getSnapshot().activityOpen).toBe(false)
    expect(b.view.queryByRole('dialog', { name: 'Inspect this session' })).toBeNull()
    // Composer focus may land afterwards, so assert on every focus call, not the final element.
    const panel = b.view.container.querySelector('#shres-session-activity')
    expect(focus.mock.contexts.some(element => panel?.contains(element as Node) === true)).toBe(false)
    focus.mockRestore()

    // A user open still moves focus into the panel.
    fireEvent.click(b.view.getByRole('button', { name: 'Activity' }))
    expect(panel?.contains(document.activeElement)).toBe(true)
  })

  it('keeps Activity open on a pointer press inside it and closes it on one outside', () => {
    const b = mount(conversationSnapshot())
    fireEvent.click(b.view.getByRole('button', { name: 'Activity' }))
    expect(b.chat.store.getSnapshot().activityOpen).toBe(true)
    fireEvent.pointerDown(b.view.getByRole('dialog', { name: 'Inspect this session' }))
    expect(b.chat.store.getSnapshot().activityOpen).toBe(true)
    fireEvent.pointerDown(document.body)
    expect(b.chat.store.getSnapshot().activityOpen).toBe(false)
    expect(b.view.queryByRole('dialog', { name: 'Inspect this session' })).toBeNull()
  })
})

describe('Session breadcrumbs', () => {
  it('names the session by id while the list has no row for it', () => {
    const b = mount(conversationSnapshot(), undefined, undefined, { omitSummaryRow: true })
    expect(b.view.getByRole('navigation', { name: t('session.hierarchy') }).textContent).toBe('s1')
  })

  it('stops the lineage walk at a subagent cycle', () => {
    const b = mount(conversationSnapshot(), undefined, undefined, {
      summaryOrigin: 'subagent',
      descendants: [row('root', { displayTitle: 'Root', origin: 'subagent', parentId: SID })],
    })
    const crumbs = within(b.view.getByRole('navigation', { name: t('session.hierarchy') }))
    expect(crumbs.getAllByRole('button').map(button => button.textContent)).toEqual(['Root', 'Child'])
  })
})
