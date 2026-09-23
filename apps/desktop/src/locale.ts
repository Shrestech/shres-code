/** Typed English copy owned by the Electron shell. */

/** Every English message the Desktop renderers and emergency documents display. */
export const en = {
  application: 'Application',
  startupFailed: 'Shres Code could not start',
  startupLoading: 'Starting Shres Code…',
  startupLoadingDescription: 'Your workspace will open when it is ready.',
  startupErrorDescription: 'Choose a recovery action below. Disabling third-party plugins retains their files.',
  startupReinstallAdvice: 'If application files are missing or damaged, close the application and reinstall it. Your tasks are stored separately.',
  startupConfigurationAdvice: 'Reset Desktop deletes all Desktop profile configuration and third-party plugins without a backup, then starts a fresh profile. Shared tasks and settings are retained.',
  restartApplication: 'Close and restart',
  resetConfiguration: 'Reset Desktop and retry',
  disableThirdPartyPlugins: 'Disable all third-party plugins and retry',
  pluginsMenu: 'Desktop Plugins…',
  pluginsMenuPackagedOnly: 'Desktop Plugins… (available in packaged applications)',
  checkUpdatesMenu: 'Check for Updates…',
  updateCheckFailedTitle: 'Update Check Failed',
  unknownError: 'Unknown error',
  updateCheckTitle: 'Check for Updates',
  updateCurrent: 'You already have the latest version.',
  updateTitle: 'Shres Code Update',
  updateAvailable: 'An update is available',
  updateDetail: 'Shres Code {version}\n\nThis release includes its matching shres version. The application will restart after installation.',
  installAndRestart: 'Install and Restart',
  later: 'Later',
  updateFailedTitle: 'Update Failed',
  pluginManagerTitle: 'Desktop Plugins',
  pluginWindowTitle: 'Shres Code — Desktop Plugins',
  pluginManagerDescription: 'Plugins are installed only in the Desktop node_modules and are managed by the bundled pnpm.',
  refresh: 'Refresh',
  enable: 'Enable',
  disable: 'Disable',
  disabled: 'Disabled',
  retry: 'Retry startup',
  disableAll: 'Disable all plugins and retry',
  recoveryDescription: 'The backend could not start. Update or disable incompatible plugins, then retry. Installed plugins and configuration are retained.',
  changingActivation: 'Changing plugin activation…',
  npmPackage: 'npm package',
  install: 'Install',
  installed: 'Installed',
  noPlugins: 'No Desktop plugins are installed.',
  remove: 'Remove',
  update: 'Update',
  targetVersion: 'Enter the target version for {name}',
  removing: 'Removing {name}…',
  updating: 'Updating {name}…',
  installing: 'Installing {spec}…',
  operationComplete: 'Done. The Desktop backend has restarted.',
  refreshing: 'Refreshing…',
  refreshed: 'Plugin list refreshed.',
  loadingPlugins: 'Reading Desktop plugins…',
} as const

/** The complete message key set every Desktop locale supplies. */
export type DesktopMessages = { readonly [Key in keyof typeof en]: string }

/** Locale payload exposed to the Desktop-owned renderer. */
export interface DesktopLocale {
  readonly id: 'en'
  readonly messages: DesktopMessages
}

/**
 * Resolve Electron's locale to one shipped Desktop dictionary.
 * @param _locale - Electron locale tag; the shell ships English only, so every tag resolves to it.
 * @returns The English dictionary.
 */
export function resolveDesktopLocale(_locale: string): DesktopLocale {
  return { id: 'en', messages: en }
}

/**
 * Replace named placeholders in one locale-owned message.
 * @param message - Message text containing placeholders such as {name}.
 * @param values - Replacement values keyed by placeholder name.
 * @returns The message with every known placeholder replaced; unknown placeholders stay intact.
 */
export function formatDesktopMessage(
  message: string,
  values: Readonly<Record<string, string>>,
): string {
  return message.replaceAll(/\{([^{}]+)\}/gu, (placeholder, key: string) => values[key] ?? placeholder)
}
