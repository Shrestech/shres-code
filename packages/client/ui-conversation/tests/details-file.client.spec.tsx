// @vitest-environment jsdom
// DetailsPanel file-viewer branch: a file selection fetches its bounded
// read through the injected face and lands in the pane (loading, text,
// binary, truncation, empty, failure arms), the header offers the native
// hand-off while staying mounted, and a selection swap refetches. The
// selection rides the real chat store; readFile is a per-case stub.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type { FileRead } from '@shres-code/shres-code-client-connection/client'
import type { ConversationSnapshot, SessionListState, SessionId } from '@shres-code/shres-code-client-runtime/client'
import { createSnapshotStore, EMPTY_CONVERSATION_VIEWS } from '@shres-code/shres-code-client-runtime/client'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { createChatStore } from '../src/client/stores.ts'
import { DetailsPanel } from '../src/client/skeleton/DetailsPanel.tsx'
import type { DetailsPanelProps } from '../src/client/skeleton/DetailsPanel.tsx'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  localStorage.clear()
})

const SID = 's1' as SessionId

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: chatSnapshotFixture(), nodes: [],
    turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null, lastAgentError: null,
  }
}

/** Static conversation snapshot source (no live session in these cases). */
function makeSource() {
  const snap: ConversationSnapshot = { ...snapshotBase() }
  const subs = new Set<() => void>()
  return {
    getSnapshot: () => snap,
    subscribe: (fn: () => void) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    update: () => { for (const fn of [...subs]) fn() },
  }
}

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}

function makeHarness() {
  const source = makeSource()
  const chat = createChatStore().create()
  const closeDetails = vi.fn()
  const openNative = vi.fn()
  const readFile = vi.fn<(path: string) => Promise<FileRead>>()
  const props = {
    sessionId: SID,
    useSession: bindSnapshotSelector(source),
    useSessions: emptySessions(),
    useStore: bindSnapshotSelector(chat),
    renderSlot: vi.fn((_key: string, _owner: object, opts?: { fallback?: React.ReactNode }) => opts?.fallback ?? null),
    closeDetails,
    readFile,
    openNative,
    t: makeTranslate(en, commonEn),
  } as unknown as DetailsPanelProps
  const view = render(<DetailsPanel {...props} />)
  return { view, chat, readFile, openNative, closeDetails, source }
}

const okRead = (content: string, over: Partial<FileRead> = {}): FileRead => (
  { content, truncated: false, binary: false, sizeBytes: content.length, ...over }
)

describe('DetailsPanel file viewer', () => {
  it('a file selection loads the text, names it in the header, and offers the native hand-off', async () => {
    const h = makeHarness()
    let releaseRead: (read: FileRead) => void = () => {}
    h.readFile.mockImplementation(() => new Promise<FileRead>((resolve) => { releaseRead = resolve }))
    act(() => { h.chat.actions.select({ kind: 'file', path: 'src/demo.ts' }) })
    await vi.waitFor(() => {
      expect(h.readFile).toHaveBeenCalledWith('src/demo.ts')
    })
    // Loading first, basename title, native chip beside the close button.
    expect(h.view.getByText('demo.ts')).toBeTruthy()
    expect(h.view.getByText('Loading file…')).toBeTruthy()
    expect(h.view.getByText('Open in editor')).toBeTruthy()
    act(() => { releaseRead(okRead('export const n = 1\n')) })
    await vi.waitFor(() => {
      expect(h.view.container.textContent).toContain('export const n = 1')
    })
    // The read card keeps the file's own line numbers.
    expect(h.view.container.textContent).toContain('1')
    expect(h.view.queryByText('Loading file…')).toBeNull()
  })

  it('the native hand-off and close act through the injected callbacks', async () => {
    const h = makeHarness()
    h.readFile.mockResolvedValue(okRead('x\n'))
    act(() => { h.chat.actions.select({ kind: 'file', path: 'a.md' }) })
    await vi.waitFor(() => {
      expect(h.view.container.textContent).toMatch(/1x/)
    })
    fireEvent.click(h.view.getByText('Open in editor'))
    expect(h.openNative).toHaveBeenCalledWith('a.md')
    fireEvent.click(h.view.getByLabelText('Close details'))
    expect(h.closeDetails).toHaveBeenCalledTimes(1)
  })

  it('a failed read lands in the pane with the reason, never as a native open', async () => {
    const h = makeHarness()
    h.readFile.mockRejectedValue(new Error('file read failed: file-unreadable: /x/blocked.txt'))
    act(() => { h.chat.actions.select({ kind: 'file', path: '/x/blocked.txt' }) })
    expect(await h.view.findByText(/Failed to load file/)).toBeTruthy()
    // The pane stays mounted: the native hand-off remains reachable.
    expect(h.view.getByText('Open in editor')).toBeTruthy()
    // Non-Error refusals still render their string form.
    h.readFile.mockRejectedValue('plain refusal')
    act(() => { h.chat.actions.select({ kind: 'file', path: '/x/nope.txt' }) })
    expect(await h.view.findByText('Failed to load file: plain refusal')).toBeTruthy()
  })

  it('binary files decline to render text and recommend the editor', async () => {
    const h = makeHarness()
    h.readFile.mockResolvedValue({ content: '', truncated: false, binary: true, sizeBytes: 4 })
    act(() => { h.chat.actions.select({ kind: 'file', path: 'blob.bin' }) })
    expect(await h.view.findByText('Binary file — open it with the editor instead')).toBeTruthy()
  })

  it('an image type without bytes and not truncated falls back to the binary note, never a broken img', async () => {
    const h = makeHarness()
    // The host never produces this shape, but the viewer must not build a
    // broken data URL from an undefined imageData.
    h.readFile.mockResolvedValue({
      content: '', truncated: false, binary: true, sizeBytes: 4096,
      imageMediaType: 'image/jpeg',
    })
    act(() => { h.chat.actions.select({ kind: 'file', path: 'odd.jpg' }) })
    expect(await h.view.findByText('Binary file — open it with the editor instead')).toBeTruthy()
    expect(h.view.queryByRole('img')).toBeNull()
  })

  it('image reads render the served bytes as an <img> with the byte size', async () => {
    const h = makeHarness()
    const imageData = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')
    h.readFile.mockResolvedValue({
      content: '', truncated: false, binary: true, sizeBytes: 4096,
      imageMediaType: 'image/jpeg', imageData,
    })
    act(() => { h.chat.actions.select({ kind: 'file', path: 'images/image-1.jpg' }) })
    const img = await h.view.findByRole('img')
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,' + imageData)
    expect(img.getAttribute('alt')).toBe('images/image-1.jpg')
    // The byte size renders in the meta line; no binary note, no text block.
    expect(h.view.container.textContent).toContain('4.0 KB')
    expect(h.view.queryByText('Binary file — open it with the editor instead')).toBeNull()
  })

  it('truncated image reads show the cap note with size facts and no <img>', async () => {
    const h = makeHarness()
    h.readFile.mockResolvedValue({
      content: '', truncated: true, binary: true, sizeBytes: 2000000,
      imageMediaType: 'image/jpeg',
    })
    act(() => { h.chat.actions.select({ kind: 'file', path: 'big.jpg' }) })
    expect(await h.view.findByText(/Image exceeds the view cap/)).toBeTruthy()
    expect(h.view.container.textContent).toContain('2000000 bytes')
    // A partial JPEG must never render as a corrupt half image.
    expect(h.view.queryByRole('img')).toBeNull()
  })

  it('truncated reads show the notice above the served slice', async () => {
    const h = makeHarness()
    h.readFile.mockResolvedValue(okRead('abc', { truncated: true, sizeBytes: 900_000 }))
    act(() => { h.chat.actions.select({ kind: 'file', path: 'big.md' }) })
    expect(await h.view.findByText('Large file — showing the beginning only')).toBeTruthy()
    await vi.waitFor(() => {
      expect(h.view.container.textContent).toContain('abc')
    })
  })

  it('empty files get their own note instead of an empty block', async () => {
    const h = makeHarness()
    h.readFile.mockResolvedValue(okRead(''))
    act(() => { h.chat.actions.select({ kind: 'file', path: 'blank.log' }) })
    expect(await h.view.findByText('Empty file')).toBeTruthy()
  })

  it('a selection swap drops the stale in-flight read and refetches', async () => {
    const h = makeHarness()
    let releaseFirst: (read: FileRead) => void = () => {}
    h.readFile.mockImplementationOnce(() => new Promise<FileRead>((resolve) => { releaseFirst = resolve }))
    act(() => { h.chat.actions.select({ kind: 'file', path: 'one.ts' }) })
    await vi.waitFor(() => {
      expect(h.readFile).toHaveBeenCalledWith('one.ts')
    })
    // Swap before the first read lands: its late resolution must be ignored.
    h.readFile.mockResolvedValue(okRead('second\n'))
    act(() => { h.chat.actions.select({ kind: 'file', path: 'two.ts' }) })
    await vi.waitFor(() => {
      expect(h.readFile).toHaveBeenNthCalledWith(2, 'two.ts')
    })
    await vi.waitFor(() => {
      expect(h.view.container.textContent).toContain('second')
    })
    act(() => { releaseFirst(okRead('first\n')) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.view.container.textContent).toContain('second')
    expect(h.readFile).toHaveBeenCalledTimes(2)
  })
})
