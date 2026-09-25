// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginAdminConfirmOutcome,
  PluginAdminInstallOutcome,
  PluginAdminRemoveOutcome,
  PluginAdminStatusResult,
  PluginConfirmToken,
  PluginGestureToken,
  SkillInstallOutcome,
  SkillRemoveOutcome,
} from '@shres-code/shres-code-api-remotes/client'
import { PluginManageSettingsTab } from '../src/client/PluginManageSettingsTab.tsx'
import type {
  PluginManageSettingsTabInjected,
  PluginManageSettingsTabProps,
} from '../src/client/PluginManageSettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: PluginInventoryLocaleKey): string => en[key]) as PluginManageSettingsTabProps['t']

const STATUS: PluginAdminStatusResult = {
  mutations: 'enabled',
  plugins: [
    { name: '@fixture/hello', version: '1.0.0', state: 'active', removable: true },
    { name: '@fixture/added', state: 'installed-restart-required', removable: true },
    { name: '@fixture/removed', version: '2.0.0', state: 'removed-restart-required', removable: false },
  ],
  skills: [
    { name: 'greet', description: 'Says hello', digest: 'd1', origin: '/orig/greet', installedAt: '2026-01-01T00:00:00Z' },
    { name: 'meet', description: 'Shadowed one', digest: 'd2', origin: '/orig/meet', installedAt: '2026-01-01T00:00:00Z', shadowedBy: 'user' },
  ],
}

const PREVIEW = {
  spec: '/tmp/plugin-hello',
  name: '@fixture/plugin-hello',
  version: '0.1.0',
  source: 'path',
  clientHalf: false,
  addedPackages: ['@fixture/dep-one', '@fixture/dep-two'],
}

const ROLLBACK = { filesRestored: true, reinstall: 'skipped' } as const

/** A fake branded gesture token for a test double. */
const gestureToken = (value: string): PluginGestureToken => value as PluginGestureToken
/** A fake branded confirm token for a test double. */
const confirmToken = (value: string): PluginConfirmToken => value as PluginConfirmToken
/** Core refusal carried by a refused install outcome. */
type InstallRefusal = Extract<PluginAdminInstallOutcome, { kind: 'refused' }>['refusal']

/** A parked install outcome carrying fake branded ids. */
function parkedOutcome(confirmTokenValue: string = 'confirm-1', previewOverrides: Record<string, unknown> = {}): PluginAdminInstallOutcome {
  return {
    kind: 'parked',
    transactionId: 'tx-1',
    preview: { ...PREVIEW, ...previewOverrides },
    confirmToken: confirmToken(confirmTokenValue),
  } as unknown as PluginAdminInstallOutcome
}

/** Injected face with neutral defaults; each test overrides the operation it drives. */
function face(overrides: Partial<PluginManageSettingsTabInjected> = {}): PluginManageSettingsTabInjected {
  return {
    status: () => Promise.resolve(STATUS),
    begin: () => Promise.resolve({ token: gestureToken('tok-1'), expiresAt: '2026-01-01T00:02:00Z' }),
    install: () => Promise.resolve({ kind: 'refused', refusal: { code: 'declined' }, rollback: ROLLBACK }),
    confirm: () => Promise.resolve({ kind: 'committed', name: PREVIEW.name, version: PREVIEW.version, readiness: 'restart-required' }),
    cancel: () => Promise.resolve({ filesRestored: true, reinstall: 'skipped' }),
    remove: () => Promise.resolve({ kind: 'removed', pnpm: 'ok' }),
    skillAdd: () => Promise.resolve({ kind: 'installed', name: 'greet', path: '/orig/greet', digest: 'd1' }),
    skillRemove: () => Promise.resolve({ kind: 'removed' }),
    ...overrides,
  }
}

function props(overrides?: Partial<PluginManageSettingsTabInjected>): PluginManageSettingsTabProps {
  return { t, ...face(overrides) } as PluginManageSettingsTabProps
}

/** Mount and wait for the ready view. */
async function renderReady(overrides?: Partial<PluginManageSettingsTabInjected>, status?: Partial<PluginAdminStatusResult>) {
  const merged = { ...STATUS, ...status }
  const statusFn = vi.fn(face().status).mockResolvedValue(merged)
  const view = render(<PluginManageSettingsTab {...props({ ...overrides, status: statusFn })} />)
  await screen.findByText(en.pluginsHeading)
  return { view, statusFn }
}

/** Drive one install into its parked preview. */
async function parkPreview(overrides: Partial<PluginManageSettingsTabInjected> = {}, previewOverrides: Record<string, unknown> = {}) {
  const install = vi.fn(face().install).mockResolvedValue(parkedOutcome('confirm-1', previewOverrides))
  await renderReady({ ...overrides, install })
  fireEvent.change(screen.getByLabelText(en.specLabel), { target: { value: PREVIEW.spec } })
  fireEvent.click(screen.getByRole('button', { name: en.installAction }))
  await screen.findByText(en.previewHeading)
  return { install }
}

describe('PluginManageSettingsTab', () => {
  it('renders the loading state and recovers from a failed read through retry', async () => {
    const deferred = Promise.withResolvers<PluginAdminStatusResult>()
    const status = vi.fn<PluginManageSettingsTabInjected['status']>()
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValueOnce(STATUS)
    const view = render(<PluginManageSettingsTab {...props({ status })} />)
    expect(screen.getByText(en.loading)).toBeTruthy()

    await act(async () => { deferred.reject(new Error('down')) })
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)

    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await screen.findByText(en.pluginsHeading)
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    view.unmount()
  })

  it('renders plugin restart states, the restart banner, and skills with shadowing', async () => {
    const { view } = await renderReady()
    expect(screen.getByText(en.restartRequiredBanner)).toBeTruthy()
    const addedRow = screen.getByText('@fixture/added').closest('li')!
    expect(addedRow.getAttribute('data-plugin-state')).toBe('installed-restart-required')
    expect(addedRow.textContent).toBe(`@fixture/added${en.stateInstalledRestart}${en.removeAction}`)
    expect(screen.getByText(en.stateActive)).toBeTruthy()
    expect(screen.getByText(en.stateRemovedRestart)).toBeTruthy()
    expect(screen.getByText(`${en.skillShadowedBy} user`)).toBeTruthy()
    expect(screen.getByText('Says hello')).toBeTruthy()
    view.unmount()
  })

  it('renders the host capability notice in unsupported mode and keeps skill operations', async () => {
    const { view } = await renderReady({}, { mutations: 'unsupported' })
    expect(screen.getByText(en.unsupported)).toBeTruthy()
    expect(screen.queryByText(en.installHeading)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove: @fixture/hello' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove: greet' })).toBeTruthy()
    expect(screen.getByText(`${en.skillShadowedBy} user`)).toBeTruthy()
    view.unmount()
  })

  it('offers Remove only for rows the status reports removable', async () => {
    const { view } = await renderReady({}, {
      plugins: [
        { name: '@fixture/hello', version: '1.0.0', state: 'active', removable: true },
        { name: '@shres-code/shres-code-base', version: '1.0.0', state: 'active', removable: false },
      ],
    })
    expect(screen.getByRole('button', { name: 'Remove: @fixture/hello' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove: @shres-code/shres-code-base' })).toBeNull()
    view.unmount()
  })

  it('shows empty sections without rows', async () => {
    const { view } = await renderReady({}, { plugins: [], skills: [] })
    expect(screen.getByText(en.pluginsEmpty)).toBeTruthy()
    expect(screen.getByText(en.skillsEmpty)).toBeTruthy()
    expect(screen.queryByText(en.restartRequiredBanner)).toBeNull()
    view.unmount()
  })

  it('parks an install, previews it, and confirms into a restart receipt', async () => {
    const { install } = await parkPreview()
    expect(install).toHaveBeenCalledOnce()
    expect(screen.getByText(PREVIEW.spec)).toBeTruthy()
    expect(screen.getByText(`${PREVIEW.name} ${PREVIEW.version}`)).toBeTruthy()
    expect(screen.getByText(PREVIEW.source)).toBeTruthy()
    expect(screen.getByText('@fixture/dep-one, @fixture/dep-two')).toBeTruthy()
    expect(screen.queryByText(en.previewClientHalf)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.confirmAction }))
    expect(screen.getByRole('button', { name: en.confirmBusyAction })).toBeTruthy()
    expect(await screen.findByText(en.installedNotice)).toBeTruthy()
    expect(screen.getByText(`${PREVIEW.name} ${PREVIEW.version}`)).toBeTruthy()
    expect(screen.queryByText(en.previewHeading)).toBeNull()
  })

  it('renders a refused confirm through the shared refusal copy', async () => {
    const confirm = vi.fn(face().confirm).mockResolvedValue({ kind: 'refused', refusal: { code: 'compose-failed', detail: 'entry missing' }, rollback: ROLLBACK })
    const { view } = await renderReady({
      install: vi.fn(face().install).mockResolvedValue(parkedOutcome('c1')),
      confirm,
    })
    fireEvent.change(screen.getByLabelText(en.specLabel), { target: { value: PREVIEW.spec } })
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    await screen.findByText(en.previewHeading)
    fireEvent.click(screen.getByRole('button', { name: en.confirmAction }))
    expect(await screen.findByText(en.refuseComposeFailed)).toBeTruthy()
    expect(screen.getByText('entry missing')).toBeTruthy()
    expect(screen.queryByText(en.previewHeading)).toBeNull()
    view.unmount()
  })

  it('previews an empty dependency list and a browser half', async () => {
    await parkPreview({}, { addedPackages: [], clientHalf: true })
    expect(screen.getByText(en.previewAddsNone)).toBeTruthy()
    expect(screen.getByText(en.previewClientHalf)).toBeTruthy()
  })

  it('reports a parked transaction from status without confirm or cancel controls', async () => {
    await renderReady({}, {
      parked: { transactionId: 'tx-remote', preview: { ...PREVIEW, clientHalf: true } },
    } as Partial<PluginAdminStatusResult>)
    expect(screen.getByText(en.parkedElsewhere)).toBeTruthy()
    expect(screen.getByText(PREVIEW.spec)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.confirmAction })).toBeNull()
    expect(screen.queryByRole('button', { name: en.cancelAction })).toBeNull()
  })

  it('renders every install refusal with its specifics', async () => {
    const refusals: { refusal: InstallRefusal; copy: string; detail?: string }[] = [
      { refusal: { code: 'pnpm-not-found' }, copy: en.refusePnpmNotFound },
      { refusal: { code: 'pnpm-failed', detail: 'exit 1: unreachable store' }, copy: en.refusePnpmFailed, detail: 'exit 1: unreachable store' },
      { refusal: { code: 'needs-build', detail: '@fixture/one, @fixture/two' }, copy: en.refuseNeedsBuild, detail: '@fixture/one, @fixture/two' },
      { refusal: { code: 'foreign-dsh', detail: '@fixture/dsh' }, copy: en.refuseForeignManifest, detail: '@fixture/dsh' },
      { refusal: { code: 'not-a-bundle', detail: '@fixture/plain' }, copy: en.refuseNotBundle, detail: '@fixture/plain' },
      { refusal: { code: 'already-active', detail: '@fixture/hello' }, copy: en.refuseAlreadyActive, detail: '@fixture/hello' },
      { refusal: { code: 'link-spec' }, copy: en.refuseLinkSpec },
      { refusal: { code: 'compose-failed', detail: 'entry missing' }, copy: en.refuseComposeFailed, detail: 'entry missing' },
      { refusal: { code: 'declined' }, copy: en.refuseDeclined },
      { refusal: { code: 'unsupported-platform' }, copy: en.refuseUnsupportedPlatform },
      { refusal: { code: 'invalid-spec', detail: 'not a package name or directory' }, copy: en.refuseInvalidSpec, detail: 'not a package name or directory' },
      {
        refusal: { code: 'unsupported-layout', nodeLinker: 'isolated', detail: 'uses the isolated linker' },
        copy: en.refuseUnsupportedLayout, detail: 'uses the isolated linker',
      },
    ]
    for (const { refusal, copy, detail } of refusals) {
      const install = vi.fn(face().install)
        .mockResolvedValue({ kind: 'refused', refusal, rollback: ROLLBACK })
      const { view } = await renderReady({ install })
      fireEvent.change(screen.getByLabelText(en.specLabel), { target: { value: PREVIEW.spec } })
      fireEvent.click(screen.getByRole('button', { name: en.installAction }))
      expect(await screen.findByText(copy)).toBeTruthy()
      expect(screen.getByRole('alert').textContent).toContain(detail ?? copy)
      expect(view.container.querySelector('pre')).toBeNull()
      view.unmount()
    }
  })

  it('cancels a parked install with clean and dirty rollback copy', async () => {
    const { view } = await renderReady()
    const install = vi.fn(face().install).mockResolvedValue(parkedOutcome())
    const cancel = vi.fn(face().cancel).mockResolvedValue({ filesRestored: true, reinstall: 'skipped' })
    view.rerender(<PluginManageSettingsTab {...props({ install, cancel })} />)
    fireEvent.change(screen.getByLabelText(en.specLabel), { target: { value: PREVIEW.spec } })
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    await screen.findByText(en.previewHeading)
    fireEvent.click(screen.getByRole('button', { name: en.cancelAction }))
    expect(await screen.findByText(en.installCancelledNotice)).toBeTruthy()

    const dirty = vi.fn(face().cancel).mockResolvedValue({ filesRestored: true, reinstall: 'failed', detail: 'store pruned' })
    view.rerender(<PluginManageSettingsTab {...props({ install, cancel: dirty })} />)
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    await screen.findByText(en.previewHeading)
    fireEvent.click(screen.getByRole('button', { name: en.cancelAction }))
    expect(await screen.findByText(en.installCancelledDirtyNotice)).toBeTruthy()
    expect(screen.getByText('store pruned')).toBeTruthy()
  })

  it('removes plugins with ok, failed, and refused outcomes', async () => {
    const { view, statusFn } = await renderReady({
      remove: vi.fn(face().remove).mockResolvedValueOnce({ kind: 'removed', pnpm: 'ok' })
        .mockResolvedValueOnce({ kind: 'removed', pnpm: 'failed', detail: 'EBUSY' })
        .mockResolvedValueOnce({ kind: 'refused', code: 'not-installed' })
        .mockResolvedValueOnce({ kind: 'refused', code: 'template-bundle' })
        .mockResolvedValueOnce({ kind: 'refused', code: 'unsupported-platform' }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove: @fixture/hello' }))
    expect(await screen.findByText(en.removeDoneNotice)).toBeTruthy()
    expect(screen.getByText(en.removeDoneNotice).parentElement!.textContent).toContain('@fixture/hello')
    await waitFor(() => { expect(statusFn).toHaveBeenCalledTimes(2) })

    fireEvent.click(screen.getByRole('button', { name: 'Remove: @fixture/hello' }))
    expect(await screen.findByText(en.removeDirtyNotice)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove: @fixture/hello' }))
    expect(await screen.findByText(en.refuseNotInstalled)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove: @fixture/hello' }))
    expect(await screen.findByText(en.refuseTemplateBundle)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove: @fixture/hello' }))
    expect(await screen.findByText(en.refuseUnsupportedPlatform)).toBeTruthy()
    view.unmount()
  })

  it('adds and removes skills with refusals', async () => {
    const skillAdd = vi.fn(face().skillAdd)
      .mockResolvedValueOnce({ kind: 'installed', name: 'greet', path: '/orig/greet', digest: 'd1' })
      .mockResolvedValueOnce({ kind: 'refused', code: 'invalid-skill', detail: 'no frontmatter' })
      .mockResolvedValueOnce({ kind: 'refused', code: 'name-taken', detail: 'user skill "greet" is already live', owner: 'user' })
      .mockResolvedValueOnce({ kind: 'refused', code: 'escaping-symlink', detail: 'SKILL.md leaves the directory' })
    const skillRemove = vi.fn(face().skillRemove)
      .mockResolvedValueOnce({ kind: 'removed' })
      .mockResolvedValueOnce({ kind: 'refused', code: 'not-installed' })
      .mockResolvedValueOnce({ kind: 'refused', code: 'not-managed' })
    const { view, statusFn } = await renderReady({ skillAdd, skillRemove })

    fireEvent.change(screen.getByLabelText(en.skillPathLabel), { target: { value: '/orig/greet' } })
    fireEvent.click(screen.getByRole('button', { name: en.skillAddAction }))
    expect(await screen.findByText(en.skillAddedNotice)).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.skillPathLabel).value).toBe('')
    await waitFor(() => { expect(statusFn).toHaveBeenCalledTimes(2) })

    for (const copy of [en.skillRefuseInvalid, en.skillRefuseNameTaken, en.skillRefuseEscapingSymlink]) {
      fireEvent.change(screen.getByLabelText(en.skillPathLabel), { target: { value: '/orig/greet' } })
      fireEvent.click(screen.getByRole('button', { name: en.skillAddAction }))
      expect(await screen.findByText(copy)).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('button', { name: 'Remove: greet' }))
    expect(await screen.findByText(en.skillRemovedNotice)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove: greet' }))
    expect(await screen.findByText(en.skillRefuseNotInstalled)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove: greet' }))
    expect(await screen.findByText(en.skillRefuseNotManaged)).toBeTruthy()
    view.unmount()
  })

  it('keeps an empty install spec or skill path inert', async () => {
    const begin = vi.fn(face().begin)
    const { view } = await renderReady({ begin })
    fireEvent.submit(screen.getByText(en.installHeading).closest('section')!.querySelector('form')!)
    fireEvent.submit(screen.getByText(en.skillAddHeading).closest('section')!.querySelector('form')!)
    expect(begin).not.toHaveBeenCalled()
    view.unmount()
  })

  it('blocks duplicate operations while one is in flight', async () => {
    const deferred = Promise.withResolvers<PluginAdminInstallOutcome>()
    const install = vi.fn(face().install).mockReturnValue(deferred.promise)
    const begin = vi.fn(face().begin)
    const skillAdd = vi.fn(face().skillAdd)
    const { view } = await renderReady({ install, begin, skillAdd })
    fireEvent.change(screen.getByLabelText(en.specLabel), { target: { value: PREVIEW.spec } })
    fireEvent.change(screen.getByLabelText(en.skillPathLabel), { target: { value: '/orig/greet' } })
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    expect(screen.getByRole('button', { name: en.installBusyAction })).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.specLabel).disabled).toBe(true)

    // A second gesture through form submit while one operation is in flight is
    // dropped by the single-flight guard, not by button disabling alone.
    fireEvent.submit(screen.getByText(en.skillAddHeading).closest('section')!.querySelector('form')!)
    expect(skillAdd).not.toHaveBeenCalled()
    expect(begin).toHaveBeenCalledTimes(1)
    view.unmount()
    await act(async () => { deferred.resolve({ kind: 'refused', refusal: { code: 'declined' }, rollback: ROLLBACK }) })
  })

  it('reports transport failures generically', async () => {
    const begin = vi.fn(face().begin).mockRejectedValue(new Error('gesture-refused: replay'))
    const { view } = await renderReady({ begin })
    fireEvent.change(screen.getByLabelText(en.specLabel), { target: { value: PREVIEW.spec } })
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    expect(await screen.findByText(en.opFailedNotice)).toBeTruthy()
    expect(screen.queryByText('gesture-refused')).toBeNull()
    view.unmount()
  })

  it('reports an explicit unsupported outcome with the unsupported-host copy', async () => {
    const install = vi.fn(face().install).mockResolvedValue({ kind: 'unsupported' })
    const remove = vi.fn(face().remove).mockResolvedValue({ kind: 'unsupported' })
    const { view } = await renderReady({ install, remove })
    fireEvent.change(screen.getByLabelText(en.specLabel), { target: { value: PREVIEW.spec } })
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    expect(await screen.findByText(en.unsupported)).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove: @fixture/hello' }))
    expect(await screen.findByText(en.unsupported)).toBeTruthy()
    view.unmount()
  })

  it('drops settled outcomes after unmount without starting new work', async () => {
    // Status resolution and rejection after unmount.
    const statusDeferred = Promise.withResolvers<PluginAdminStatusResult>()
    const statusView = render(<PluginManageSettingsTab {...props({ status: () => statusDeferred.promise })} />)
    statusView.unmount()
    await act(async () => { statusDeferred.resolve(STATUS) })

    const statusReject = Promise.withResolvers<PluginAdminStatusResult>()
    const statusRejectView = render(<PluginManageSettingsTab {...props({ status: () => statusReject.promise })} />)
    statusRejectView.unmount()
    await act(async () => { statusReject.reject(new Error('late')) })

    // Install.
    const installDeferred = Promise.withResolvers<PluginAdminInstallOutcome>()
    const installView = render(<PluginManageSettingsTab {...props({ install: () => installDeferred.promise })} />)
    await screen.findByText(en.installHeading)
    fireEvent.change(screen.getByLabelText(en.specLabel), { target: { value: PREVIEW.spec } })
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    installView.unmount()
    await act(async () => { installDeferred.resolve(parkedOutcome('c1')) })

    // Confirm and cancel from a parked preview.
    const confirmDeferred = Promise.withResolvers<PluginAdminConfirmOutcome>()
    const parkedView = render(<PluginManageSettingsTab {...props({
      install: () => Promise.resolve(parkedOutcome('c1')),
      confirm: () => confirmDeferred.promise,
    })} />)
    await screen.findByText(en.installHeading)
    fireEvent.change(screen.getByLabelText(en.specLabel), { target: { value: PREVIEW.spec } })
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    await screen.findByText(en.previewHeading)
    fireEvent.click(screen.getByRole('button', { name: en.confirmAction }))
    parkedView.unmount()
    await act(async () => { confirmDeferred.resolve({ kind: 'committed', name: PREVIEW.name, version: PREVIEW.version, readiness: 'restart-required' }) })

    const cancelDeferred = Promise.withResolvers<{ filesRestored: true; reinstall: 'ok' | 'failed' | 'skipped'; detail?: string }>()
    const cancelView = render(<PluginManageSettingsTab {...props({
      install: () => Promise.resolve(parkedOutcome('c1')),
      cancel: () => cancelDeferred.promise,
    })} />)
    await screen.findByText(en.installHeading)
    fireEvent.change(screen.getByLabelText(en.specLabel), { target: { value: PREVIEW.spec } })
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    await screen.findByText(en.previewHeading)
    fireEvent.click(screen.getByRole('button', { name: en.cancelAction }))
    cancelView.unmount()
    await act(async () => { cancelDeferred.resolve({ filesRestored: true, reinstall: 'skipped' }) })

    // Remove: a resolution and a late rejection after unmount.
    const removeDeferred = Promise.withResolvers<PluginAdminRemoveOutcome>()
    const removeView = render(<PluginManageSettingsTab {...props({ remove: () => removeDeferred.promise })} />)
    await screen.findByText(en.installHeading)
    fireEvent.click(screen.getByRole('button', { name: 'Remove: @fixture/hello' }))
    removeView.unmount()
    await act(async () => { removeDeferred.resolve({ kind: 'removed', pnpm: 'ok' }) })

    const removeReject = Promise.withResolvers<PluginAdminRemoveOutcome>()
    const removeRejectView = render(<PluginManageSettingsTab {...props({ remove: () => removeReject.promise })} />)
    await screen.findByText(en.installHeading)
    fireEvent.click(screen.getByRole('button', { name: 'Remove: @fixture/hello' }))
    removeRejectView.unmount()
    await act(async () => { removeReject.reject(new Error('late')) })

    // Skill add and remove.
    const skillAddDeferred = Promise.withResolvers<SkillInstallOutcome>()
    const addView = render(<PluginManageSettingsTab {...props({ skillAdd: () => skillAddDeferred.promise })} />)
    await screen.findByText(en.installHeading)
    fireEvent.change(screen.getByLabelText(en.skillPathLabel), { target: { value: '/orig/greet' } })
    fireEvent.click(screen.getByRole('button', { name: en.skillAddAction }))
    addView.unmount()
    await act(async () => { skillAddDeferred.resolve({ kind: 'installed', name: 'greet', path: '/orig/greet', digest: 'd1' }) })

    const skillRemoveDeferred = Promise.withResolvers<SkillRemoveOutcome>()
    const removeSkillView = render(<PluginManageSettingsTab {...props({ skillRemove: () => skillRemoveDeferred.promise })} />)
    await screen.findByText(en.installHeading)
    fireEvent.click(screen.getByRole('button', { name: 'Remove: greet' }))
    removeSkillView.unmount()
    await act(async () => { skillRemoveDeferred.resolve({ kind: 'removed' }) })

    // No banner from any dropped outcome: a fresh mount shows the plain ready view.
    await renderReady()
    expect(screen.queryByText(en.installedNotice)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
