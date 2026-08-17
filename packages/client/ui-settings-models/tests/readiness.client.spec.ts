/** Pure first-run readiness projection over the shared Models join. */
import { describe, expect, it } from 'vitest'
import type { CredentialView } from '@shres-code/shres-code-api-remotes/client'
import type { ModelsSettingsState, ProviderRow } from '../src/client/store.ts'
import { onboardingCandidates, onboardingReadiness, providerUsable } from '../src/client/store.ts'

const missingCredential: CredentialView = { configured: false, writable: true }

function row(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      active: true,
    },
    configured: true,
    removable: false,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    credential: missingCredential,
    ...overrides,
  }
}

/** A second provider the user configured themselves. */
function otherRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: 'hfai',
      displayName: 'HFAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'hfai'],
      active: true,
    },
    configured: true,
    removable: true,
    apiKeyEnv: 'HFAI_API_KEY',
    credential: { configured: true, source: 'file', writable: true },
    ...overrides,
  }
}

function state(overrides: Partial<ModelsSettingsState> = {}): ModelsSettingsState {
  return {
    status: 'ready',
    error: null,
    credentialError: null,
    writable: true,
    rows: [row()],
    namespaces: new Map(),
    hasUserDefaultModel: false,
    ...overrides,
  }
}

describe('providerUsable', () => {
  it('requires a registered route and a stored key for every named reference', () => {
    expect(providerUsable(otherRow())).toBe(true)
    expect(providerUsable(otherRow({ entry: { ...otherRow().entry, active: false } }))).toBe(false)
    expect(providerUsable(otherRow({ credential: missingCredential }))).toBe(false)
    expect(providerUsable(otherRow({ credential: undefined }))).toBe(false)
  })

  it('treats a reference-free registered route as provider-native authentication', () => {
    expect(providerUsable(otherRow({ apiKeyEnv: undefined, credential: undefined }))).toBe(true)
  })

  it('does not treat a keyless delegated CLI route as usable', () => {
    expect(providerUsable(otherRow({
      apiKeyEnv: undefined,
      credential: undefined,
      entry: {
        provider: 'grok-cli',
        displayName: 'Grok Build CLI (delegated)',
        settingsNs: 'llm-cli-bridge',
        settingsPath: ['routes', 'grok-cli'],
        active: true,
        kind: 'delegated',
      },
    }))).toBe(false)
  })
})

describe('onboardingReadiness', () => {
  it('waits for the first join and skips onboarding when no configurable route remains', () => {
    expect(onboardingReadiness(state({ status: 'idle', rows: [] }))).toEqual({ kind: 'loading' })
    expect(onboardingReadiness(state({ status: 'loading', rows: [] }))).toEqual({ kind: 'loading' })
    expect(onboardingReadiness(state({ rows: [] }))).toEqual({ kind: 'adapter-absent' })
    expect(onboardingReadiness(state({
      rows: [row({
        apiKeyEnv: undefined,
        credential: undefined,
        entry: { ...row().entry, provider: 'native-only' },
      })],
    }))).toEqual({ kind: 'provider-ready' })
  })

  it('reports a missing writable effective credential', () => {
    expect(onboardingReadiness(state())).toEqual({ kind: 'credential-missing' })
  })

  it('ends onboarding once any other registered provider can serve requests', () => {
    expect(onboardingReadiness(state({ rows: [row(), otherRow()] }))).toEqual({ kind: 'provider-ready' })
    // A provider the user cannot reach yet leaves the prompt in place.
    expect(onboardingReadiness(state({
      rows: [row(), otherRow({ credential: missingCredential })],
    }))).toEqual({ kind: 'credential-missing' })
  })

  it('does not treat a keyless delegated CLI route as already set up', () => {
    const delegated = row({
      apiKeyEnv: undefined,
      credential: undefined,
      entry: {
        provider: 'grok-cli',
        displayName: 'Grok Build CLI (delegated)',
        settingsNs: 'llm-cli-bridge',
        settingsPath: ['routes', 'grok-cli'],
        active: true,
        kind: 'delegated',
      },
    })
    expect(onboardingReadiness(state({ rows: [delegated] }))).toEqual({
      kind: 'unavailable',
      reason: 'provider-inactive',
    })
    expect(onboardingReadiness(state({ rows: [delegated, row()] }))).toEqual({ kind: 'credential-missing' })
    expect(onboardingCandidates(state({ rows: [delegated, row()] }).rows).map(item => item.entry.provider))
      .toEqual(['deepseek-official'])
  })

  it('does not treat keyless local Ollama as already set up', () => {
    const ollama = row({
      apiKeyEnv: undefined,
      credential: undefined,
      entry: {
        provider: 'ollama-local',
        displayName: 'Ollama (local)',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'ollama-local'],
        active: true,
      },
    })
    expect(onboardingReadiness(state({ rows: [ollama] }))).toEqual({ kind: 'credential-missing' })
    expect(onboardingCandidates(state({ rows: [ollama, row()] }).rows).map(item => item.entry.provider))
      .toEqual(['ollama-local', 'deepseek-official'])
    expect(onboardingReadiness(state({ rows: [ollama], hasUserDefaultModel: true })))
      .toEqual({ kind: 'provider-ready' })
    expect(onboardingReadiness(state({ rows: [ollama], writable: false })))
      .toEqual({ kind: 'unavailable', reason: 'settings-read-only' })
  })

  it('accepts file and process-environment credentials without prompting', () => {
    expect(onboardingReadiness(state({
      rows: [row({ credential: { configured: true, source: 'file', writable: true } })],
    }))).toEqual({ kind: 'provider-ready' })
    expect(onboardingReadiness(state({
      rows: [row({ credential: { configured: true, source: 'env', writable: false } })],
    }))).toEqual({ kind: 'provider-ready' })
  })

  it('turns missing capabilities into diagnostics that never block the product', () => {
    expect(onboardingReadiness(state({ status: 'error', error: 'settings down' }))).toEqual({
      kind: 'unavailable',
      reason: 'load-failed',
    })
    expect(onboardingReadiness(state({
      rows: [row({ entry: { ...row().entry, active: false } })],
    }))).toEqual({ kind: 'unavailable', reason: 'provider-inactive' })
    expect(onboardingReadiness(state({
      credentialError: 'credentials service is absent',
    }))).toEqual({
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    })
    expect(onboardingReadiness(state({
      rows: [row({ credential: undefined })],
    }))).toEqual({ kind: 'unavailable', reason: 'credentials-unavailable' })
    expect(onboardingReadiness(state({
      rows: [row({ credential: { configured: false, writable: false } })],
    }))).toEqual({ kind: 'unavailable', reason: 'credential-read-only' })
    expect(onboardingReadiness(state({ writable: false }))).toEqual({
      kind: 'unavailable',
      reason: 'settings-read-only',
    })
  })
})
