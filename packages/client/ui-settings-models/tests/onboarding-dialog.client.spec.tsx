// @vitest-environment jsdom
/** First-run provider picker over the shared Models join. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@roos-code/schemastery'
import type { RpcResponse, SettingsNamespaceView } from '@roos-code/roos-code-api-remotes/client'
import { bindSnapshotSelector } from '@roos-code/roos-code-client-web-react'
import { FirstRunOnboardingDialog } from '../src/client/FirstRunOnboardingDialog.tsx'
import type { FirstRunOnboardingDialogProps } from '../src/client/FirstRunOnboardingDialog.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
})

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `onboarding-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return {
    rpcId: `onboarding-${nextRpc++}` as never,
    result: { ok: false, error: { code: 'internal', message, details: {} } },
  }
}

const DeepSeekConfig = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string().pattern(/^https:\/\//),
  reasoningEffort: Schema.union(['off', 'high', 'max']),
  defaultContextWindow: Schema.number().step(1).min(1),
  models: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    description: Schema.string(),
    contextWindow: Schema.number().step(1).min(1),
  })),
})

function deepSeekNamespace(apiKeyEnv: string | null): SettingsNamespaceView {
  const value = apiKeyEnv === null ? {} : { apiKeyEnv }
  return {
    ns: 'llm-deepseek',
    schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as unknown,
    value,
    base: value,
    user: {},
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

function ollamaEntry() {
  return {
    provider: 'ollama-local',
    displayName: 'Ollama (local)',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'ollama-local'],
    active: true,
  }
}

function harness(options: {
  provider?: boolean
  extraProviders?: Array<{
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: string[]
    active: boolean
  }>
  providerSettingsNs?: string
  providerActive?: boolean
  settingsNamespace?: boolean
  apiKeyEnv?: string | null
  configured?: () => boolean
  credential?: { source?: string; writable: boolean }
  describeFailure?: string
  settingsWritable?: boolean
  providersReject?: boolean
  setFailure?: string
  setReject?: string
  discoverModels?: Array<{ id: string }>
  replaceFailure?: string
  mutateFailure?: string
  defaultModelUser?: { provider: string; model: string }
} = {}) {
  if (document.getElementById('root') === null) {
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
  }
  let fileConfigured = false
  const configured = options.configured ?? (() => fileConfigured)
  const apiKeyEnv = options.apiKeyEnv === undefined ? 'DEEPSEEK_API_KEY' : options.apiKeyEnv
  const mutate = vi.fn(() => options.mutateFailure === undefined
    ? Promise.resolve(ok(deepSeekNamespace(apiKeyEnv)))
    : Promise.resolve(fail(options.mutateFailure)))
  const replace = vi.fn((payload: { ns: string; section: object }) => {
    if (options.replaceFailure !== undefined) return Promise.resolve(fail(options.replaceFailure))
    return Promise.resolve(ok({
      ...deepSeekNamespace(apiKeyEnv),
      ns: payload.ns,
      user: payload.section,
      value: payload.section,
    }))
  })
  const set = vi.fn((_payload: { ref: string; value: string }) => {
    if (options.setReject !== undefined) return Promise.reject(new Error(options.setReject))
    if (options.setFailure !== undefined) return Promise.resolve(fail(options.setFailure))
    fileConfigured = true
    return Promise.resolve(ok({}))
  })
  const face = {
    llm: {
      discoverModels: () => Promise.resolve(ok({
        models: options.discoverModels ?? [{ id: 'deepseek-v4-flash' }],
      })),
      providers: () => {
        if (options.providersReject === true) return Promise.reject(new Error('provider transport unavailable'))
        return Promise.resolve(ok({
          providers: [
            ...options.provider === false
              ? []
              : [{
                provider: 'deepseek-official',
                displayName: 'DeepSeek',
                settingsNs: options.providerSettingsNs ?? 'llm-deepseek',
                settingsPath: [],
                active: options.providerActive ?? true,
              }],
            ...options.extraProviders ?? [],
          ],
        }))
      },
    },
    settings: {
      describe: () => Promise.resolve(ok({
        writable: options.settingsWritable ?? true,
        hasDocument: false,
        namespaces: options.settingsNamespace === false
          ? []
          : [
            deepSeekNamespace(apiKeyEnv),
            ...options.defaultModelUser === undefined
              ? []
              : [{
                ns: 'agent-default-model',
                schema: {},
                value: options.defaultModelUser,
                base: {},
                user: options.defaultModelUser,
                applies: 'live' as const,
                secrets: [],
                revision: 1,
              }],
          ],
      })),
      mutate,
      replace,
    },
    credentials: {
      describe: () => options.describeFailure === undefined
        ? Promise.resolve(ok({
          credentials: {
            DEEPSEEK_API_KEY: {
              configured: configured(),
              ...configured() && options.credential?.source !== undefined
                ? { source: options.credential.source }
                : {},
              writable: options.credential?.writable ?? true,
            },
          },
        }))
        : Promise.resolve(fail(options.describeFailure)),
      set,
    },
  }
  const controller = new ModelsSettingsStore(face as never)
  const openSection = vi.fn()
  const complete = vi.fn()
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: FirstRunOnboardingDialogProps = {
    stepId: 'first-run',
    complete,
    openSection,
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    controller,
    useModels: bindSnapshotSelector(controller.store),
    api: face as never,
    t: key => en[key],
  }
  return {
    controller, complete, openSection, props, mutate, set, replace,
    configure: () => { fileConfigured = true },
  }
}

describe('FirstRunOnboardingDialog', () => {
  it('renders when the shell root is absent', async () => {
    const h = harness()
    document.getElementById('root')!.remove()
    render(<FirstRunOnboardingDialog {...h.props} />)
    expect(await screen.findByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
  })

  it('loads a credential-only modal, inerts the product, and focuses the key', async () => {
    const h = harness()
    render(<FirstRunOnboardingDialog {...h.props} />)
    expect(await screen.findByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
    expect(document.getElementById('root')?.inert).toBe(true)
    expect(screen.getByText(en.onboardingDescription)).toBeTruthy()
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    await waitFor(() => { expect(document.activeElement).toBe(key) })
    expect(screen.queryByText(en.customized)).toBeNull()
  })

  it('cannot be dismissed implicitly and restores the previous inert state', async () => {
    const h = harness()
    const appRoot = document.getElementById('root')!
    appRoot.inert = true
    const view = render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('[class*="mask"]')!)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()

    view.unmount()
    expect(appRoot.inert).toBe(true)
  })

  it('requires a non-blank key before Save and continue is available', async () => {
    const h = harness()
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    const save = screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingSave })
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '   ' } })
    expect(save.disabled).toBe(true)
    expect(screen.getByText(en.keyRequired)).toBeTruthy()
    expect(h.set).not.toHaveBeenCalled()
  })

  it('keeps the modal open and reports rejected and failed credential writes', async () => {
    for (const [options, message] of [
      [{ setFailure: 'credential was rejected' }, 'credential was rejected'],
      [{ setReject: 'connection lost' }, 'connection lost'],
    ] as const) {
      const h = harness(options)
      const view = render(<FirstRunOnboardingDialog {...h.props} />)
      await screen.findByRole('dialog')
      fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-live' } })
      fireEvent.click(screen.getByRole('button', { name: en.onboardingSave }))
      expect(await screen.findByText(message)).toBeTruthy()
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingSave }).disabled).toBe(false)
      expect(h.complete).not.toHaveBeenCalled()
      expect(h.mutate).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it('allows configure-later dismissal without opening settings', async () => {
    const h = harness()
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.onboardingLater }))
    expect(h.complete).toHaveBeenCalledOnce()
    expect(h.openSection).not.toHaveBeenCalled()
    expect(h.set).not.toHaveBeenCalled()
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('does not block the product when DeepSeek setup is unavailable', async () => {
    for (const h of [
      harness({ describeFailure: 'credentials service is absent' }),
      harness({ credential: { writable: false } }),
      harness({ settingsWritable: false }),
      harness({ providersReject: true }),
      harness({ providerActive: false }),
      harness({ settingsNamespace: false }),
      harness({ apiKeyEnv: null }),
    ]) {
      const view = render(<FirstRunOnboardingDialog {...h.props} />)
      await act(async () => { await h.controller.load() })
      expect(screen.queryByRole('dialog')).toBeNull()
      await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
      expect(h.openSection).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it('skips an absent adapter and an already-configured environment credential', async () => {
    for (const h of [
      harness({ provider: false }),
      harness({ configured: () => true, credential: { source: 'env', writable: false } }),
    ]) {
      const view = render(<FirstRunOnboardingDialog {...h.props} />)
      await act(async () => { await h.controller.load() })
      expect(screen.queryByRole('dialog')).toBeNull()
      await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
      view.unmount()
    }
  })

  it('closes when an external credential invalidation refreshes the shared join', async () => {
    const h = harness()
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    h.configure()
    await act(async () => { await h.controller.load() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(h.complete).toHaveBeenCalledOnce()
  })

  it('shows a provider picker when more than one route needs setup', async () => {
    const h = harness({ extraProviders: [ollamaEntry()] })
    render(<FirstRunOnboardingDialog {...h.props} />)
    expect(await screen.findByRole('combobox', { name: en.onboardingPickProvider })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'DeepSeek' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Ollama (local)' })).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: en.onboardingPickProvider }), {
      target: { value: 'no-such-route' },
    })
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('deepseek-official')
  })

  it('lets Configure later dismiss a local-Ollama-only card', async () => {
    const h = harness({ provider: false, extraProviders: [ollamaEntry()] })
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.onboardingLater }))
    expect(h.complete).toHaveBeenCalledOnce()
    expect(h.replace).not.toHaveBeenCalled()
  })

  it('completes after a successful Use local Ollama write', async () => {
    const h = harness({
      extraProviders: [ollamaEntry()],
      discoverModels: [{ id: 'qwen2.5' }],
    })
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByRole('combobox', { name: en.onboardingPickProvider }), {
      target: { value: 'ollama-local' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingUseOllama }))
    await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
    expect(h.props.api.settings.mutate).toHaveBeenCalledWith({
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'ollama-local', 'models'], value: [{ id: 'qwen2.5' }] }],
    })
    expect(h.replace).toHaveBeenCalledWith({
      ns: 'agent-default-model',
      section: { provider: 'ollama-local', model: 'qwen2.5' },
    })
  })

  it('keeps the dialog open when the Ollama default write fails', async () => {
    const h = harness({
      extraProviders: [ollamaEntry()],
      discoverModels: [{ id: 'qwen2.5' }],
      replaceFailure: 'settings rejected',
    })
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByRole('combobox', { name: en.onboardingPickProvider }), {
      target: { value: 'ollama-local' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingUseOllama }))
    expect(await screen.findByText('settings rejected')).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('writes agent-default-model after a keyed save', async () => {
    const h = harness()
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingSave }))
    await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
    expect(h.replace).toHaveBeenCalledWith({
      ns: 'agent-default-model',
      section: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
  })

  it('does not re-prompt when the user layer already names a default', async () => {
    const h = harness({
      extraProviders: [ollamaEntry()],
      defaultModelUser: { provider: 'ollama-local', model: 'qwen2.5' },
    })
    render(<FirstRunOnboardingDialog {...h.props} />)
    await act(async () => { await h.controller.load() })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
  })

  it('keeps the dialog open when adopting the Ollama catalog fails', async () => {
    const h = harness({
      extraProviders: [ollamaEntry()],
      discoverModels: [{ id: 'qwen2.5' }],
      mutateFailure: 'catalog write rejected',
    })
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByRole('combobox', { name: en.onboardingPickProvider }), {
      target: { value: 'ollama-local' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingUseOllama }))
    expect(await screen.findByText('catalog write rejected')).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()
  })

  it('falls back to a pinned model when discovery lists none', async () => {
    const h = harness({ extraProviders: [ollamaEntry()], discoverModels: [] })
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByRole('combobox', { name: en.onboardingPickProvider }), {
      target: { value: 'ollama-local' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingUseOllama }))
    await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
    expect(h.replace).toHaveBeenCalledWith({
      ns: 'agent-default-model',
      section: { provider: 'ollama-local', model: 'llama3.2' },
    })
  })

  it('keeps the dialog open when discovery throws during an Ollama pick', async () => {
    const h = harness({ extraProviders: [ollamaEntry()] })
    h.props.api.llm.discoverModels = () => Promise.reject(new Error('discover down'))
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByRole('combobox', { name: en.onboardingPickProvider }), {
      target: { value: 'ollama-local' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingUseOllama }))
    expect(await screen.findByText('discover down')).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error discovery rejection on an Ollama pick', async () => {
    const h = harness({ extraProviders: [ollamaEntry()] })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario
    h.props.api.llm.discoverModels = () => Promise.reject('discover refused')
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByRole('combobox', { name: en.onboardingPickProvider }), {
      target: { value: 'ollama-local' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingUseOllama }))
    expect(await screen.findByText('discover refused')).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()
  })

  it('keeps the dialog open when the default write after a keyed save fails', async () => {
    const h = harness({ replaceFailure: 'default write rejected' })
    render(<FirstRunOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingSave }))
    expect(await screen.findByText('default write rejected')).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
