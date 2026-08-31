/**
 * `remote` namespace dictionaries: the sidebar group (header, rows, badge,
 * add form), the trust modal, and the LAN degraded hint. Wire failure
 * messages (gateway envelope text) pass through untranslated by policy.
 */

/** English dictionary, the key-set source of truth. */
export const en = {
  'section.remotes': 'Remotes',
  'fold.hide': 'Hide remotes',
  'fold.show': 'Show remotes',
  'status.open': 'Connected',
  'status.connecting': 'Connecting',
  'status.closed': 'Not connected',
  'status.error': 'Connection error',
  'badge.aria': 'Connected remotes',
  'badge.openTab': 'Open tab',
  'badge.disconnect': 'Disconnect',
  'row.connect.aria': 'Connect {alias}',
  'row.menu.aria': 'Remote actions for {alias}',
  'row.menu.open': 'Open in new tab',
  'row.menu.edit': 'Edit',
  'row.menu.remove': 'Remove',
  'row.remove.confirm': 'Remove remote {alias}?',
  'row.remove.yes': 'Remove',
  'row.remove.cancel': 'Cancel',
  'row.remove.refused': 'Disconnect {alias} before removing it.',
  'form.add': 'Add remote…',
  'form.alias': 'Alias',
  'form.target': 'Target (user@host)',
  'form.port': 'Remote port',
  'form.save': 'Save',
  'form.cancel': 'Cancel',
  'form.editing': 'Editing {alias}',
  'form.error': '{message}',
  'degraded.hint': 'Remotes are managed on the machine running the app.',
  'modal.title': 'Connect to {alias}',
  'modal.field.target': 'Target',
  'modal.field.version': 'Remote version',
  'modal.version.match': '{version} — matches this app',
  'modal.version.skew': '{observed} — this app runs {local}',
  'modal.version.absent': 'No daemon answered on the remote port.',
  'modal.field.fingerprint': 'Installation id',
  'modal.fingerprint.first': 'First connection to this remote — connecting trusts the installation id below.',
  'modal.fingerprint.changed': 'The remote’s installation changed since the last connection.',
  'modal.fingerprint.match': 'Matches the installation this app trusts.',
  'modal.connect': 'Trust and connect',
  'modal.connectAnyway': 'Connect anyway',
  'modal.retry': 'Retry',
  'modal.cancel': 'Cancel',
  'modal.close': 'Close',
  'modal.inspecting': 'Checking the remote…',
  'modal.connecting': 'Connecting…',
  'modal.failed': 'Connection failed',
} satisfies Record<string, string>

/** The RemoteKey union. */
export type RemoteKey = keyof typeof en
