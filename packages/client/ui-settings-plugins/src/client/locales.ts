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
  webSearchGrok: 'Grok',
  webSearchGrokHint: 'xAI web search, using the same key as the Grok CLI.',
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
  webSearchPerplexityHint: 'Perplexity web search. Turn this off if you do not have a Perplexity key.',
  webSearchPerplexityApiKey: 'Perplexity API key',
  webSearchPerplexityBaseUrl: 'Perplexity endpoint',
  webSearchDeepSeek: 'DeepSeek',
  webSearchDeepSeekHint: 'DeepSeek web search. Turn this off if you do not have a DeepSeek key.',
  webSearchApiKey: 'API key',
  webSearchApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  webSearchApiKeySet: 'A key is configured.',
  webSearchApiKeyUnset: 'No key is configured; search is unavailable until one is.',
  webSearchBaseUrl: 'Endpoint',
  webSearchBaseUrlHint: 'Leave blank to use the provider default.',
  webSearchMaxUses: 'Max searches per request',
  webSearchMaxUsesHint: 'How many times one request may search before it must answer.',
}

