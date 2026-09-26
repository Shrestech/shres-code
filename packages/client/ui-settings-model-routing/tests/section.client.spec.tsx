// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import { ModelRoutingSection } from '../src/client/ModelRoutingSection.tsx'
import type { ModelRoutingController } from '../src/client/model.ts'
import { createModelRoutingController } from '../src/client/model.ts'
import { createOverviewController } from '../src/client/overview.ts'
import { en } from '../src/client/locales.ts'
import { GATE, LAYA, LAYA_VIEW, TYPESAFE, namespace, remoteFail, remoteOk, scripted, snapshot } from './fixtures.client.ts'
import { double, ready, t } from './helpers.client.tsx'

afterEach(cleanup)

/** Resolve a key the way the locale runtime does, filling {name} placeholders. */
function t(key: keyof typeof en, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name]))
}

/** Session list and workspace hooks over an empty client: no workspace, so the overview reads nothing. */
const useSessions = bindSnapshotSelector(createSnapshotStore({ current: undefined, byId: {} })) as never
const useWorkspaces = bindSnapshotSelector(createSnapshotStore({ items: [], recentWorkspaceId: undefined })) as never

/** Render the page over one controller. */
function mount(controller: ModelRoutingController) {
  const overview = createOverviewController(() => new Promise(() => {}))
  return render(
    <ModelRoutingSection
      controller={controller}
      overview={overview}
      useSnapshot={bindSnapshotSelector(controller.store)}
      useOverview={bindSnapshotSelector(overview.store)}
      t={t as never}
      close={() => {}}
      useSessions={useSessions}
      useWorkspaces={useWorkspaces}
    />,
  )
}

describe('Settings › Model routing page', () => {
  it('loads on mount and shows the scope, a loading line, and a failure with retry', async () => {
    const loading = double(ready({ status: 'loading', engines: null, judgment: null, router: null, laya: null }))
    mount(loading)
    expect(loading.load).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en.scope)).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    cleanup()

    const failed = double(ready({ status: 'error', error: 'settings are locked', engines: null, judgment: null, router: null, laya: null }))
    mount(failed)
    expect(screen.getByRole('alert').textContent).toContain('Model routing settings could not be read: settings are locked')
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(failed.load).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('group', { name: en.layaName })).toBeNull()
  })

  it('lists every engine with its egress, selects it, and shows the selected engine\'s status, egress, model ids, and calibration', () => {
    mount(double(ready()))
    const select = screen.getByRole('combobox', { name: en.engineLabel }) as HTMLSelectElement
    expect([...select.options].map(option => option.textContent)).toEqual(['Jev (TypeSafe) — remote', 'Laya (local MLX) — local'])
    expect(select.value).toBe('typesafe')
    expect(screen.getByText(en.stateReady)).toBeTruthy()
    expect(screen.getAllByText(en.egressRemote).map(pill => pill.getAttribute('title'))).toEqual([en.egressRemoteTitle, en.egressRemoteTitle])
    expect(screen.getByText('fast jev-1.13.0-fast · accurate jev-1.13.0')).toBeTruthy()
    const consumers = screen.getByRole('list', { name: en.consumersGroup })
    const row = within(consumers).getByText('model-router').closest('li') as HTMLElement
    expect(within(row).getByText('Jev (TypeSafe)')).toBeTruthy()
    expect(within(row).getByText(en.consumerSelected)).toBeTruthy()
    expect(within(row).getByText(en.uncalibratedGlobal).getAttribute('title')).toBe(en.uncalibratedGlobalTitle)
  })

  it('warns that the router sends conversation excerpts to a remote engine, bounded by the router state cap', () => {
    mount(double(ready()))
    const warning = screen.getByRole('note')
    expect(within(warning).getByText(en.remoteWarningLead)).toBeTruthy()
    expect(within(warning).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'model-router asks Jev (TypeSafe) at api.typesafe.ai: each routing consult, in a session with routing on, sends up to 12,000 characters of that conversation.',
    ])
    expect(within(warning).getByText(en.remoteWarningTail)).toBeTruthy()
    cleanup()
    mount(double(ready({ router: null, engines: snapshot([{ ...TYPESAFE, destination: undefined } as never]) })))
    expect(within(screen.getByRole('note')).getByRole('listitem').textContent)
      .toBe('model-router asks Jev (TypeSafe) at a host off this machine: each routing consult, in a session with routing on, sends part of that conversation.')
  })

  it('warns about every consumer an override sends to a remote engine while the selected engine is local', () => {
    // A consumer's override applies while it is declared, exactly as the dispatcher selects its engine.
    const probe = snapshot([TYPESAFE, { ...LAYA, state: 'ready', detail: undefined } as never], 'laya', {
      overrides: { 'worker-escalation': 'typesafe', 'model-router': 'typesafe' },
      consumers: ['model-router', 'worker-escalation'],
    })
    mount(double(ready({ engines: probe })))

    expect(screen.queryByText(en.localNote)).toBeNull()
    const warning = screen.getByRole('note')
    expect(within(warning).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'model-router asks Jev (TypeSafe) at api.typesafe.ai: each routing consult, in a session with routing on, sends up to 12,000 characters of that conversation.',
      'worker-escalation asks Jev (TypeSafe) at api.typesafe.ai: every ask sends the state this consumer judges, whatever the session\'s routing mode.',
    ])
    const rows = within(screen.getByRole('list', { name: en.consumersGroup })).getAllByRole('listitem')
    expect(rows.map(row => within(row).queryByText(en.consumerOverride) !== null)).toEqual([true, true])
    expect(within(rows[0] as HTMLElement).getByText(en.egressRemote)).toBeTruthy()
  })

  it('warns about a remote non-router consumer without the routing tail, and bounds a fitting remote engine by its alternatives', () => {
    const lanShield = { ...LAYA, id: 'shield', label: 'Shield (LAN gateway)', egress: 'remote', destination: '192.168.1.20:8787', state: 'ready', detail: undefined } as never
    mount(double(ready({ engines: snapshot([TYPESAFE, LAYA, lanShield], 'laya', {
      overrides: { 'compaction-jev': 'typesafe', 'model-router': 'shield' },
      consumers: ['compaction-jev', 'model-router'],
    }) })))
    expect(within(screen.getByRole('note')).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'compaction-jev asks Jev (TypeSafe) at api.typesafe.ai: every ask sends the state this consumer judges, whatever the session\'s routing mode.',
      'model-router asks Shield (LAN gateway) at 192.168.1.20:8787: each routing consult, in a session with routing on, sends up to 4 alternative excerpts of that conversation, each at most 12,000 characters.',
    ])
    cleanup()
    mount(double(ready({ engines: snapshot([TYPESAFE, LAYA], 'laya', {
      overrides: { 'compaction-jev': 'typesafe' },
      consumers: ['compaction-jev', 'model-router'],
    }) })))
    expect(within(screen.getByRole('note')).getAllByRole('listitem')).toHaveLength(1)
    expect(within(screen.getByRole('note')).queryByText(en.remoteWarningTail)).toBeNull()
  })

  it('says why nothing leaves: the classifier is off, no consumer is composed, or every consumer asks a local engine', () => {
    mount(double(ready({ engines: snapshot(undefined, 'typesafe', { enabled: false }) })))
    expect(screen.getByText(en.egressOff)).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
    cleanup()
    mount(double(ready({ engines: snapshot(undefined, 'typesafe', { consumers: [] }) })))
    expect(screen.getByText(en.egressNoConsumers)).toBeTruthy()
    expect(screen.queryByRole('list', { name: en.consumersGroup })).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('lists an override naming an engine that is not composed, and an override the dispatcher ignores', () => {
    mount(double(ready({ engines: snapshot([TYPESAFE, LAYA], 'laya', {
      overrides: { 'model-router': 'gone', 'judgment-guardrails': 'typesafe' },
      consumers: ['model-router'],
    }) })))
    const row = within(screen.getByRole('list', { name: en.consumersGroup })).getByRole('listitem')
    expect(row.textContent).toContain('engine "gone" is not composed, so its asks fail')
    expect(screen.getByText('The override for judgment-guardrails names typesafe and is ignored: no such consumer is composed.')).toBeTruthy()
    expect(screen.getByText(en.localNote)).toBeTruthy()
    cleanup()
    mount(double(ready({ engines: snapshot([TYPESAFE], 'typesafe', { overrides: { 'judgment-guardrails': 'typesafe' }, consumers: [] }) })))
    expect(screen.queryByRole('list', { name: en.consumersGroup })).toBeNull()
    expect(screen.getByText(/The override for judgment-guardrails/)).toBeTruthy()
  })

  it('shows how the router gates the engine it asks, as its gate read reports that engine', () => {
    const judge = { ...TYPESAFE, id: 'llm', label: 'LLM judge', calibration: 'verbalized', egress: 'none', destination: undefined } as never
    const badge = (calibration: unknown, engine = 'laya'): HTMLElement => {
      const gate = { ...GATE, engines: [{ engine, calibration }] } as never
      mount(double(ready({ gate, engines: snapshot([TYPESAFE, { ...LAYA, state: 'ready', detail: undefined } as never, judge], engine) })))
      const row = within(screen.getByRole('list', { name: en.consumersGroup })).getByRole('listitem')
      const found = within(row).getAllByText(/Calibrated|Uncalibrated|Not used for routing/)[0] as HTMLElement
      cleanup()
      return found
    }
    const calibrated = badge({ kind: 'calibrated', by: 'routing-eval-2026-09' })
    expect(calibrated.textContent).toBe('Calibrated (routing-eval-2026-09)')
    expect(calibrated.getAttribute('title')).toBe('Routing gates this engine\'s answers with the operating point routing-eval-2026-09 evaluated.')
    expect(badge({ kind: 'point' }).textContent).toBe(en.uncalibratedPoint)
    expect(badge({ kind: 'global' }).textContent).toBe(en.uncalibratedGlobal)
    expect(badge({ kind: 'refused' }, 'llm').textContent).toBe(en.routingRefused)
    // The page reads the router's own answer: no gate, or no entry for the engine, shows no badge.
    mount(double(ready({ gate: null })))
    expect(screen.queryByText(/Uncalibrated|Calibrated|Not used for routing/)).toBeNull()
    cleanup()
    mount(double(ready({ gate: { ...GATE, engines: [] } })))
    expect(screen.queryByText(/Uncalibrated|Calibrated|Not used for routing/)).toBeNull()
  })

  it('omits the model id of an engine whose provider names none', () => {
    const { models: _models, ...bare } = TYPESAFE
    mount(double(ready({ laya: null, engines: snapshot([bare]) })))
    expect(screen.queryByText(/jev-1\.13\.0/)).toBeNull()
    expect(screen.getAllByText(en.egressRemote)).toHaveLength(2)
  })

  it('shows a local engine as local, and says nothing leaves when every consumer asks a local engine', () => {
    mount(double(ready({ engines: snapshot([TYPESAFE, { ...LAYA, state: 'ready', detail: undefined } as never], 'laya') })))
    expect(screen.getAllByText(en.egressLocal).map(pill => pill.getAttribute('title'))).toEqual([en.egressLocalTitle, en.egressLocalTitle])
    expect(screen.getByText(en.localNote)).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.getAllByText(LAYA_VIEW.modelId).length).toBeGreaterThan(0)
  })

  it('shows each engine state with its detail, and marks an engine that needs another host', () => {
    for (const [state, label] of [
      ['starting', en.stateStarting], ['unavailable', en.stateUnavailable], ['unconfigured', en.stateUnconfigured],
      ['not-installed', en.stateNotInstalled], ['unsupported-host', en.stateUnsupportedHost],
    ] as const) {
      mount(double(ready({ laya: null, engines: snapshot([{ ...TYPESAFE, state, detail: `detail of ${state}` }]) })))
      expect(screen.getByTitle(`detail of ${state}`).textContent).toBe(label)
      expect(screen.getByText(`detail of ${state}`)).toBeTruthy()
      cleanup()
    }
    mount(double(ready({ engines: snapshot([TYPESAFE, { ...LAYA, runsOnThisHost: false }]) })))
    const option = screen.getByRole('option', { name: 'Laya (local MLX) — needs darwin-arm64' }) as HTMLOptionElement
    expect(option.disabled).toBe(true)
  })

  it('says so when no engine is composed, and when the selected engine is not composed', () => {
    mount(double(ready({ laya: null, engines: snapshot([]) })))
    expect(screen.getByRole('status').textContent).toBe(en.noEngines)
    expect(screen.queryByRole('combobox', { name: en.engineLabel })).toBeNull()
    cleanup()
    mount(double(ready({ laya: null, engines: snapshot([TYPESAFE], 'gone') })))
    expect(screen.getByRole('combobox', { name: en.engineLabel })).toHaveProperty('value', 'gone')
    expect(screen.getByText('The selected engine "gone" is not composed; every judgment fails until it is, and routing keeps the strong model.')).toBeTruthy()
  })

  it('writes a selection and shows a rejected write next to the selector with its field', async () => {
    const controller = double(ready(), { selectEngine: { message: 'judgment: engine "laya" requires darwin-arm64', path: ['engine'] } })
    mount(controller)
    fireEvent.change(screen.getByRole('combobox', { name: en.engineLabel }), { target: { value: 'laya' } })
    expect(controller.selectEngine).toHaveBeenCalledWith('laya')
    expect(screen.getByText(en.engineSaving)).toBeTruthy()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('engine: judgment: engine "laya" requires darwin-arm64')
    expect(screen.getByRole('combobox', { name: en.engineLabel }).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('combobox', { name: en.engineLabel }).getAttribute('aria-describedby')).toBe(alert.id)
  })

  it('shows an unnamed rejection by its message and clears it on a later successful write', async () => {
    const controller = double(ready())
    controller.selectEngine.mockResolvedValueOnce({ message: 'stale revision' })
    mount(controller)
    fireEvent.change(screen.getByRole('combobox', { name: en.engineLabel }), { target: { value: 'laya' } })
    expect((await screen.findByRole('alert')).textContent).toBe('stale revision')
    fireEvent.change(screen.getByRole('combobox', { name: en.engineLabel }), { target: { value: 'laya' } })
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })

  it('installs Laya when it is not installed, and restarts or reinstalls it after a confirmation', () => {
    const controller = double(ready())
    mount(controller)
    const row = screen.getByRole('group', { name: en.layaName })
    expect(within(row).getByText(en.stateNotInstalled)).toBeTruthy()
    expect(within(row).getByText('1,024 tokens')).toBeTruthy()
    expect(within(row).getByText(en.layaRuntime)).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: en.layaInstall }))
    expect(controller.runLaya).toHaveBeenCalledWith('install')
    cleanup()

    const installed = double(ready({ laya: { ...LAYA_VIEW, state: 'ready', detail: undefined } as never }))
    mount(installed)
    const readyRow = screen.getByRole('group', { name: en.layaName })
    fireEvent.click(within(readyRow).getByRole('button', { name: en.layaRestart }))
    expect(installed.runLaya).toHaveBeenLastCalledWith('restart')
    fireEvent.click(within(readyRow).getByRole('button', { name: en.layaReinstall }))
    const confirm = screen.getByRole('alertdialog', { name: en.layaReinstall })
    expect(confirm.textContent).toContain(en.layaConfirm)
    fireEvent.click(within(confirm).getByRole('button', { name: en.layaCancel }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(within(readyRow).getByRole('button', { name: en.layaReinstall }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en.layaConfirmAction }))
    expect(installed.runLaya).toHaveBeenLastCalledWith('install')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows a running Laya action, the last exit, and a Laya failure', () => {
    mount(double(ready({ layaAction: 'install', laya: { ...LAYA_VIEW, installing: true } })))
    expect(screen.getByText(en.layaInstalling)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.layaInstall })).toHaveProperty('disabled', true)
    cleanup()
    mount(double(ready({ layaAction: 'restart', layaError: 'uv sync failed (exit 3)', laya: {
      ...LAYA_VIEW, state: 'unavailable', detail: 'restart budget exhausted; run /laya restart',
      lastExit: { exitCode: null, signal: 'SIGTERM', timedOut: true },
    } })))
    expect(screen.getByText(en.layaRestarting)).toBeTruthy()
    expect(screen.getByText('Last exit: SIGTERM after the startup deadline.')).toBeTruthy()
    expect(screen.getByText('restart budget exhausted; run /laya restart')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Laya: uv sync failed (exit 3)')
    cleanup()
    mount(double(ready({ laya: { ...LAYA_VIEW, state: 'stopped', detail: 'stopped for install', lastExit: { exitCode: 4, signal: null, timedOut: false } } })))
    expect(screen.getByText('Last exit: code 4.')).toBeTruthy()
    expect(screen.getByText(en.stateStopped)).toBeTruthy()
    cleanup()
    mount(double(ready({ laya: null, layaError: 'no laya Remote' })))
    expect(screen.getByRole('group', { name: en.layaName }).textContent).toContain(en.layaName)
    expect(screen.queryByRole('button', { name: en.layaRestart })).toBeNull()
  })

  it('writes the default mode for new sessions and shows a rejection', async () => {
    const controller = double(ready(), { setDefaultMode: { message: 'model-router: candidates must be non-empty' } })
    mount(controller)
    const group = screen.getByRole('radiogroup', { name: en.modeGroup })
    expect(within(group).getByRole('radio', { name: en.modeOff }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(group).getByRole('radio', { name: en.modeOff }))
    expect(controller.setDefaultMode).not.toHaveBeenCalled()
    fireEvent.click(within(group).getByRole('radio', { name: en.modeOn }))
    expect(controller.setDefaultMode).toHaveBeenCalledWith('on')
    expect((await screen.findByRole('alert')).textContent).toBe('model-router: candidates must be non-empty')
    cleanup()
    mount(double(ready({ router: namespace('model-router', { initialMode: 'on' }) })))
    expect(screen.getByRole('radio', { name: en.modeOn }).getAttribute('aria-checked')).toBe('true')
  })

  it('switches the classifier, explains the off state, and shows a rejection', async () => {
    const controller = double(ready(), { setClassifier: { message: 'read-only provider' } })
    mount(controller)
    const toggle = screen.getByRole('switch', { name: en.classifierDisable })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(en.classifierOn)).toBeTruthy()
    fireEvent.click(toggle)
    expect(controller.setClassifier).toHaveBeenCalledWith(false)
    expect((await screen.findByRole('alert')).textContent).toBe('read-only provider')
    cleanup()
    mount(double(ready({ judgment: namespace('judgment', { enabled: false, engine: 'typesafe' }) })))
    expect(screen.getByRole('switch', { name: en.classifierEnable }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(en.classifierOffMeans)).toBeTruthy()
  })

  it('disables every write and says why when the settings file is read-only, and omits cards the Host does not expose', () => {
    mount(double(ready({ writable: false })))
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en.engineLabel })).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
    expect(screen.getByRole('radio', { name: en.modeOn })).toHaveProperty('disabled', true)
    cleanup()
    mount(double(ready({ router: null, judgment: null })))
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    cleanup()
    mount(double(ready({ router: null })))
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByRole('switch')).toBeTruthy()
    cleanup()
    mount(double(ready({ judgment: null, judgmentValue: undefined } as never)))
    expect(screen.getByRole('radiogroup', { name: en.modeGroup })).toBeTruthy()
  })

  it('shows a routing read failure above the pool editor', () => {
    mount(double(ready({ routingError: 'pool socket closed' })))
    expect(screen.getByRole('alert').textContent).toBe('Routing details could not be read: pool socket closed')
  })

  it('renders a real controller end to end: the engine switch changes the egress badge', async () => {
    const s = scripted()
    const controller = createModelRoutingController(s.api, s.remotes)
    mount(controller)
    await screen.findByRole('note')
    expect(screen.getAllByText(en.egressRemote)).toHaveLength(2)
    s.remotes.snapshot.mockResolvedValue(remoteOk(snapshot([TYPESAFE, { ...LAYA, state: 'ready', detail: undefined } as never], 'laya')))
    fireEvent.change(screen.getByRole('combobox', { name: en.engineLabel }), { target: { value: 'laya' } })
    await screen.findByText(en.localNote)
    expect(screen.getAllByText(en.egressLocal)).toHaveLength(2)
    expect(screen.queryByText(en.egressRemote)).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
    expect(s.mutate.mock.calls[0]?.[0]).toMatchObject({ ns: 'judgment', ops: [{ op: 'set', path: ['engine'], value: 'laya' }] })
    void act
    void remoteFail
  })
})
