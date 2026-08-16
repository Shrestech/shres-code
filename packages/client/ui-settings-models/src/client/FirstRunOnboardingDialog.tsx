/**
 * First-run provider step. Readiness comes from the same
 * provider/settings/credential join as the Models page: any keyed usable
 * provider ends the step. When none exists, the card offers every composed
 * route that still needs a key, plus local Ollama. The step reuses the Models
 * credential editor in the onboarding plugin's shared modal.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@roos-code/roos-code-api-remotes/client'
import type { SnapshotStore } from '@roos-code/roos-code-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@roos-code/roos-code-client-ui-slots'
import type { ModelsSettingsState, ModelsSettingsStore, ProviderRow } from './store.ts'
import { onboardingCandidates, onboardingReadiness } from './store.ts'
import { ProviderEditor } from './ProviderEditor.tsx'
import type { en } from './locales.ts'
import { OnboardingModal } from './OnboardingModal.tsx'
import styles from './DeepSeekOnboardingDialog.module.css'
import modelStyles from './ModelsSection.module.css'

/** Registration-side dependencies of {@link FirstRunOnboardingDialog}. */
export interface FirstRunOnboardingInjected {
  hooks: {
    /** Shared Models-page join state, bound by the slot renderer. */
    models: SnapshotStore<ModelsSettingsState>
  }
  /** Shared Models-page join controller. */
  controller: ModelsSettingsStore
  /** Existing wire face reused by the Models credential editor. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Feature copy. */
  t: (key: keyof typeof en) => string
}

/** Slot owner props plus the feature's injected dependencies. */
export type FirstRunOnboardingDialogProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<FirstRunOnboardingInjected>

/** @deprecated Use {@link FirstRunOnboardingInjected}. */
export type DeepSeekOnboardingInjected = FirstRunOnboardingInjected
/** @deprecated Use {@link FirstRunOnboardingDialogProps}. */
export type DeepSeekOnboardingDialogProps = FirstRunOnboardingDialogProps

/* v8 ignore next 3 -- closed-union defaults only defend future source widening */
function assertNever(_value: never): never {
  throw new Error('unexpected first-run onboarding state')
}

/** Fallback model ids when discovery lists none. */
const FALLBACK_MODELS: Readonly<Record<string, string>> = {
  'deepseek-official': 'deepseek-v4-flash',
  'ollama-local': 'llama3.2',
  'ollama-cloud': 'deepseek-v4-flash:cloud',
  'openai': 'gpt-4.1',
  'anthropic': 'claude-sonnet-4-5',
  'xai': 'grok-3',
  'moonshotai': 'kimi-k2.5',
  'openrouter': 'openai/gpt-4o',
  'groq': 'llama-3.3-70b-versatile',
  'zai': 'glm-5.2',
}

/**
 * Prompt a first-run user to pick a composed route and, when needed, enter
 * its credential.
 * @param props - settings-shell owner state and Models feature dependencies.
 * @returns the onboarding modal or null when onboarding needs no intervention.
 */
export function FirstRunOnboardingDialog(props: FirstRunOnboardingDialogProps): ReactNode {
  const { complete, controller, useModels, api, t } = props
  const state = useModels(snapshot => snapshot)
  const readiness = onboardingReadiness(state)
  const candidates = onboardingCandidates(state.rows)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [writeError, setWriteError] = useState<string | undefined>(undefined)
  const [ollamaBusy, setOllamaBusy] = useState(false)

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  useEffect(() => {
    if (
      readiness.kind === 'adapter-absent'
      || readiness.kind === 'provider-ready'
      || readiness.kind === 'unavailable'
    ) complete()
  }, [complete, readiness.kind])

  switch (readiness.kind) {
    case 'loading':
    case 'adapter-absent':
    case 'provider-ready':
    case 'unavailable':
      return null
    case 'credential-missing':
      break
    /* v8 ignore next -- every current readiness variant is handled above */
    default:
      return assertNever(readiness)
  }

  const selectedRow = resolveSelected(candidates, selected)
  const showPicker = candidates.length > 1
  const keyedRow = selectedRow !== undefined && selectedRow.apiKeyEnv !== undefined
    ? selectedRow
    : undefined
  const namespace = keyedRow === undefined ? undefined : state.namespaces.get(keyedRow.entry.settingsNs)

  const finishCredential = (changed: boolean): void => {
    if (!changed) {
      complete()
      return
    }
    /* v8 ignore next 4 -- onClose is only wired while a keyed row is rendered */
    if (keyedRow === undefined) {
      void controller.load()
      return
    }
    const row = keyedRow
    void (async () => {
      const error = await saveDefault(api, row.entry.provider, row.entry.settingsNs)
      if (error !== undefined) {
        setWriteError(error)
        return
      }
      complete()
    })()
  }

  const useOllama = async (): Promise<void> => {
    setOllamaBusy(true)
    setWriteError(undefined)
    try {
      const error = await saveDefault(api, 'ollama-local', 'llm-pi-ai')
      if (error !== undefined) {
        setWriteError(error)
        return
      }
      complete()
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error))
    } finally {
      setOllamaBusy(false)
    }
  }

  return (
    <OnboardingModal title={t('onboardingTitle')}>
      <p className={styles.description}>{t('onboardingDescription')}</p>
      {writeError === undefined || selectedRow?.entry.provider === 'ollama-local'
        ? null
        : <p className={styles.description}>{writeError}</p>}
      {showPicker && selectedRow !== undefined
        ? (
          <div className={styles.editor}>
            <label className={styles.description}>
              {t('onboardingPickProvider')}
              <select
                className={modelStyles['selectInput']}
                aria-label={t('onboardingPickProvider')}
                value={selectedRow.entry.provider}
                onChange={(event) => { setSelected(event.target.value) }}
              >
                {candidates.map(row => (
                  <option key={row.entry.provider} value={row.entry.provider}>
                    {row.entry.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )
        : null}
      {selectedRow?.entry.provider === 'ollama-local'
        ? (
          <div className={styles.editor}>
            <p className={styles.description}>{t('onboardingOllama')}</p>
            {writeError === undefined ? null : <p className={styles.description}>{writeError}</p>}
            <button type="button" disabled={ollamaBusy} onClick={() => { void useOllama() }}>
              {ollamaBusy ? t('onboardingSaving') : t('onboardingUseOllama')}
            </button>
          </div>
        )
        : null}
      {keyedRow !== undefined && namespace !== undefined
        ? (
          <div className={styles.editor}>
            <ProviderEditor
              provider={keyedRow.entry.provider}
              displayName={keyedRow.entry.displayName}
              namespace={namespace}
              settingsPath={keyedRow.entry.settingsPath}
              api={api}
              t={t}
              readOnly={false}
              hideTitle
              credentialOnly
              credentialRequired
              autoFocusCredential
              cancelLabel="onboardingLater"
              submitLabel="onboardingSave"
              submitBusyLabel="onboardingSaving"
              onClose={finishCredential}
            />
          </div>
        )
        : null}
      {selectedRow?.entry.provider === 'ollama-local'
        ? (
          <div className={styles.editor}>
            <button type="button" onClick={() => { complete() }}>{t('onboardingLater')}</button>
          </div>
        )
        : null}
    </OnboardingModal>
  )
}

/** @deprecated Use {@link FirstRunOnboardingDialog}. */
export const DeepSeekOnboardingDialog = FirstRunOnboardingDialog

/** The selected row, or the only candidate, or the first candidate. */
function resolveSelected(candidates: readonly ProviderRow[], selected: string | undefined): ProviderRow | undefined {
  /* v8 ignore next -- credential-missing always has at least one candidate */
  if (candidates.length === 0) return undefined
  if (selected !== undefined) {
    const match = candidates.find(row => row.entry.provider === selected)
    if (match !== undefined) return match
  }
  return candidates[0]
}

/**
 * Persist the first-run default for a just-configured route.
 * @param api - settings and llm wire faces.
 * @param provider - chosen route.
 * @param settingsNs - adapter namespace used for discovery.
 */
async function saveDefault(
  api: Pick<IApiClient, 'settings' | 'llm'>,
  provider: string,
  settingsNs: string,
): Promise<string | undefined> {
  const model = await discoverDefaultModel(api, provider, settingsNs)
  if (provider === 'ollama-local') {
    const adopted = await api.settings.mutate({
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'ollama-local', 'models'], value: [{ id: model }] }],
    })
    if (!adopted.result.ok) return adopted.result.error.message
  }
  const stored = await api.settings.replace({ ns: 'agent-default-model', section: { provider, model } })
  if (!stored.result.ok) return stored.result.error.message
  return undefined
}

/**
 * First advertised model for a route, or a pinned fallback.
 * @param api - llm wire face.
 * @param provider - route key.
 * @param settingsNs - adapter namespace.
 * @returns a model id the route can name.
 */
async function discoverDefaultModel(
  api: Pick<IApiClient, 'llm'>,
  provider: string,
  settingsNs: string,
): Promise<string> {
  const response = await api.llm.discoverModels({ settingsNs, provider })
  if (response.result.ok && response.result.value.models[0] !== undefined) {
    return response.result.value.models[0].id
  }
  /* v8 ignore next -- every composed route the card can pick has a fallback */
  return FALLBACK_MODELS[provider] ?? provider
}
