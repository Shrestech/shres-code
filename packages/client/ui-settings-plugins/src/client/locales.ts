/** Locale bundles for the plugin configuration section and its plugin cards. */

/** Locale keys these surfaces render. */
export type PluginsSettingsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'tabs' | 'configurableTab' | 'empty'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber'
  | 'bashTitle' | 'bashDescription' | 'bashTimeoutMs' | 'bashTimeoutMsHint'
  | 'bashMaxOutputBytes' | 'bashMaxOutputBytesHint'
  | 'agentLoopTitle' | 'agentLoopDescription' | 'agentLoopMaxParallel' | 'agentLoopMaxParallelHint'
  | 'webSearchTitle' | 'webSearchDescription' | 'webSearchMethods'
  | 'providerUnavailable'
  | 'webSearchBrave' | 'webSearchBraveHint' | 'webSearchBraveApiKey' | 'webSearchBraveBaseUrl'
  | 'webSearchGrok' | 'webSearchGrokHint'
  | 'webSearchClaude' | 'webSearchClaudeHint'
  | 'webSearchCodex' | 'webSearchCodexHint'
  | 'webSearchKimi' | 'webSearchKimiHint'
  | 'webSearchOllama' | 'webSearchOllamaHint'
  | 'webSearchZai' | 'webSearchZaiHint'
  | 'webSearchPerplexity' | 'webSearchPerplexityHint' | 'webSearchPerplexityApiKey' | 'webSearchPerplexityBaseUrl'
  | 'webSearchDeepSeek' | 'webSearchDeepSeekHint'
  | 'webSearchApiKey' | 'webSearchApiKeyHint' | 'webSearchApiKeySet' | 'webSearchApiKeyUnset'
  | 'webSearchBaseUrl' | 'webSearchBaseUrlHint' | 'webSearchMaxUses' | 'webSearchMaxUsesHint'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Plugins',
  title: 'Plugins',
  intro: 'Configure and inspect the plugins installed in this deployment.',
  tabs: 'Plugin views',
  configurableTab: 'Plugin configuration',
  empty: 'This deployment exposes no plugin settings.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  bashTitle: 'Shell',
  bashDescription: 'Limits every command the agent runs.',
  bashTimeoutMs: 'Command timeout (ms)',
  bashTimeoutMsHint: 'How long one command may run before it is terminated.',
  bashMaxOutputBytes: 'Output cap per stream (bytes)',
  bashMaxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  agentLoopTitle: 'Agent loop',
  agentLoopDescription: 'How the agent dispatches tool calls.',
  agentLoopMaxParallel: 'Parallel tool calls',
  agentLoopMaxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  webSearchTitle: 'Web search',
  webSearchDescription: 'Turn on the search methods the agent may use.',
  webSearchMethods: 'Methods',
  providerUnavailable: 'This provider is not installed or its settings are unavailable.',
  webSearchBrave: 'Brave',
  webSearchBraveHint: 'First in the default web_search order when enabled and a key is configured; other methods are fallbacks.',
  webSearchBraveApiKey: 'Brave API key',
  webSearchBraveBaseUrl: 'Brave endpoint',
  webSearchGrok: 'Grok',
  webSearchGrokHint: 'Web results using XAI_API_KEY. For subscription-backed X tools and sharing with other agents, open Settings → Models & providers → Grok (subscription).',
  webSearchClaude: 'Claude',
  webSearchClaudeHint: 'Anthropic web search, using the same key as the Claude CLI.',
  webSearchCodex: 'Codex',
  webSearchCodexHint: 'OpenAI web search, using the same key as the Codex CLI.',
  webSearchKimi: 'Kimi',
  webSearchKimiHint: 'Moonshot web search, using the same key as the Kimi CLI.',
  webSearchOllama: 'Ollama',
  webSearchOllamaHint: 'Ollama Cloud web search, using the same key as Ollama Cloud chat.',
  webSearchZai: 'Z.AI',
  webSearchZaiHint: 'Z.AI web search, using the same key as Z.AI chat.',
  webSearchPerplexity: 'Perplexity',
  webSearchPerplexityHint: 'Powers deep_research, not routine web_search. Requires a Perplexity API key.',
  webSearchPerplexityApiKey: 'Perplexity API key',
  webSearchPerplexityBaseUrl: 'Perplexity endpoint',
  webSearchDeepSeek: 'DeepSeek',
  webSearchDeepSeekHint: 'Last in the default web_search fallback order. Requires a DeepSeek API key.',
  webSearchApiKey: 'DeepSeek API key',
  webSearchApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  webSearchApiKeySet: 'A key is configured.',
  webSearchApiKeyUnset: 'No key is configured; search is unavailable until one is.',
  webSearchBaseUrl: 'DeepSeek endpoint',
  webSearchBaseUrlHint: 'Leave blank to use the provider default.',
  webSearchMaxUses: 'Max searches per request',
  webSearchMaxUsesHint: 'How many times one request may search before it must answer.',
}

