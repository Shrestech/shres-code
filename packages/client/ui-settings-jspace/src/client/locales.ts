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
  requireCoverageHint: 'A checkpoint must name a verifier and a coverage claim.',
  coverageHonesty: 'Checkpoints name a verifier; the harness cannot prove it ran.',
  session: 'This session',
  open: 'Open',
  closed: 'Closed',
  checked: 'Checked',
  wikiTitle: 'LLM Wiki',
  wikiIntro:
    'WikiSkill: persistent knowledge wiki improved benchmark scores up to +24 pts; 9B + wiki beat 27B without.',
  wikiToggleHint:
    'On mounts the wiki tools. Off unloads them. No directory is created until the first write.',
  wikiActive: 'Active',
  wikiInactive: 'Disabled',
  wikiActivate: 'Enable LLM Wiki',
  wikiDisable: 'Disable LLM Wiki',
  wikiLibrarian: 'Librarian',
  wikiModelHint:
    'Bind a cheap or local model for librarian consolidation. Unbound, the librarian stays dormant and never uses the session frontier model.',
  wikiProvider: 'Provider',
  wikiModel: 'Model',
  wikiUnbound: 'Unbound',
}

/** The JSpaceKey union. */
export type JSpaceKey = keyof typeof en
