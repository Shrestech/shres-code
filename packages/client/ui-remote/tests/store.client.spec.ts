import { describe, expect, it, vi } from 'vitest'
import type { RemoteEntryView, RemoteId, TunnelStateView } from '@shres-code/shres-code-api-remotes/client'
import { BUSY_ADD, busyKey, createRemoteViewStore, dropEntry, upsertEntry } from '../src/client/store.ts'

/** One registry-order fixture entry. */
function entry(alias: string): RemoteEntryView {
  return {
    id: alias as RemoteEntryView['id'],
    target: 'ci@remote.example' as RemoteEntryView['target'],
    remotePort: 3080,
    fingerprint: null,
    lastConnectedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  }
}

/** One committed tunnel-state view. */
function tunnel(alias: string, state: TunnelStateView['state']): TunnelStateView {
  return { alias: alias as RemoteId, state, localPort: state === 'open' ? 4123 : null, version: null, fingerprint: null, error: null, since: '2026-09-01T00:00:00.000Z' }
}

describe('remote view store', () => {
  it('starts empty and notifies subscribers on each committed change', () => {
    const view = createRemoteViewStore()
    expect(view.getSnapshot()).toEqual({
      entries: [], tunnels: {}, degraded: false, folded: false, modal: { phase: 'closed' }, busy: {},
    })
    const listener = vi.fn()
    const dispose = view.subscribe(listener)
    view.setEntries([entry('lab')])
    expect(listener).toHaveBeenCalledOnce()
    dispose()
    view.setDegraded(true)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('mirrors entries, tunnels, degraded, fold, modal, and busy flags', () => {
    const view = createRemoteViewStore()
    view.setEntries([entry('lab')])
    view.applyTunnel(tunnel('lab', 'open'))
    view.setDegraded(true)
    view.setDegraded(false)
    view.setFolded(true)
    view.setModal({ phase: 'inspecting', alias: 'lab' })
    view.setBusy(busyKey('connect', 'lab'), true)
    expect(view.getSnapshot().entries).toHaveLength(1)
    expect(view.getSnapshot().tunnels.lab?.state).toBe('open')
    expect(view.getSnapshot().folded).toBe(true)
    expect(view.getSnapshot().modal).toEqual({ phase: 'inspecting', alias: 'lab' })
    expect(view.getSnapshot().busy[busyKey('connect', 'lab')]).toBe(true)
    // Clearing a busy flag removes the key instead of parking a false.
    view.setBusy(busyKey('connect', 'lab'), false)
    expect(view.getSnapshot().busy[busyKey('connect', 'lab')]).toBeUndefined()
    // A later full-state view for the same alias replaces the earlier one.
    view.applyTunnel(tunnel('lab', 'closed'))
    expect(view.getSnapshot().tunnels.lab?.state).toBe('closed')
  })

  it('keys busy flags per verb and alias, with a bare add key', () => {
    expect(busyKey('connect', 'prod')).toBe('connect:prod')
    expect(busyKey('remove', 'prod')).toBe('remove:prod')
    expect(BUSY_ADD).toBe('add')
  })

  it('upserts registry entries by alias, appending new and replacing known', () => {
    const lab = entry('lab')
    expect(upsertEntry([], lab)).toEqual([lab])
    const labNew = { ...lab, remotePort: 4080 }
    expect(upsertEntry([lab], labNew)).toEqual([labNew])
    const prod = entry('prod')
    expect(upsertEntry([labNew], prod)).toEqual([labNew, prod])
    expect(dropEntry([labNew, prod], 'lab')).toEqual([prod])
    expect(dropEntry([prod], 'missing')).toEqual([prod])
  })
})
