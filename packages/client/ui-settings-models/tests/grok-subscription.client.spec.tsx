// @vitest-environment jsdom
/** Grok subscription setup uses provider sign-in and staged hosted-search settings. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@shres-code/schemastery'
import type { SettingsNamespaceView } from '@shres-code/shres-code-api-remotes/client'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import type { ProviderEditorProps } from '../src/client/ProviderEditor.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const GrokConfig = Schema.object({
  enabled: Schema.boolean().default(true),
  hostedWebSearch: Schema.boolean().default(true),
  hostedXSearch: Schema.boolean().default(true),
  agentXTools: Schema.boolean().default(false),
  models: Schema.array(Schema.object({ id: Schema.string().required(), name: Schema.string() })),
})

function namespace(user: Record<string, unknown> = {}): SettingsNamespaceView {
  const base = {
    enabled: true, hostedWebSearch: true, hostedXSearch: true, agentXTools: false,
    models: [{ id: 'grok-4.6', name: 'Grok 4.6' }],
  }
  return {
    ns: 'llm-grok-session', schema: JSON.parse(JSON.stringify(GrokConfig.toJSON())) as unknown,
    base, value: { ...base, ...user }, user, revision: 7, applies: 'live', secrets: [],
  }
}

function setup(options: { user?: Record<string, unknown>; readOnly?: boolean; credentialOnly?: boolean } = {}) {
  const view = namespace(options.user)
  const mutate = vi.fn(() => Promise.resolve({
    result: { ok: true, value: { ...namespace({ ...options.user, hostedWebSearch: false, hostedXSearch: false }), revision: 8 } },
  }))
  const credentials = { describe: vi.fn(), set: vi.fn() }
  const onClose = vi.fn()
  const api = { settings: { mutate }, credentials, llm: {} } as unknown as ProviderEditorProps['api']
  render(<ProviderEditor
    provider="grok-session" displayName="Grok (subscription)"
    namespace={view} settingsPath={[]} api={api} t={key => en[key]}
    readOnly={options.readOnly ?? false} credentialOnly={options.credentialOnly ?? false} onClose={onClose}
  />)
  return { mutate, credentials, onClose }
}

describe('Grok subscription editor', () => {
  it('explains account access without an API key or sign-in verification claim', () => {
    const { credentials, mutate } = setup()
    expect(screen.getByText(en.grokSubscriptionAccess)).toBeTruthy()
    expect(screen.getByText(en.grokShareXDescription)).toBeTruthy()
    expect(screen.getByText(en.grokShareXQuota)).toBeTruthy()
    for (const name of ['x_keyword_search', 'x_semantic_search', 'x_user_search', 'x_thread_fetch']) {
      expect(screen.getByText(name)).toBeTruthy()
    }
    for (const description of [en.grokKeywordDescription, en.grokSemanticDescription, en.grokUserDescription, en.grokThreadDescription]) {
      expect(screen.getByText(description)).toBeTruthy()
    }
    expect(screen.getByRole('switch', { name: en.grokShareXTools }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText(en.sessionGate)).toBeNull()
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(credentials.describe).not.toHaveBeenCalled()
    expect(screen.getByRole('switch', { name: en.grokHostedWebSearch }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: en.grokHostedXSearch }).getAttribute('aria-checked')).toBe('true')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('stages each hosted switch and saves only its owning provider fields', async () => {
    const { mutate, credentials, onClose } = setup()
    fireEvent.click(screen.getByRole('switch', { name: en.grokHostedXSearch }))
    expect(screen.getByRole('switch', { name: en.grokHostedWebSearch }).getAttribute('aria-checked')).toBe('true')
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: en.grokHostedWebSearch }))
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(mutate).toHaveBeenCalledWith({
      ns: 'llm-grok-session', expectedRevision: 7,
      ops: [
        { op: 'set', path: ['hostedXSearch'], value: false },
        { op: 'set', path: ['hostedWebSearch'], value: false },
      ],
    })
    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('projects a disabled switch without overriding its enabled neighbor', () => {
    setup({ user: { hostedXSearch: false } })
    expect(screen.getByRole('switch', { name: en.grokHostedXSearch }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: en.grokHostedWebSearch }).getAttribute('aria-checked')).toBe('true')
  })

  it('opts other agents in with a single staged sharing setting', async () => {
    const { mutate, onClose } = setup()
    fireEvent.click(screen.getByRole('switch', { name: en.grokShareXTools }))
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(mutate).toHaveBeenCalledWith({
      ns: 'llm-grok-session', expectedRevision: 7,
      ops: [{ op: 'set', path: ['agentXTools'], value: true }],
    })
  })

  it.each([{ enabled: false }, { hostedXSearch: false }])('gates sharing when a prerequisite is off: %o', (user) => {
    setup({ user: { ...user, agentXTools: true } })
    const sharing = screen.getByRole('switch', { name: en.grokShareXTools }) as HTMLButtonElement
    expect(sharing.disabled).toBe(true)
    expect(sharing.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(en.grokShareXPrerequisite)).toBeTruthy()
  })

  it('updates the sharing dependency while X search is staged off and on', () => {
    setup({ user: { agentXTools: true } })
    const sharing = screen.getByRole('switch', { name: en.grokShareXTools }) as HTMLButtonElement
    expect(sharing.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('switch', { name: en.grokHostedXSearch }))
    expect(sharing.disabled).toBe(true)
    expect(sharing.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('switch', { name: en.grokHostedXSearch }))
    expect(sharing.disabled).toBe(false)
    expect(sharing.getAttribute('aria-checked')).toBe('true')
  })

  it('cancels a staged change without writing settings', () => {
    const { mutate, onClose } = setup()
    fireEvent.click(screen.getByRole('switch', { name: en.grokHostedXSearch }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(onClose).toHaveBeenCalledWith(false)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('disables writes while keeping account guidance and dismissal available', () => {
    const { mutate, onClose } = setup({ readOnly: true })
    for (const control of screen.getAllByRole('switch')) expect((control as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(en.grokSubscriptionAccess)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(onClose).toHaveBeenCalledWith(false)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('keeps provider settings out of credential-only onboarding', () => {
    const { credentials } = setup({ credentialOnly: true })
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(credentials.describe).not.toHaveBeenCalled()
    expect(screen.getByText(en.grokSubscriptionAccess)).toBeTruthy()
  })
})
