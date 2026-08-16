/**
 * The web-search card: method switches, then DeepSeek's key, endpoint, and
 * budget when that method is on. The key is written through the credentials
 * domain, never into a settings section.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@roos-code/roos-code-client-ui-slots'
import { SecretField, SwitchField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import css from './fields.module.css'
import type { WebSearchCardFace } from './web-search-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the web-search card. */
export type WebSearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebSearchCardFace>

/**
 * Render the web-search card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  const disabled = !state.writable
  const deepseekOn = state.deepseek.text !== 'false'
  return (
    <PluginCard
      t={t}
      titleKey="webSearchTitle"
      descriptionKey="webSearchDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <p className={css.methodsTitle}>{t('webSearchMethods')}</p>
      <div className={css.methods}>
        <SwitchField
          id="plugin-config-web-search-grok"
          label={t('webSearchGrok')}
          hint={t('webSearchGrokHint')}
          text={state.grok.text}
          disabled={disabled}
          onEdit={(text) => { props.edit('grok', text) }}
        />
        <SwitchField
          id="plugin-config-web-search-claude"
          label={t('webSearchClaude')}
          hint={t('webSearchClaudeHint')}
          text={state.claude.text}
          disabled={disabled}
          onEdit={(text) => { props.edit('claude', text) }}
        />
        <SwitchField
          id="plugin-config-web-search-codex"
          label={t('webSearchCodex')}
          hint={t('webSearchCodexHint')}
          text={state.codex.text}
          disabled={disabled}
          onEdit={(text) => { props.edit('codex', text) }}
        />
        <SwitchField
          id="plugin-config-web-search-kimi"
          label={t('webSearchKimi')}
          hint={t('webSearchKimiHint')}
          text={state.kimi.text}
          disabled={disabled}
          onEdit={(text) => { props.edit('kimi', text) }}
        />
        <SwitchField
          id="plugin-config-web-search-deepseek"
          label={t('webSearchDeepSeek')}
          hint={t('webSearchDeepSeekHint')}
          text={state.deepseek.text}
          disabled={disabled}
          onEdit={(text) => { props.edit('enabled', text) }}
        />
      </div>
      {deepseekOn
        ? (
          <>
            <SecretField
              id="plugin-config-web-search-key"
              label={t('webSearchApiKey')}
              hint={t('webSearchApiKeyHint')}
              // The credentials domain accepts a key even when the settings document
              // itself is read-only; they are separate stores with separate refusals.
              // Its own writability is what disables this control — a key sourced
              // from the process environment cannot be written from here.
              disabled={!state.apiKeyWritable}
              text={state.apiKey.text}
              configured={state.apiKeyConfigured}
              stateLabel={state.apiKeyConfigured ? t('webSearchApiKeySet') : t('webSearchApiKeyUnset')}
              onEdit={(text) => { props.edit('apiKey', text) }}
            />
            <ValueField
              id="plugin-config-web-search-endpoint"
              label={t('webSearchBaseUrl')}
              hint={t('webSearchBaseUrlHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidNumber')}
              disabled={disabled}
              {...state.baseURL}
              onEdit={(text) => { props.edit('baseURL', text) }}
              onReset={() => { props.resetField('baseURL') }}
            />
            <ValueField
              id="plugin-config-web-search-max-uses"
              label={t('webSearchMaxUses')}
              hint={t('webSearchMaxUsesHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidNumber')}
              numeric
              disabled={disabled}
              {...state.maxUses}
              onEdit={(text) => { props.edit('maxUses', text) }}
              onReset={() => { props.resetField('maxUses') }}
            />
          </>
        )
        : null}
    </PluginCard>
  )
}
