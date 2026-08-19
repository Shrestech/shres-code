/** Copy dictionaries for the J-Space settings section. */

/** English strings (the key-set source of truth). */
export const en = {
  nav: 'J-Space',
  title: 'J-Space',
  intro: 'J-Space is an allow switch. On mounts the card tools and prompt section. Off unloads them.',
  activate: 'Activate',
  disable: 'Disable',
  active: 'Active',
  inactive: 'Disabled',
  toggleHint: 'Turn J-Space on or off. Off unloads the tools, prompt section, and session chip.',
  unavailable: 'The J-Space host seat is not mounted in this deployment, so this page cannot load its settings.',
  loading: 'Loading J-Space settings…',
  readOnly: 'The settings document is read-only in this deployment.',
  mode: 'Mode',
  modeHint: 'Available waits for an open. Always open starts the stock Goal/Next on the first pre-step of a session that has none.',
  modeAvailable: 'Available',
  modeAlwaysOpen: 'Always open',
  requireCoverage: 'Require coverage',
  requireCoverageHint: 'A checkpoint must name coverage and cite the successful check call.',
  coverageHonesty: 'Checkpoints cite a successful call; the harness cannot prove that call covered the claim.',
  session: 'This session',
  open: 'Open',
  closed: 'Closed',
  checked: 'Checked',
}

/** The JSpaceKey union. */
export type JSpaceKey = keyof typeof en
