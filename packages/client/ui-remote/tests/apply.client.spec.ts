// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import type { RemoteEntryView, TunnelStateView } from '@shres-code/shres-code-api-remotes/client'
import type { RemotesSectionProps } from '../src/client/RemotesSection.tsx'
import type { RemoteInjected } from '../src/client/RemotesSection.tsx'
import { apply, inject } from '../src/client/index.ts'
import { RemotesSection } from '../src/client/RemotesSection.tsx'

/** Wire-ok envelope. */
const ok = <T>(value: T) => ({ ok: true as const, value })
/** Wire-error envelope (the Gateway's message-only failure shape). */
const err = (code: string, message: string) => ({ ok: false as const, error: { code, message } })

function entry(alias: string): RemoteEntryView {
  return {
    id: alias as RemoteEntryView['id'],
    target: `ci@${alias}.remote.example` as RemoteEntryView['target'],
    remotePort: 3080,
    fingerprint: null,
    lastConnectedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  }
}

function tunnelView(alias: string, state: TunnelStateView['state']): TunnelStateView {
  return {
    alias: alias as TunnelStateView['alias'],
    state,
    localPort: state === 'open' ? 4123 : null,
    version: null,
    fingerprint: null,
    error: null,
    since: '2026-09-01T00:00:00.000Z',
  }
}

/** The ctx.remote double: namespace methods plus the forwarded-event seat. */
function fakeRemote() {
  return {
    $on: vi.fn((_name: string, _listener: (...args: never[]) => void) => () => {}),
    remoteControl: {
      list: vi.fn(async () => ok({ entries: [entry('lab'), entry('prod')] })),
    },
    remoteAdmin: {
      status: vi.fn(async () => ok({ tunnels: [tunnelView('prod', 'open')] })),
      begin: vi.fn(async () => ok({ token: 'tok', expiresAt: '2026-09-01T00:02:00.000Z' })),
      inspect: vi.fn(async () => ok({
        target: 'ci@prod.remote.example',
        daemonVersion: '0.1.0-rc.5',
        installed: true,
        installationId: 'abcdef1234567890abcdef',
        localVersion: '0.1.0-rc.5',
        firstConnect: true,
        trustedFingerprint: null,
      })),
      connect: vi.fn(async () => ok({
        status: 'connected',
        localPort: 4123,
        version: '0.1.0-rc.5',
        fingerprint: 'abcdef1234567890abcdef',
      })),
      disconnect: vi.fn(async () => ok({ state: 'closed' })),
      add: vi.fn(async () => ok({ entry: entry('newremote') })),
      edit: vi.fn(async () => ok({ entry: { ...entry('prod'), remotePort: 4080 } })),
      removeEntry: vi.fn(async () => ok({ status: 'removed', removed: true })),
    },
  }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const remote = fakeRemote()
  ctx.provide('remote', remote as never)
  ctx.provide('remote.remoteControl', remote.remoteControl as never)
  ctx.provide('remote.remoteAdmin', remote.remoteAdmin as never)
  window.open = vi.fn()
  return { ctx, remote, locale }
}

/** Declare the shell hole and mount the plugin; returns the injected face. */
async function mount(b: Awaited<ReturnType<typeof bench>>) {
  b.ctx.slots.register({ name: 'root', children: { 'sidebar.remotes': { kind: 'single', scope: 'root' } } } as never, () => null)
  await b.ctx.plugin({ inject: [...inject], apply }).await()
  const registered = b.ctx.slots.entries('sidebar.remotes')[0]!
  const injected = (registered.inject as () => RemoteInjected)()
  return { registered, injected }
}

/** The tunnel-state listener apply subscribed. */
function tunnelListener(b: Awaited<ReturnType<typeof bench>>): (view: TunnelStateView) => void {
  const call = b.remote.$on.mock.calls.find(([name]) => name === 'remote-control/tunnel-state')
  if (call === undefined) throw new Error('tunnel-state subscription missing')
  return call[1] as unknown as (view: TunnelStateView) => void
}

describe('ui-remote apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.remoteControl', 'remote.remoteAdmin'])
  })

  it('registers the section into the declared shell hole with its locale', async () => {
    const b = await bench()
    const { registered } = await mount(b)
    expect(registered.component).toBe(RemotesSection)
    expect(registered.locale).toBe('remote')
    expect(b.locale.bind('remote')('section.remotes')).toBe('Remotes')
  })

  it('seeds both mirrors from the initial reads and the pushed tunnel state', async () => {
    const b = await bench()
    const { injected } = await mount(b)
    expect(b.remote.remoteControl.list).toHaveBeenCalledOnce()
    expect(b.remote.remoteAdmin.status).toHaveBeenCalledOnce()
    const snapshot = injected.hooks.view.getSnapshot()
    expect(snapshot.entries.map(candidate => candidate.id)).toEqual(['lab', 'prod'])
    expect(snapshot.tunnels.prod?.state).toBe('open')
    expect(snapshot.degraded).toBe(false)

    // A committed transition reconciles the mirror; an open re-reads the registry.
    tunnelListener(b)(tunnelView('lab', 'open'))
    expect(injected.hooks.view.getSnapshot().tunnels.lab?.state).toBe('open')
    expect(b.remote.remoteControl.list).toHaveBeenCalledTimes(2)
    // A closed transition reconciles without a registry re-read.
    tunnelListener(b)(tunnelView('lab', 'closed'))
    expect(injected.hooks.view.getSnapshot().tunnels.lab?.state).toBe('closed')
    expect(b.remote.remoteControl.list).toHaveBeenCalledTimes(2)
  })

  it('degrades the group when either read is refused (LAN-served GUI)', async () => {
    const b = await bench()
    b.remote.remoteControl.list.mockResolvedValue(err('forbidden', 'loopback only') as never)
    const { injected } = await mount(b)
    const snapshot = injected.hooks.view.getSnapshot()
    expect(snapshot.degraded).toBe(true)
    expect(snapshot.entries).toEqual([])

    // A status refusal degrades too; a later clean list recovers.
    const second = await bench()
    second.remote.remoteAdmin.status.mockResolvedValue(err('forbidden', 'loopback only') as never)
    const { injected: secondInjected } = await mount(second)
    expect(secondInjected.hooks.view.getSnapshot().degraded).toBe(true)
  })

  it('resyncs both mirrors on a connection reset', async () => {
    const b = await bench()
    await mount(b)
    const calls = b.remote.remoteControl.list.mock.calls.length
    const statusCalls = b.remote.remoteAdmin.status.mock.calls.length
    ;(b.ctx.emit as (name: string) => void)('connection/reset')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(b.remote.remoteControl.list.mock.calls.length).toBe(calls + 1)
    expect(b.remote.remoteAdmin.status.mock.calls.length).toBe(statusCalls + 1)
  })

  it('connect: inspect opens the confirm modal; a refused read fails it', async () => {
    const b = await bench()
    const { injected } = await mount(b)
    await injected.connect('prod')
    expect(b.remote.remoteAdmin.inspect).toHaveBeenCalledWith({ alias: 'prod' })
    const modal = injected.hooks.view.getSnapshot().modal
    expect(modal.phase).toBe('confirm')
    if (modal.phase !== 'confirm') throw new Error('unreachable')
    expect(modal.inspect.target).toBe('ci@prod.remote.example')

    b.remote.remoteAdmin.inspect.mockResolvedValue(err('unreachable', 'probe failed') as never)
    await injected.connect('prod')
    expect(injected.hooks.view.getSnapshot().modal).toEqual({ phase: 'failed', alias: 'prod', message: 'probe failed' })
  })

  it('confirmConnect spends one granted connect and hands the origin to a new tab', async () => {
    const b = await bench()
    const { injected } = await mount(b)
    await injected.connect('prod')
    await injected.confirmConnect('prod', { allowVersionSkew: false, forceFingerprint: false })
    expect(b.remote.remoteAdmin.begin).toHaveBeenCalledWith({ verb: 'connect', alias: 'prod' })
    expect(b.remote.remoteAdmin.connect).toHaveBeenCalledWith({
      token: 'tok', alias: 'prod', allowVersionSkew: false, forceFingerprint: false,
    })
    expect(window.open).toHaveBeenCalledWith('http://127.0.0.1:4123/', '_blank', 'noopener')
    const snapshot = injected.hooks.view.getSnapshot()
    expect(snapshot.modal.phase).toBe('closed')
    expect(snapshot.tunnels.prod?.state).toBe('open')
    // The busy flag cleared.
    expect(snapshot.busy['connect:prod']).toBeUndefined()
  })

  it('confirmConnect re-enters confirm carrying a version-mismatch outcome', async () => {
    const b = await bench()
    b.remote.remoteAdmin.connect.mockResolvedValue(ok({ status: 'version-mismatch', observed: '9.8.7', local: '0.1.0-rc.5' }) as never)
    const { injected } = await mount(b)
    // Modal closed: the re-entry path must re-inspect to rebuild the body.
    await injected.confirmConnect('prod', { allowVersionSkew: false, forceFingerprint: false })
    const modal = injected.hooks.view.getSnapshot().modal
    expect(modal.phase).toBe('confirm')
    if (modal.phase !== 'confirm') throw new Error('unreachable')
    expect(modal.outcome).toEqual({ status: 'version-mismatch', observed: '9.8.7', local: '0.1.0-rc.5' })
    expect(b.remote.remoteAdmin.inspect).toHaveBeenCalledWith({ alias: 'prod' })
  })

  it('confirmConnect re-enters confirm reusing the body when the modal stayed open', async () => {
    const b = await bench()
    b.remote.remoteAdmin.connect.mockResolvedValue(ok({ status: 'fingerprint-mismatch', observed: 'abcdef', trusted: '111111' }) as never)
    const { injected } = await mount(b)
    await injected.connect('prod')
    const inspectCalls = b.remote.remoteAdmin.inspect.mock.calls.length
    await injected.confirmConnect('prod', { allowVersionSkew: false, forceFingerprint: false })
    expect(b.remote.remoteAdmin.inspect.mock.calls.length).toBe(inspectCalls)
    const modal = injected.hooks.view.getSnapshot().modal
    expect(modal.phase).toBe('confirm')
    if (modal.phase !== 'confirm') throw new Error('unreachable')
    expect(modal.outcome).toEqual({ status: 'fingerprint-mismatch', observed: 'abcdef', trusted: '111111' })
  })

  it('confirmConnect maps an unreachable outcome to the failed phase', async () => {
    const b = await bench()
    b.remote.remoteAdmin.connect.mockResolvedValue(ok({ status: 'unreachable', stage: 'tunnel', message: 'forward refused' }) as never)
    const { injected } = await mount(b)
    await injected.connect('prod')
    await injected.confirmConnect('prod', { allowVersionSkew: true, forceFingerprint: false })
    expect(injected.hooks.view.getSnapshot().modal).toEqual({ phase: 'failed', alias: 'prod', message: 'forward refused' })
  })

  it('confirmConnect renders a wire failure (expired grant) in the failed phase', async () => {
    const b = await bench()
    b.remote.remoteAdmin.begin.mockResolvedValue(err('gesture-refused', 'token expired') as never)
    const { injected } = await mount(b)
    await injected.connect('prod')
    await injected.confirmConnect('prod', { allowVersionSkew: false, forceFingerprint: false })
    expect(injected.hooks.view.getSnapshot().modal).toEqual({ phase: 'failed', alias: 'prod', message: 'gesture-refused: token expired' })
  })

  it('disconnect spends the grant, clears the mirror, and reports wire failures', async () => {
    const b = await bench()
    const { injected } = await mount(b)
    await injected.disconnect('prod')
    expect(b.remote.remoteAdmin.begin).toHaveBeenCalledWith({ verb: 'disconnect', alias: 'prod' })
    expect(injected.hooks.view.getSnapshot().tunnels.prod?.state).toBe('closed')

    b.remote.remoteAdmin.begin.mockResolvedValue(err('gesture-refused', 'token expired') as never)
    await injected.disconnect('prod')
    expect(injected.hooks.view.getSnapshot().modal).toEqual({ phase: 'failed', alias: 'prod', message: 'gesture-refused: token expired' })
    // A not-connected answer changes nothing and throws nothing.
    b.remote.remoteAdmin.begin.mockResolvedValue(ok({ token: 'tok', expiresAt: 'x' }) as never)
    b.remote.remoteAdmin.disconnect.mockResolvedValue(ok({ state: 'not-connected' }))
    await injected.disconnect('prod')
    expect(injected.hooks.view.getSnapshot().tunnels.prod?.state).toBe('closed')
  })

  it('add inserts into the mirror; edit rewrites in place; both report wire failures', async () => {
    const b = await bench()
    const { injected } = await mount(b)
    const added = await injected.addRemote({ alias: 'newremote', target: 'ci@new.remote.example', remotePort: 3080 })
    expect(added.ok).toBe(true)
    expect(b.remote.remoteAdmin.begin).toHaveBeenCalledWith({ verb: 'add', alias: null })
    expect(injected.hooks.view.getSnapshot().entries.map(candidate => candidate.id)).toContain('newremote')

    const edited = await injected.editRemote('prod', { alias: 'prod', target: 'ci@prod.remote.example', remotePort: 4080 })
    expect(edited.ok).toBe(true)
    expect(injected.hooks.view.getSnapshot().entries.find(candidate => candidate.id === 'prod')?.remotePort).toBe(4080)

    b.remote.remoteAdmin.add.mockResolvedValue(err('invalid-alias', 'bad alias') as never)
    const refused = await injected.addRemote({ alias: 'BAD', target: 'x@y', remotePort: 1 })
    expect(refused).toEqual({ ok: false, message: 'bad alias' })
  })

  it('remove reports done, refused-while-connected, and wire failures', async () => {
    const b = await bench()
    const { injected } = await mount(b)
    expect(await injected.removeRemote('lab')).toEqual({ ok: true, removed: true })
    expect(b.remote.remoteAdmin.begin).toHaveBeenCalledWith({ verb: 'removeEntry', alias: 'lab' })
    expect(injected.hooks.view.getSnapshot().entries.map(candidate => candidate.id)).not.toContain('lab')

    b.remote.remoteAdmin.removeEntry.mockResolvedValue(ok({ status: 'connected' }) as never)
    expect(await injected.removeRemote('lab')).toEqual({ ok: false, kind: 'connected' })

    b.remote.remoteAdmin.begin.mockResolvedValue(err('gesture-refused', 'token expired') as never)
    expect(await injected.removeRemote('lab')).toEqual({ ok: false, kind: 'error', message: 'gesture-refused: token expired' })
  })

  it('confirmConnect fails when the re-inspect after a decision outcome is refused', async () => {
    const b = await bench()
    b.remote.remoteAdmin.connect.mockResolvedValue(ok({ status: 'version-mismatch', observed: '9.8.7', local: '0.1.0-rc.5' }) as never)
    b.remote.remoteAdmin.inspect.mockResolvedValue(err('unreachable', 'probe failed') as never)
    const { injected } = await mount(b)
    await injected.confirmConnect('prod', { allowVersionSkew: false, forceFingerprint: false })
    expect(injected.hooks.view.getSnapshot().modal).toEqual({ phase: 'failed', alias: 'prod', message: 'probe failed' })
  })

  it('openTab, cancelModal, and setFolded drive the local faces', async () => {
    const b = await bench()
    const { injected } = await mount(b)
    injected.openTab(4123)
    expect(window.open).toHaveBeenCalledWith('http://127.0.0.1:4123/', '_blank', 'noopener')
    injected.setFolded(true)
    expect(injected.hooks.view.getSnapshot().folded).toBe(true)
    await injected.connect('prod')
    injected.cancelModal()
    expect(injected.hooks.view.getSnapshot().modal.phase).toBe('closed')
  })

  it('add and edit catch thrown failures and edit reports a wire error', async () => {
    const b = await bench()
    const { injected } = await mount(b)
    b.remote.remoteAdmin.begin.mockRejectedValue('boom')
    expect(await injected.addRemote({ alias: 'x', target: 'ci@x.remote.example', remotePort: 3080 }))
      .toEqual({ ok: false, message: 'boom' })
    expect(await injected.editRemote('prod', { alias: 'prod', target: 'ci@prod.remote.example', remotePort: 4080 }))
      .toEqual({ ok: false, message: 'boom' })

    b.remote.remoteAdmin.begin.mockResolvedValue(ok({ token: 'tok', expiresAt: 'x' }) as never)
    b.remote.remoteAdmin.edit.mockResolvedValue(err('invalid-target', 'bad target') as never)
    expect(await injected.editRemote('prod', { alias: 'prod', target: 'ci@prod.remote.example', remotePort: 4080 }))
      .toEqual({ ok: false, message: 'bad target' })
  })

  it('exposes exactly the injected face the section consumes', async () => {
    const b = await bench()
    const { injected } = await mount(b)
    const face = Object.keys(injected).sort()
    expect(face).toEqual(['addRemote', 'cancelModal', 'confirmConnect', 'connect', 'disconnect', 'editRemote', 'hooks', 'openTab', 'removeRemote', 'setFolded'])
  })
})

// The section props type derives from this package's contract; keep the spec
// honest about the shape the renderer composes.
type SectionPropsCheck = RemotesSectionProps['wide'] extends boolean ? true : never
const sectionPropsCheck: SectionPropsCheck = true
void sectionPropsCheck
