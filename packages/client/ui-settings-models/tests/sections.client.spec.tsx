// @vitest-environment jsdom
/** Team and Audio section wrappers over the shared settings controller. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse, SettingsNamespaceView } from '@shres-code/shres-code-api-remotes/client'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import { AudioSection } from '../src/client/AudioSection.tsx'
import { TeamSection } from '../src/client/TeamSection.tsx'
import type { ModelsSettingsState, ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const unusedHook = (() => { throw new Error('unused standard hook') }) as never

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `section-${nextRpc++}` as never, result: { ok: true, value } }
}

function namespace(ns: string, value: unknown = {}): SettingsNamespaceView {
  return {
    ns,
    schema: {},
    value,
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

function state(overrides: Partial<ModelsSettingsState> = {}): ModelsSettingsState {
  return {
    status: 'ready',
    error: null,
    credentialError: null,
    writable: true,
    rows: [],
    namespaces: new Map(),
    hasUserDefaultModel: false,
    ...overrides,
  }
}

function controllerFor(initial: ModelsSettingsState): { controller: ModelsSettingsStore; load: () => Promise<void> } {
  const load = vi.fn(() => Promise.resolve())
  return {
    controller: {
      store: createSnapshotStore(initial),
      load,
    } as unknown as ModelsSettingsStore,
    load,
  }
}

function teamApi() {
  return {
    settings: { mutate: vi.fn(() => Promise.resolve(ok({}))) },
    credentials: { describe: vi.fn(() => Promise.resolve(ok({ credentials: {} }))) },
    llm: {
      providers: vi.fn(),
      models: vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] }))),
    },
  }
}

function audioApi() {
  return {
    settings: { mutate: vi.fn(() => Promise.resolve(ok({}))) },
    credentials: { describe: vi.fn(() => Promise.resolve(ok({ credentials: {} }))) },
    llm: { providers: vi.fn(), models: vi.fn(), discoverModels: vi.fn() },
  }
}

function teamProps(initial: ModelsSettingsState = state()) {
  const { controller, load } = controllerFor(initial)
  const api = teamApi()
  return {
    controller,
    load,
    useSnapshot: bindSnapshotSelector(controller.store),
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    api: api as never,
    t: (key: keyof typeof en): string => en[key],
    close: vi.fn(),
  }
}

function audioProps(initial: ModelsSettingsState = state()) {
  const { controller, load } = controllerFor(initial)
  const api = audioApi()
  const renderSlot = vi.fn(() => <div data-testid="audio-preference-row">Voice preference</div>)
  return {
    controller,
    load,
    useSnapshot: bindSnapshotSelector(controller.store),
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    api: api as never,
    t: (key: keyof typeof en): string => en[key],
    close: vi.fn(),
    renderSlot: renderSlot as never,
    apiFace: api,
  }
}

describe('TeamSection', () => {
  it('loads an idle shared store and shows the loading state', () => {
    const props = teamProps(state({ status: 'idle' }))
    render(<TeamSection {...props} />)
    expect(props.load).toHaveBeenCalled()
    expect(screen.getByText(en.loading)).toBeTruthy()
  })

  it('reports a failed shared load with a retry action', () => {
    const props = teamProps(state({ status: 'error', error: 'offline' }))
    render(<TeamSection {...props} />)
    expect(screen.getByText(`${en.loadFailed}: offline`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(props.load).toHaveBeenCalled()
  })

  it('explains when the roster namespace is not composed', () => {
    const props = teamProps()
    render(<TeamSection {...props} />)
    expect(screen.getByRole('status').textContent).toBe(en.teamsUnavailable)
  })

  it('renders the roster over the shared join and requests its model catalog', async () => {
    const props = teamProps(state({ namespaces: new Map([['agent-seats', namespace('agent-seats')]]) }))
    render(<TeamSection {...props} />)
    expect(screen.getByText(en.seatsTitle)).toBeTruthy()
    await waitFor(() => { expect((props.api as ReturnType<typeof teamApi>).llm.models).toHaveBeenCalled() })
  })
})

describe('AudioSection', () => {
  it('loads an idle shared store and shows the loading state', () => {
    const props = audioProps(state({ status: 'idle' }))
    render(<AudioSection {...props} />)
    expect(props.load).toHaveBeenCalled()
    expect(screen.getByText(en.loading)).toBeTruthy()
  })

  it('reports a failed shared load with a retry action', () => {
    const props = audioProps(state({ status: 'error', error: 'offline' }))
    render(<AudioSection {...props} />)
    expect(screen.getByText(`${en.loadFailed}: offline`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(props.load).toHaveBeenCalled()
  })

  it('explains when the speech namespace is not composed', () => {
    const props = audioProps()
    render(<AudioSection {...props} />)
    expect(screen.getByRole('status').textContent).toBe(en.audioUnavailable)
  })

  it('renders engine controls and audio preference children from the declared slot', async () => {
    const props = audioProps(state({
      namespaces: new Map([['speech', namespace('speech', { cloud: {} })]]),
    }))
    render(<AudioSection {...props} />)
    expect(screen.getByText(en.audioIntro)).toBeTruthy()
    expect(screen.getByLabelText(en.engineStt)).toBeTruthy()
    expect(screen.getByTestId('audio-preference-row')).toBeTruthy()
    expect(props.renderSlot).toHaveBeenCalledWith('settings.audio.item', {})
    await waitFor(() => {
      expect(props.apiFace.credentials.describe).toHaveBeenCalledWith({ refs: ['OPENROUTER_API_KEY'] })
    })
  })

  it('shows a saved notice and compact editor row after applying writable audio settings', async () => {
    const props = audioProps(state({
      namespaces: new Map([['speech', namespace('speech', { cloud: {} })]]),
    }))
    render(<AudioSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.speechApply }))
    await waitFor(() => {
      expect(props.apiFace.settings.mutate).toHaveBeenCalledWith(expect.objectContaining({ ns: 'speech' }))
      expect(screen.getByText(en.speechSaved)).toBeTruthy()
    })
    expect(screen.queryByLabelText(en.engineStt)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.audioTitle }))
    expect(screen.getByLabelText(en.engineStt)).toBeTruthy()
  })

  it('marks the editor read-only when the settings provider cannot write', () => {
    const props = audioProps(state({
      writable: false,
      namespaces: new Map([['speech', namespace('speech', { cloud: {} })]]),
    }))
    render(<AudioSection {...props} />)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getByLabelText(en.engineStt)).toHaveProperty('disabled', true)
  })
})
