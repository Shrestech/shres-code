/** Search-provider switches and independent, draft-preserving credential disclosures. */

import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import { SecretField, SwitchField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import css from './fields.module.css'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import type { WebSearchCardFace, WebSearchCardState } from './web-search-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the web-search card. */
export type WebSearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebSearchCardFace>

interface ProviderSectionProps {
  id: string
  label: string
  hint: string
  text: string
  configured: boolean
  known: boolean
  dirty: boolean
  available: boolean
  writable: boolean
  t: (key: PluginsSettingsLocaleKey) => string
  onEdit: (text: string) => void
  children: ReactNode
}

/** Disclosure is a reading preference, independent of provider enablement. */
function ProviderSection(props: ProviderSectionProps) {
  const [override, setOverride] = useState<boolean>()
  const open = override ?? (props.dirty || (props.known && !props.configured))
  const enabled = props.available && props.text !== 'false'
  const detailsId = `${props.id}-details`
  return (
    <section className={css.provider}>
      <SwitchField
        id={props.id}
        label={props.label}
        hint={props.available ? props.hint : props.t('providerUnavailable')}
        text={props.available ? props.text : 'false'}
        disabled={!props.available || !props.writable}
        onEdit={props.onEdit}
      />
      {enabled
        ? (
          <>
            <button
              type="button"
              className={css.disclosure}
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => { setOverride(!open) }}
            >
              {props.t(open ? 'collapse' : 'expand')}: {props.label}
            </button>
            <div id={detailsId} hidden={!open}>{props.children}</div>
          </>
        )
        : null}
    </section>
  )
}

interface ProviderFields {
  id: 'brave' | 'perplexity' | 'deepseek'
  label: PluginsSettingsLocaleKey
  hint: PluginsSettingsLocaleKey
  keyLabel: PluginsSettingsLocaleKey
  endpointLabel: PluginsSettingsLocaleKey
  enabledField: string
  keyField: string
  endpointField: string
  enabled: WebSearchCardState['brave']
  apiKey: WebSearchCardState['braveApiKey']
  baseURL: WebSearchCardState['braveBaseURL']
  configured: boolean
  known: boolean
  keyWritable: boolean
}

/**
 * Render the web-search card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  const providers: ProviderFields[] = [
    {
      id: 'brave', label: 'webSearchBrave', hint: 'webSearchBraveHint',
      keyLabel: 'webSearchBraveApiKey', endpointLabel: 'webSearchBraveBaseUrl',
      enabledField: 'braveEnabled', keyField: 'braveApiKey', endpointField: 'braveBaseURL',
      enabled: state.brave, apiKey: state.braveApiKey, baseURL: state.braveBaseURL,
      configured: state.braveApiKeyConfigured, known: state.braveApiKeyKnown, keyWritable: state.braveApiKeyWritable,
    },
    {
      id: 'perplexity', label: 'webSearchPerplexity', hint: 'webSearchPerplexityHint',
      keyLabel: 'webSearchPerplexityApiKey', endpointLabel: 'webSearchPerplexityBaseUrl',
      enabledField: 'perplexityEnabled', keyField: 'perplexityApiKey', endpointField: 'perplexityBaseURL',
      enabled: state.perplexity, apiKey: state.perplexityApiKey, baseURL: state.perplexityBaseURL,
      configured: state.perplexityApiKeyConfigured, known: state.perplexityApiKeyKnown, keyWritable: state.perplexityApiKeyWritable,
    },
    {
      id: 'deepseek', label: 'webSearchDeepSeek', hint: 'webSearchDeepSeekHint',
      keyLabel: 'webSearchApiKey', endpointLabel: 'webSearchBaseUrl',
      enabledField: 'enabled', keyField: 'apiKey', endpointField: 'baseURL',
      enabled: state.deepseek, apiKey: state.apiKey, baseURL: state.baseURL,
      configured: state.apiKeyConfigured, known: state.apiKeyKnown, keyWritable: state.apiKeyWritable,
    },
  ]
  const methods = [
    ['grok', 'webSearchGrok', 'webSearchGrokHint'],
    ['claude', 'webSearchClaude', 'webSearchClaudeHint'],
    ['codex', 'webSearchCodex', 'webSearchCodexHint'],
    ['kimi', 'webSearchKimi', 'webSearchKimiHint'],
    ['ollama', 'webSearchOllama', 'webSearchOllamaHint'],
    ['zai', 'webSearchZai', 'webSearchZaiHint'],
  ] as const
  const renderProvider = (provider: ProviderFields) => (
    <ProviderSection
      key={provider.id}
      id={`plugin-config-web-search-${provider.id}`}
      label={t(provider.label)}
      hint={t(provider.hint)}
      text={provider.enabled.text}
      configured={provider.configured}
      known={provider.known}
      {...state.providers[provider.id]}
      t={t}
      onEdit={(text) => { props.edit(provider.enabledField, text) }}
    >
      <SecretField
        id={`plugin-config-web-search-${provider.id}-key`}
        label={t(provider.keyLabel)}
        hint={t('webSearchApiKeyHint')}
        disabled={!provider.keyWritable}
        text={provider.apiKey.text}
        configured={provider.configured}
        stateLabel={provider.configured ? t('webSearchApiKeySet') : t('webSearchApiKeyUnset')}
        onEdit={(text) => { props.edit(provider.keyField, text) }}
      />
      <ValueField
        id={`plugin-config-web-search-${provider.id}-endpoint`}
        label={t(provider.endpointLabel)}
        hint={t('webSearchBaseUrlHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={!state.providers[provider.id].writable}
        {...provider.baseURL}
        onEdit={(text) => { props.edit(provider.endpointField, text) }}
        onReset={() => { props.resetField(provider.endpointField) }}
      />
      {provider.id === 'deepseek'
        ? (
          <ValueField
            id="plugin-config-web-search-max-uses"
            label={t('webSearchMaxUses')}
            hint={t('webSearchMaxUsesHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalidNumber')}
            numeric
            disabled={!state.providers.deepseek.writable}
            {...state.maxUses}
            onEdit={(text) => { props.edit('maxUses', text) }}
            onReset={() => { props.resetField('maxUses') }}
          />
        )
        : null}
    </ProviderSection>
  )
  return (
    <PluginCard t={t} titleKey="webSearchTitle" descriptionKey="webSearchDescription" state={state} onSave={props.save} onDiscard={props.discard}>
      <p className={css.methodsTitle}>{t('webSearchMethods')}</p>
      <div className={css.methods}>
        {providers.filter(provider => provider.id === 'brave').map(renderProvider)}
        {methods.map(([field, label, hint]) => (
          <SwitchField
            key={field}
            id={`plugin-config-web-search-${field}`}
            label={t(label)}
            hint={state.providers.methods.available ? t(hint) : t('providerUnavailable')}
            text={state[field].text}
            disabled={!state.providers.methods.available || !state.providers.methods.writable}
            onEdit={(text) => { props.edit(field, text) }}
          />
        ))}
        {providers.filter(provider => provider.id !== 'brave').map(renderProvider)}
      </div>
    </PluginCard>
  )
}
