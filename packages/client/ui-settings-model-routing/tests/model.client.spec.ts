import { describe, expect, it } from 'vitest'
import { createModelRoutingController, isAbsent, messageOf } from '../src/client/model.ts'
import { JUDGMENT, LAYA_VIEW, ROUTER, TYPESAFE, namespace, ok, remoteFail, remoteOk, scripted, snapshot } from './fixtures.client.ts'

describe('model routing page controller', () => {
  it('probes only the engine view and marks the dispatcher composed', async () => {
    const s = scripted()
    const controller = createModelRoutingController(s.api, s.remotes)
    expect(controller.store.getSnapshot()).toMatchObject({ availability: 'unknown', status: 'idle', engines: null })

    await controller.probe()

    expect(controller.store.getSnapshot()).toMatchObject({ availability: 'composed', status: 'idle', engines: snapshot() })
    expect(s.describe).not.toHaveBeenCalled()
    expect(s.remotes.layaStatus).not.toHaveBeenCalled()
  })

  it('marks the dispatcher absent on an *-unavailable failure, and keeps availability on any other failure', async () => {
    const s = scripted()
    s.remotes.snapshot.mockResolvedValueOnce(remoteFail('service-unavailable', 'active Service "judgmentEnginesRemote" is unavailable'))
    const controller = createModelRoutingController(s.api, s.remotes)
    await controller.probe()
    expect(controller.store.getSnapshot()).toMatchObject({ availability: 'absent', status: 'error' })

    s.remotes.snapshot.mockResolvedValueOnce(remoteFail('internal', 'boom'))
    await controller.probe()
    expect(controller.store.getSnapshot()).toMatchObject({ availability: 'absent', status: 'error', error: 'boom' })

    s.remotes.snapshot.mockRejectedValueOnce(new Error('socket closed'))
    await controller.probe()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'socket closed' })
    expect(isAbsent('invocation-unavailable')).toBe(true)
    expect(isAbsent('internal')).toBe(false)
    expect(messageOf('plain')).toBe('plain')
  })

  it('loads the engine view, the judgment and model-router sections, and the Laya view', async () => {
    const s = scripted()
    const controller = createModelRoutingController(s.api, s.remotes)

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      availability: 'composed', status: 'ready', error: null, writable: true,
      judgment: JUDGMENT, router: ROUTER, laya: LAYA_VIEW, layaError: null,
    })
  })

  it('skips the Laya view without a laya engine and reports a Laya read failure', async () => {
    const s = scripted({ engines: snapshot([TYPESAFE]), namespaces: [JUDGMENT] })
    const controller = createModelRoutingController(s.api, s.remotes)
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ laya: null, layaError: null, router: null })
    expect(s.remotes.layaStatus).not.toHaveBeenCalled()

    s.remotes.snapshot.mockResolvedValue(remoteOk(snapshot()))
    s.remotes.layaStatus.mockResolvedValueOnce(remoteFail('invocation-unavailable', 'no laya Remote'))
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ laya: null, layaError: 'no laya Remote' })

    s.remotes.layaStatus.mockRejectedValueOnce(new Error('dropped'))
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ laya: null, layaError: 'dropped' })
  })

  it('publishes a settings read failure and a thrown settings read', async () => {
    const s = scripted()
    s.describe.mockResolvedValueOnce({ rpcId: 'x' as never, result: { ok: false, error: { code: 'internal', message: 'store locked', details: {} } } } as never)
    const controller = createModelRoutingController(s.api, s.remotes)
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'store locked' })

    s.describe.mockRejectedValueOnce(new Error('transport'))
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'transport' })
    s.describe.mockRejectedValueOnce('raw')
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'raw' })
  })

  it('stops a load whose engine read failed, and lets a newer read win', async () => {
    const s = scripted()
    s.remotes.snapshot.mockResolvedValueOnce(remoteFail('internal', 'boom'))
    const controller = createModelRoutingController(s.api, s.remotes)
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', judgment: null })

    let release: (() => void) | undefined
    s.remotes.snapshot.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => { resolve(remoteOk(snapshot([TYPESAFE], 'stale'))) }
    }))
    s.remotes.snapshot.mockResolvedValueOnce(remoteFail('internal', 'stale failure'))
    const older = controller.load()
    const olderProbe = controller.probe()
    await controller.load()
    release?.()
    await Promise.all([older, olderProbe])
    expect(controller.store.getSnapshot().engines?.selection.engine).toBe('typesafe')
  })

  it('discards a stale thrown engine read and a stale Laya read', async () => {
    const s = scripted()
    const controller = createModelRoutingController(s.api, s.remotes)
    let rejectOld: ((error: Error) => void) | undefined
    s.remotes.snapshot.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
    const stale = controller.probe()
    await controller.load()
    rejectOld?.(new Error('stale transport failure'))
    await stale
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })

    let releaseLaya: (() => void) | undefined
    s.remotes.layaStatus.mockImplementationOnce(() => new Promise((resolve) => {
      releaseLaya = () => { resolve(remoteOk({ ...LAYA_VIEW, state: 'unavailable', detail: 'stale' })) }
    }))
    const slow = controller.load()
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    await controller.load()
    releaseLaya?.()
    await slow
    expect(controller.store.getSnapshot().laya).toEqual(LAYA_VIEW)
  })

  it('reports an absent judgment section as null', async () => {
    const s = scripted({ namespaces: [ROUTER] })
    const controller = createModelRoutingController(s.api, s.remotes)
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ judgment: null, router: ROUTER })
  })

  it('refreshes by probing before the page loaded, and by loading after', async () => {
    const s = scripted()
    const controller = createModelRoutingController(s.api, s.remotes)
    await controller.refresh()
    expect(s.describe).not.toHaveBeenCalled()
    await controller.load()
    await controller.refresh()
    expect(s.describe).toHaveBeenCalledTimes(2)
  })

  it('writes the engine, classifier, and default mode with the section revision, then re-reads', async () => {
    const s = scripted()
    const controller = createModelRoutingController(s.api, s.remotes)
    await controller.load()

    await expect(controller.selectEngine('laya')).resolves.toBeUndefined()
    await expect(controller.setClassifier(false)).resolves.toBeUndefined()
    await expect(controller.setDefaultMode('on')).resolves.toBeUndefined()

    expect(s.mutate.mock.calls.map(([request]) => request)).toEqual([
      { ns: 'judgment', ops: [{ op: 'set', path: ['engine'], value: 'laya' }], expectedRevision: 4 },
      { ns: 'judgment', ops: [{ op: 'set', path: ['enabled'], value: false }], expectedRevision: 4 },
      { ns: 'model-router', ops: [{ op: 'set', path: ['initialMode'], value: 'on' }], expectedRevision: 7 },
    ])
    expect(s.describe).toHaveBeenCalledTimes(4)
  })

  it('returns a rejected write with the field path an owner named, or its message alone', async () => {
    const s = scripted()
    const controller = createModelRoutingController(s.api, s.remotes)
    s.mutate.mockResolvedValueOnce({ rpcId: 'x' as never, result: { ok: false, error: {
      code: 'settings-rejected', message: 'judgment: engine names engine "gone", which is not composed', details: { ns: 'judgment', path: ['engine'] },
    } } } as never)
    await expect(controller.selectEngine('gone')).resolves.toEqual({ message: 'judgment: engine names engine "gone", which is not composed', path: ['engine'] })
    expect(s.mutate.mock.calls[0]?.[0]).not.toHaveProperty('expectedRevision')

    s.mutate.mockResolvedValueOnce({ rpcId: 'y' as never, result: { ok: false, error: { code: 'settings-rejected', message: 'read-only provider', details: { ns: 'judgment' } } } } as never)
    await expect(controller.setClassifier(true)).resolves.toEqual({ message: 'read-only provider' })
    s.mutate.mockResolvedValueOnce({ rpcId: 'z' as never, result: { ok: false, error: { code: 'settings-conflict', message: 'stale revision', details: {} } } } as never)
    await expect(controller.setDefaultMode('off')).resolves.toEqual({ message: 'stale revision' })
    s.mutate.mockRejectedValueOnce(new Error('offline'))
    await expect(controller.selectEngine('typesafe')).resolves.toEqual({ message: 'offline' })
  })

  it('runs Laya install and restart, publishing the action while it runs and a failure after', async () => {
    const s = scripted()
    const controller = createModelRoutingController(s.api, s.remotes)
    await controller.load()
    const seen: Array<string | null> = []
    controller.store.subscribe(() => { seen.push(controller.store.getSnapshot().layaAction) })

    await controller.runLaya('install')
    expect(s.remotes.layaInstall).toHaveBeenCalledTimes(1)
    expect(seen).toContain('install')
    expect(controller.store.getSnapshot()).toMatchObject({ layaAction: null, layaError: null })

    await controller.runLaya('restart')
    expect(s.remotes.layaRestart).toHaveBeenCalledTimes(1)

    s.remotes.layaInstall.mockResolvedValueOnce(remoteFail('internal', 'uv sync failed (exit 3)'))
    await controller.runLaya('install')
    expect(controller.store.getSnapshot()).toMatchObject({ layaAction: null, layaError: 'uv sync failed (exit 3)' })

    s.remotes.layaRestart.mockRejectedValueOnce(new Error('connection lost'))
    await controller.runLaya('restart')
    expect(controller.store.getSnapshot().layaError).toBe('connection lost')
  })

  it('reads a section value the Host reports as a non-object without failing', async () => {
    const s = scripted({ namespaces: [namespace('judgment', null)] })
    const controller = createModelRoutingController(s.api, s.remotes)
    await controller.load()
    expect(controller.store.getSnapshot().judgment?.value).toBeNull()
    expect(ok(1).result.value).toBe(1)
  })
})
