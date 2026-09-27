/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** English dictionary, the key-set source of truth. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'Preferences',
  'appearance.nav': 'Appearance',
  'general.heading': 'Your workspace, your way.',
  'general.description': 'Preferences for everyday work.',
  'navigation.home': 'Shres home',
  'navigation.workspace': 'Workspace',
  'navigation.teams': 'Teams',
  'navigation.plugins': 'Plugins',
  'navigation.customize': 'Customize',
  'navigation.label': 'Main navigation',
  'description.settings': 'Set up Shres for the way you work.',
  'description.teams': 'Give each teammate a role, a model, and a clear purpose.',
  'description.plugins': 'Choose installed bundles and configure their features.',
  'description.customize': 'Shape your agent with presets.',
  'search': 'Search settings…',
  'search.empty': 'No matching sections.',
  'group.defaults': 'Session defaults',
  'group.defaults.description': 'Set the starting point for new sessions.',
  'group.interaction': 'Interaction',
  'group.interaction.description': 'Control how Shres behaves while you work.',
  'group.appearance': 'Appearance',
  'group.appearance.description': 'Choose how Shres looks on your device.',
  'group.more': 'More preferences',
  'group.more.description': 'Preferences from your installed plugins.',
} satisfies Record<string, string>

/** The SettingsKey union. */
export type SettingsKey = keyof typeof en
