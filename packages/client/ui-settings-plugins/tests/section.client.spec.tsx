// @vitest-environment jsdom
/**
 * What the section and its cards show: the empty line when no plugin
 * contributed one, a card that renders nothing while its namespace is
 * unavailable, and the save footer that decides when staged edits are written.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import { AgentLoopCard } from '../src/client/AgentLoopCard.tsx'
import type { AgentLoopCardProps } from '../src/client/AgentLoopCard.tsx'
import { BashCard } from '../src/client/BashCard.tsx'
import type { BashCardProps } from '../src/client/BashCard.tsx'
import { ConfigurablePluginsTab } from '../src/client/ConfigurablePluginsTab.tsx'
import type { ConfigurablePluginsTabProps } from '../src/client/ConfigurablePluginsTab.tsx'
import { PluginsSettingsSection } from '../src/client/PluginsSettingsSection.tsx'
import type { PluginsSettingsSectionProps, PluginsSettingsTabEntry } from '../src/client/PluginsSettingsSection.tsx'
import { WebSearchCard } from '../src/client/WebSearchCard.tsx'
import type { WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import type { AgentLoopCardState } from '../src/client/agent-loop-card-controller.ts'
import type { BashCardState } from '../src/client/bash-card-controller.ts'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import { WebSearchCardController, type WebSearchCardState, type WebSearchSettings, type WebSearchMethods } from '../src/client/web-search-card-controller.ts'
import { stubSettingsScope } from '@shres-code/shres-code-client-test-runtime'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

/** A settled form: nothing staged, everything served. */
const settled: CardShell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

/** One control's state, defaulting to an inherited value. */
function field(text: string, rest: Partial<CardFieldState> = {}): CardFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

function renderSection(rows: readonly PluginsSettingsTabEntry[]) {
  const props = {
    t,
    useTabs: (selector: (value: readonly PluginsSettingsTabEntry[]) => unknown) => selector(rows),
    renderSlot: (_name: string, _owner: unknown, options: { only?: string }) => (
      <span>{options.only}</span>
    ),
  } as unknown as PluginsSettingsSectionProps
  render(<PluginsSettingsSection {...props} />)
}

function renderConfigurable(cardCount: number, cards = 'cards') {
  const props = {
    t,
    cardCount,
    renderSlot: () => <li>{cards}</li>,
  } as unknown as ConfigurablePluginsTabProps
  render(<ConfigurablePluginsTab {...props} />)
}

function renderBash(state: Partial<BashCardState> = {}) {
  const store = createSnapshotStore<BashCardState>({
    ...settled,
    timeoutMs: field('60000'),
    maxOutputBytes: field('64000'),
    ...state,
  })
  const actions = cardActions()
  const props = { ...actions, t, useBashCard: bindSnapshotSelector(store) } as unknown as BashCardProps
  render(<BashCard {...props} />)
  return actions
}

describe('PluginsSettingsSection', () => {
  it('says so when no plugin contributed a tab', () => {
    renderSection([])

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('defaults to the first ordered tab and mounts another only after selection', () => {
    renderSection([
      { id: 'configurable', order: 0, label: en.configurableTab },
      { id: 'all', order: 10, label: 'Plugin list' },
    ])

    const configurable = screen.getByRole('tab', { name: en.configurableTab })
    const all = screen.getByRole('tab', { name: 'Plugin list' })
    expect(configurable.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('configurable')).toBeTruthy()
    expect(screen.queryByText('all')).toBeNull()

    fireEvent.click(all)
    expect(all.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('all')).toBeTruthy()
    expect(screen.getByText('configurable').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)

    fireEvent.click(configurable)
    expect(configurable.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('all').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)
  })

  it('leads with its own heading and intro', () => {
    renderSection([{ id: 'configurable', order: 0, label: en.configurableTab }])

    expect(screen.getByRole('tablist')).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
  })

  it('moves focus and selection with standard horizontal tab keys', () => {
    renderSection([
      { id: 'configurable', order: 0, label: en.configurableTab },
      { id: 'all', order: 10, label: 'Plugin list' },
      { id: 'diagnostics', order: 20, label: 'Diagnostics' },
    ])

    const configurable = screen.getByRole('tab', { name: en.configurableTab })
    const all = screen.getByRole('tab', { name: 'Plugin list' })
    const diagnostics = screen.getByRole('tab', { name: 'Diagnostics' })
    expect(configurable.getAttribute('tabindex')).toBe('0')
    expect(all.getAttribute('tabindex')).toBe('-1')

    configurable.focus()
    fireEvent.keyDown(configurable, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(all)
    expect(all.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(all, { key: 'End' })
    expect(document.activeElement).toBe(diagnostics)
    fireEvent.keyDown(diagnostics, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(configurable)
    fireEvent.keyDown(configurable, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(diagnostics)
    fireEvent.keyDown(diagnostics, { key: 'Home' })
    expect(document.activeElement).toBe(configurable)

    fireEvent.keyDown(configurable, { key: 'Escape' })
    expect(document.activeElement).toBe(configurable)
    expect(configurable.getAttribute('aria-selected')).toBe('true')
  })
})

describe('ConfigurablePluginsTab', () => {
  it('says so when no plugin contributed a card', () => {
    renderConfigurable(0)

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByText('cards')).toBeNull()
  })

  it('renders the card list once a plugin contributed one', () => {
    renderConfigurable(1)

    expect(screen.getByText('cards')).toBeTruthy()
    expect(screen.queryByText(en.empty)).toBeNull()
  })
})

describe('BashCard', () => {
  it('renders nothing while its namespace is unavailable', () => {
    const { container } = render(<div />)
    renderBash({ available: false })

    expect(container.textContent).toBe('')
    expect(screen.queryByText(en.bashTitle)).toBeNull()
  })

  it('shows the plugin and reveals its fields only once expanded', () => {
    renderBash()
    expect(screen.getByText(en.bashTitle)).toBeTruthy()
    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()

    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByLabelText(en.bashTimeoutMs)).toBeTruthy()
    expect(screen.getByLabelText(en.bashMaxOutputBytes)).toBeTruthy()
  })

  it('stages an edit instead of writing it', () => {
    const actions = renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.change(screen.getByLabelText(en.bashTimeoutMs), { target: { value: '9000' } })

    expect(actions.edit).toHaveBeenCalledWith('timeoutMs', '9000')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('offers the reset for an overridden field only', () => {
    const actions = renderBash({ timeoutMs: field('9000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    // One badge and one reset: the output cap is still inherited.
    expect(screen.getAllByText(en.overridden)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('timeoutMs')
  })

  it('addresses each of its two fields separately', () => {
    const actions = renderBash({ maxOutputBytes: field('64000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.change(screen.getByLabelText(en.bashMaxOutputBytes), { target: { value: '1024' } })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.edit).toHaveBeenCalledWith('maxOutputBytes', '1024')
    expect(actions.resetField).toHaveBeenCalledWith('maxOutputBytes')
  })

  it('keeps save and discard inert until something is staged', () => {
    renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
    expect(screen.queryByText(en.unsaved)).toBeNull()
  })

  it('writes the staged edits when saved, and drops them when discarded', () => {
    const actions = renderBash({ dirty: true, timeoutMs: field('9000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    fireEvent.click(screen.getByRole('button', { name: en.discard }))

    expect(actions.save).toHaveBeenCalledOnce()
    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it('marks a card holding unsaved edits, collapsed or not', () => {
    renderBash({ dirty: true })

    expect(screen.getByText(en.unsaved)).toBeTruthy()
  })

  it('blocks the save while a draft is invalid, and says why', () => {
    renderBash({ dirty: true, invalid: true, timeoutMs: field('soon', { invalid: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', false)
    expect(screen.getByText(en.invalidNumber)).toBeTruthy()
  })

  it('reports a save in flight and refuses another', () => {
    renderBash({ dirty: true, saving: true })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
  })

  it('reports a save the deployment did not accept', () => {
    renderBash({ dirty: true, failed: true })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByText(en.saveFailed)).toBeTruthy()
  })

  it('says the document is read-only and disables its controls', () => {
    renderBash({ writable: false })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('status')).toHaveProperty('textContent', en.readOnly)
    expect(screen.getByLabelText(en.bashTimeoutMs)).toHaveProperty('disabled', true)
  })

  it('collapses again on a second click', () => {
    renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))
    expect(screen.getByLabelText(en.bashTimeoutMs)).toBeTruthy()

    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()
  })
})

describe('AgentLoopCard', () => {
  it('stages and saves the only field it owns', () => {
    const store = createSnapshotStore<AgentLoopCardState>({
      ...settled,
      dirty: true,
      maxParallelToolCalls: field('10'),
    })
    const actions = cardActions()
    const props = {
      ...actions,
      t,
      useAgentLoopCard: bindSnapshotSelector(store),
    } as unknown as AgentLoopCardProps
    render(<AgentLoopCard {...props} />)

    fireEvent.click(screen.getByText(en.agentLoopTitle))
    fireEvent.change(screen.getByLabelText(en.agentLoopMaxParallel), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit).toHaveBeenCalledWith('maxParallelToolCalls', '2')
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('stages a reset for the field it owns', () => {
    const store = createSnapshotStore<AgentLoopCardState>({
      ...settled,
      maxParallelToolCalls: field('2', { overridden: true }),
    })
    const actions = cardActions()
    const props = {
      ...actions,
      t,
      useAgentLoopCard: bindSnapshotSelector(store),
    } as unknown as AgentLoopCardProps
    render(<AgentLoopCard {...props} />)

    fireEvent.click(screen.getByText(en.agentLoopTitle))
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('maxParallelToolCalls')
  })
})

describe('WebSearchCard', () => {
  function renderWebSearch(state: Partial<WebSearchCardState> = {}) {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled,
      providers: Object.fromEntries(['brave', 'perplexity', 'deepseek', 'methods'].map(id => [id, { available: true, writable: state.writable ?? true, dirty: false }])) as WebSearchCardState['providers'],
      brave: field('true'),
      braveBaseURL: field(''),
      braveApiKey: field(''),
      braveApiKeyConfigured: false,
      braveApiKeyKnown: true,
      braveApiKeyWritable: true,
      grok: field('true'),
      claude: field('true'),
      codex: field('true'),
      kimi: field('true'),
      ollama: field('true'),
      zai: field('true'),
      deepseek: field('true'),
      baseURL: field(''),
      maxUses: field('5'),
      apiKey: field(''),
      apiKeyConfigured: false,
      apiKeyKnown: true,
      apiKeyWritable: true,
      perplexity: field('true'),
      perplexityBaseURL: field(''),
      perplexityApiKey: field(''),
      perplexityApiKeyConfigured: false,
      perplexityApiKeyKnown: true,
      perplexityApiKeyWritable: true,
      ...state,
    })
    const actions = cardActions()
    const props = { ...actions, t, useWebSearchCard: bindSnapshotSelector(store) } as unknown as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    return actions
  }

  it('folds Perplexity without disabling it or writing drafts', () => {
    const actions = renderWebSearch()
    fireEvent.click(screen.getByText(en.webSearchTitle))
    const toggle = screen.getByRole('switch', { name: 'Perplexity' })
    const details = screen.getByLabelText(en.webSearchPerplexityApiKey).closest('[id$="-details"]')!
    fireEvent.change(screen.getByLabelText(en.webSearchPerplexityBaseUrl), { target: { value: 'https://staged.test' } })
    actions.edit.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Hide settings: Perplexity' }))
    expect(details).toHaveProperty('hidden', true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Show settings: Perplexity' }))
    expect(details).toHaveProperty('hidden', false)
    expect(actions.edit).not.toHaveBeenCalled()
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('starts configured provider details collapsed and lets them reopen', () => {
    renderWebSearch({ braveApiKeyConfigured: true, perplexityApiKeyConfigured: true })
    fireEvent.click(screen.getByText(en.webSearchTitle))
    expect(screen.getByLabelText(en.webSearchBraveApiKey).closest('[hidden]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show settings: Brave' }))
    expect(screen.getByLabelText(en.webSearchBraveApiKey).closest('[hidden]')).toBeNull()
  })

  it('renders an unavailable provider off and disabled without credential fields', () => {
    const actions = renderWebSearch({
      providers: { brave: settled, deepseek: settled, methods: settled, perplexity: { available: false, writable: false, dirty: false } },
    })
    fireEvent.click(screen.getByText(en.webSearchTitle))
    const toggle = screen.getByRole('switch', { name: 'Perplexity' })
    expect(toggle).toHaveProperty('disabled', true)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(actions.edit).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(en.webSearchPerplexityApiKey)).toBeNull()
    expect(screen.getByText(en.providerUnavailable)).toBeTruthy()
  })

  it.each([
    [false, 'none', true], [true, 'none', false],
    [true, 'open', true], [false, 'closed', false],
  ] as const)('resolves delayed credential state %s while preserving gesture %s', async (configured, gesture, expanded) => {
    const hosts = Array.from({ length: 3 }, () => stubSettingsScope<WebSearchSettings>())
    for (const host of hosts) host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const [deepseek, perplexity, brave] = hosts as [typeof hosts[number], typeof hosts[number], typeof hosts[number]]
    const methods = stubSettingsScope<WebSearchMethods>()
    let resolve!: (value: unknown) => void
    const pending = new Promise<unknown>((done) => { resolve = done })
    const api = { credentials: {
      describe: vi.fn(({ refs }: { refs: string[] }) => refs[0] === 'BRAVE_API_KEY'
        ? pending : Promise.resolve({ result: { ok: true, value: { credentials: {} } } })),
      set: vi.fn(),
    } } as never
    const face = new WebSearchCardController(deepseek.scope, api, methods.scope, perplexity.scope, brave.scope).inject()
    const props = { ...face, t, useWebSearchCard: bindSnapshotSelector(face.hooks.webSearchCard) } as unknown as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    fireEvent.click(screen.getByText(en.webSearchTitle))
    const details = screen.getByLabelText(en.webSearchBraveApiKey).closest('[id$="-details"]')!
    expect(details).toHaveProperty('hidden', true)
    if (gesture !== 'none') fireEvent.click(screen.getByRole('button', { name: 'Show settings: Brave' }))
    if (gesture === 'closed') fireEvent.click(screen.getByRole('button', { name: 'Hide settings: Brave' }))
    await act(async () => {
      resolve({ result: { ok: true, value: { credentials: { BRAVE_API_KEY: { configured, writable: true } } } } })
      await pending
    })
    expect(details).toHaveProperty('hidden', !expanded)
    expect(face.hooks.webSearchCard.getSnapshot().dirty).toBe(false)
  })

  it('round-trips mounted Perplexity switches through the staged controller', () => {
    const deepseek = stubSettingsScope<WebSearchSettings>()
    const perplexity = stubSettingsScope<WebSearchSettings>()
    const brave = stubSettingsScope<WebSearchSettings>()
    const methods = stubSettingsScope<WebSearchMethods>()
    for (const host of [deepseek, perplexity, brave]) host.publish({ status: 'ready', writable: true, value: { enabled: true }, user: {} })
    methods.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const api = { credentials: {
      describe: vi.fn(async () => ({ result: { ok: true, value: { credentials: {} } } })),
      set: vi.fn(),
    } } as never
    const controller = new WebSearchCardController(deepseek.scope, api, methods.scope, perplexity.scope, brave.scope)
    const face = controller.inject()
    const props = { ...face, t, useWebSearchCard: bindSnapshotSelector(face.hooks.webSearchCard) } as unknown as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    fireEvent.click(screen.getByText(en.webSearchTitle))
    const toggle = screen.getByRole('switch', { name: 'Perplexity' })
    for (const on of [false, true, false, true]) {
      fireEvent.click(toggle)
      expect(toggle.getAttribute('aria-checked')).toBe(String(on))
      expect(screen.queryByLabelText(en.webSearchPerplexityApiKey) !== null).toBe(on)
    }
    expect(perplexity.set).not.toHaveBeenCalled()
  })

  it('describes Brave priority, Perplexity research and Grok hosted X accurately', () => {
    renderWebSearch()
    fireEvent.click(screen.getByText(en.webSearchTitle))
    expect(screen.getByText('First in the default web_search order when enabled and a key is configured; other methods are fallbacks.')).toBeTruthy()
    expect(screen.getByText('Powers deep_research, not routine web_search. Requires a Perplexity API key.')).toBeTruthy()
    expect(screen.getByText('Web results using XAI_API_KEY. X (Twitter) search is available when chatting on a Grok subscription model.')).toBeTruthy()
  })

  it('stages Brave credentials and endpoint independently', () => {
    const actions = renderWebSearch()
    fireEvent.click(screen.getByText(en.webSearchTitle))
    fireEvent.change(screen.getByLabelText(en.webSearchBraveApiKey), { target: { value: 'test-key' } })
    fireEvent.change(screen.getByLabelText(en.webSearchBraveBaseUrl), { target: { value: 'https://brave.test' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Brave' }))
    expect(actions.edit.mock.calls).toEqual([['braveApiKey', 'test-key'], ['braveBaseURL', 'https://brave.test'], ['braveEnabled', 'false']])
  })

  it('reports whether a key is configured without ever showing one', () => {
    renderWebSearch({ apiKeyConfigured: true })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    expect(screen.getByText(en.webSearchApiKeySet)).toBeTruthy()
    expect(screen.getByLabelText(en.webSearchApiKey)).toHaveProperty('type', 'password')
  })

  it('keeps the key control usable while the settings document is read-only', () => {
    const actions = renderWebSearch({ writable: false })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    const key = screen.getByLabelText(en.webSearchApiKey)
    expect(key).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.webSearchBaseUrl)).toHaveProperty('disabled', true)

    fireEvent.change(key, { target: { value: 'ds-secret' } })

    expect(actions.edit).toHaveBeenCalledWith('apiKey', 'ds-secret')
  })

  it('disables the key control when the reference itself is not writable', () => {
    // A key coming from the process environment: the settings document is
    // writable, the credential is not.
    renderWebSearch({ apiKeyConfigured: true, apiKeyWritable: false })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    expect(screen.getByLabelText(en.webSearchApiKey)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.webSearchBaseUrl)).toHaveProperty('disabled', false)
  })

  it('stages method switches independently', () => {
    const actions = renderWebSearch()
    fireEvent.click(screen.getByText(en.webSearchTitle))

    fireEvent.click(screen.getByRole('switch', { name: en.webSearchGrok }))
    fireEvent.click(screen.getByRole('switch', { name: en.webSearchClaude }))
    fireEvent.click(screen.getByRole('switch', { name: en.webSearchCodex }))
    fireEvent.click(screen.getByRole('switch', { name: en.webSearchKimi }))
    fireEvent.click(screen.getByRole('switch', { name: en.webSearchOllama }))
    fireEvent.click(screen.getByRole('switch', { name: en.webSearchZai }))
    fireEvent.click(screen.getByRole('switch', { name: en.webSearchPerplexity }))
    fireEvent.click(screen.getByRole('switch', { name: en.webSearchDeepSeek }))

    expect(actions.edit.mock.calls).toEqual([
      ['grok', 'false'],
      ['claude', 'false'],
      ['codex', 'false'],
      ['kimi', 'false'],
      ['ollama', 'false'],
      ['zai', 'false'],
      ['perplexityEnabled', 'false'],
      ['enabled', 'false'],
    ])
  })

  it('hides DeepSeek key fields while that method is off', () => {
    renderWebSearch({ deepseek: field('false') })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    expect(screen.queryByLabelText(en.webSearchApiKey)).toBeNull()
    expect(screen.getByRole('switch', { name: en.webSearchDeepSeek }).getAttribute('aria-checked')).toBe('false')
  })

  it('hides Perplexity key fields while that method is off', () => {
    renderWebSearch({ perplexity: field('false') })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    expect(screen.queryByLabelText(en.webSearchPerplexityApiKey)).toBeNull()
    expect(screen.queryByLabelText(en.webSearchPerplexityBaseUrl)).toBeNull()
    expect(screen.getByRole('switch', { name: en.webSearchPerplexity }).getAttribute('aria-checked')).toBe('false')
  })

  it('renders each method\'s credential fields under that method\'s switch', () => {
    renderWebSearch()
    fireEvent.click(screen.getByText(en.webSearchTitle))

    const perplexity = screen.getByRole('switch', { name: en.webSearchPerplexity })
    const perplexityKey = screen.getByLabelText(en.webSearchPerplexityApiKey)
    const perplexityEndpoint = screen.getByLabelText(en.webSearchPerplexityBaseUrl)
    const deepseek = screen.getByRole('switch', { name: en.webSearchDeepSeek })
    const deepseekKey = screen.getByLabelText(en.webSearchApiKey)
    const following = Node.DOCUMENT_POSITION_FOLLOWING
    expect(perplexity.compareDocumentPosition(perplexityKey) & following).toBe(following)
    expect(perplexityKey.compareDocumentPosition(perplexityEndpoint) & following).toBe(following)
    expect(perplexityEndpoint.compareDocumentPosition(deepseek) & following).toBe(following)
    expect(deepseek.compareDocumentPosition(deepseekKey) & following).toBe(following)
  })

  it('stages the Perplexity key and endpoint through their field aliases', () => {
    const actions = renderWebSearch({
      perplexityApiKeyConfigured: true,
      perplexityBaseURL: field('https://stored.test', { overridden: true }),
    })
    fireEvent.click(screen.getByText(en.webSearchTitle))
    fireEvent.click(screen.getByRole('button', { name: 'Show settings: Perplexity' }))

    expect(screen.getByLabelText(en.webSearchPerplexityApiKey)).toHaveProperty('type', 'password')
    fireEvent.change(screen.getByLabelText(en.webSearchPerplexityApiKey), { target: { value: 'pplx-secret' } })
    fireEvent.change(screen.getByLabelText(en.webSearchPerplexityBaseUrl), { target: { value: 'https://pplx.test' } })
    // Only the Perplexity endpoint carries an override, so its reset is alone.
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.edit.mock.calls).toEqual([
      ['perplexityApiKey', 'pplx-secret'],
      ['perplexityBaseURL', 'https://pplx.test'],
    ])
    expect(actions.resetField.mock.calls).toEqual([['perplexityBaseURL']])
  })

  it('disables the Perplexity key control when its reference is not writable', () => {
    renderWebSearch({ perplexityApiKeyConfigured: true, perplexityApiKeyWritable: false })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    expect(screen.getByLabelText(en.webSearchPerplexityApiKey)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.webSearchPerplexityBaseUrl)).toHaveProperty('disabled', false)
  })

  it('stages the endpoint, the search budget, and their resets', () => {
    const actions = renderWebSearch({
      baseURL: field('https://search.test/v1', { overridden: true }),
      maxUses: field('3', { overridden: true }),
    })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    fireEvent.change(screen.getByLabelText(en.webSearchBaseUrl), { target: { value: 'https://other.test' } })
    fireEvent.change(screen.getByLabelText(en.webSearchMaxUses), { target: { value: '4' } })
    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(2)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.edit.mock.calls).toEqual([
      ['baseURL', 'https://other.test'],
      ['maxUses', '4'],
    ])
    expect(actions.resetField.mock.calls).toEqual([['baseURL'], ['maxUses']])
  })
})
