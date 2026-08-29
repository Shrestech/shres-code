/**
 * Canonical publication manifest for the documentation website.
 *
 * Markdown stays in its owning repository tier. This manifest maps each
 * canonical English source into the documentation site's route tree.
 */

/** Locale key used by the VitePress site. */
export type DocsLocale = 'root'

/** Sidebar collection rendered for one top-level module. */
export type DocsSidebar = 'guide' | 'develop' | 'reference'

/** A page projected into the VitePress source tree. */
export interface DocsPage {
  /** VitePress locale whose route tree owns this projection. */
  locale: DocsLocale
  /** Language of the canonical source currently projected at this route. */
  contentLocale: 'en-US'
  /** Repository-relative canonical Markdown source. */
  source: string
  /** VitePress route, including the `.md` suffix. */
  route: string
  /** Navigation label shown in the sidebar. */
  label: string
  /** Sidebar collection that owns the page, or null for a locale home page. */
  sidebar: DocsSidebar | null
  /** Section label within the sidebar. */
  section: string
  /** Stable order within the section. */
  order: number
  /** Heading levels included in this page's VitePress outline. */
  outline?: number | readonly [number, number] | 'deep' | false
  /** Additional repository paths that resolve to this page. */
  sourceAliases?: string[]
}

interface EnglishPage {
  source: string
  route: string
  label: string
  sidebar: DocsSidebar | null
  section: string
  order: number
  outline?: DocsPage['outline']
  sourceAliases?: string[]
}

function englishPages(pages: EnglishPage[]): DocsPage[] {
  return pages.map((page) => {
    const { outline, sourceAliases, ...rest } = page
    return {
      locale: 'root',
      contentLocale: 'en-US',
      ...rest,
      ...outline === undefined ? {} : { outline },
      ...sourceAliases === undefined ? {} : { sourceAliases },
    }
  })
}

const homeAndGuide = englishPages([
  {
    source: 'docs/user/index.md',
    route: 'index.md',
    label: 'Shres Code',
    sidebar: null,
    section: 'Home',
    order: 0,
  },
  {
    source: 'docs/user/guide/index.md',
    route: 'guide/quickstart.md',
    label: 'Use the Web UI',
    sidebar: 'guide',
    section: 'Guide',
    order: 1,
    sourceAliases: ['docs/user/guide'],
  },
  {
    source: 'docs/user/guide/providers.md',
    route: 'guide/providers.md',
    label: 'Configure models',
    sidebar: 'guide',
    section: 'Guide',
    order: 2,
  },
  {
    source: 'docs/user/guide/models.md',
    route: 'guide/models.md',
    label: 'Manage models from the CLI',
    sidebar: 'guide',
    section: 'Guide',
    order: 3,
  },
  {
    source: 'docs/user/guide/subagents.md',
    route: 'guide/subagents.md',
    label: 'Delegate to product CLIs',
    sidebar: 'guide',
    section: 'Guide',
    order: 4,
  },
  {
    source: 'docs/user/guide/python-sdk.md',
    route: 'guide/python-sdk.md',
    label: 'Python',
    sidebar: 'guide',
    section: 'SDK',
    order: 1,
  },
])

const develop = englishPages([
  {
    source: 'docs/user/develop/basic/index.md',
    route: 'develop/basic/index.md',
    label: 'Your first Harness plugin',
    sidebar: 'develop',
    section: 'Basics',
    order: 1,
    sourceAliases: ['docs/user/develop/basic'],
  },
  {
    source: 'docs/user/develop/basic/tool.md',
    route: 'develop/basic/tool.md',
    label: 'Build a tool',
    sidebar: 'develop',
    section: 'Basics',
    order: 2,
  },
  {
    source: 'docs/user/develop/basic/config.md',
    route: 'develop/basic/config.md',
    label: 'Plugin configuration',
    sidebar: 'develop',
    section: 'Basics',
    order: 3,
  },
  {
    source: 'docs/user/develop/basic/publish.md',
    route: 'develop/basic/publish.md',
    label: 'Package and install',
    sidebar: 'develop',
    section: 'Basics',
    order: 4,
  },
  {
    source: 'docs/user/develop/framework/index.md',
    route: 'develop/framework/index.md',
    label: 'Plugin lifecycle',
    sidebar: 'develop',
    section: 'Framework',
    order: 1,
    sourceAliases: ['docs/user/develop/framework'],
  },
  {
    source: 'docs/user/develop/framework/service.md',
    route: 'develop/framework/service.md',
    label: 'Services and dependencies',
    sidebar: 'develop',
    section: 'Framework',
    order: 2,
  },
  {
    source: 'docs/user/develop/framework/events.md',
    route: 'develop/framework/events.md',
    label: 'Event system',
    sidebar: 'develop',
    section: 'Framework',
    order: 3,
  },
  {
    source: 'docs/user/develop/practice/index.md',
    route: 'develop/practice/index.md',
    label: 'Capability layering',
    sidebar: 'develop',
    section: 'Practice',
    order: 1,
    sourceAliases: ['docs/user/develop/practice'],
  },
  {
    source: 'docs/user/develop/practice/llm-adapter.md',
    route: 'develop/practice/llm-adapter.md',
    label: 'LLM adapter',
    sidebar: 'develop',
    section: 'Practice',
    order: 2,
  },
])

const cordisTutorial = englishPages(([
  ['index.md', 'Overview'],
  ['01-first-plugin.md', '1. Your first plugin'],
  ['02-lifecycle-and-effects.md', '2. Lifecycle and effects'],
  ['03-services.md', '3. Services'],
  ['04-events.md', '4. Events'],
  ['05-config.md', '5. Configuration'],
  ['06-composition-and-hmr.md', '6. Composition and HMR'],
  ['07-into-the-harness.md', '7. Into the harness'],
] as const).map(([file, label], order): EnglishPage => ({
  source: `docs/cordis-tutorial/${file}`,
  route: `develop/cordis-tutorial/${file}`,
  label,
  sidebar: 'develop',
  section: 'Cordis framework tutorial',
  order,
  ...(file === 'index.md' ? { sourceAliases: ['docs/cordis-tutorial'] } : {}),
})))

const cordisPrimerReference = englishPages([
  {
    source: 'docs/cordis-primer.md',
    route: 'reference/cordis-primer.md',
    label: 'Cordis primer',
    sidebar: 'reference',
    section: 'Concepts',
    order: 1,
  },
])

/**
 * Subsystem pages grouped by the concern they document. One flat list of every
 * subsystem pushed the rest of the reference sidebar below the fold.
 */
const subsystemGroups = [
  ['Overview', [
    ['README.md', 'Subsystems'],
  ]],
  ['Core and scopes', [
    ['core.md', 'Core'],
    ['scope.md', 'Scopes'],
    ['invariants.md', 'Runtime invariants'],
  ]],
  ['Sessions and persistence', [
    ['session.md', 'Sessions'],
    ['session-query.md', 'Session query'],
    ['session-reference.md', 'Session references'],
    ['session-title.md', 'Session titles'],
    ['session-projection.md', 'Session projections'],
    ['persistence.md', 'Session persistence'],
    ['spill.md', 'Spill storage'],
    ['session-telemetry.md', 'SessionTelemetryBackend'],
  ]],
  ['Model and context', [
    ['llm-streaming.md', 'LLM streaming'],
    ['token-meter.md', 'Token metering'],
    ['system-prompt.md', 'System prompts'],
    ['compaction.md', 'Compaction'],
  ]],
  ['Execution and tools', [
    ['tools.md', 'Tools'],
    ['shell.md', 'Bash execution'],
    ['subprocess.md', 'Subprocesses'],
    ['terminal.md', 'PTY sessions'],
    ['jobs.md', 'Background jobs'],
    ['tracker.md', 'Experiment tracking'],
    ['filesystem.md', 'Filesystem'],
    ['lsp.md', 'LSP navigation'],
    ['code-runtime.md', 'Code runtime'],
    ['web.md', 'Web access'],
    ['speech.md', 'Speech I/O'],
    ['skills.md', 'Skills'],
    ['workflow.md', 'Workflows'],
    ['subagent.md', 'Subagents'],
  ]],
  ['Policy and interaction', [
    ['approval.md', 'Approvals'],
    ['permission-presets.md', 'Permission presets'],
    ['sandbox.md', 'Sandboxing'],
    ['plan.md', 'Plan mode'],
    ['jspace.md', 'J-Space'],
    ['wiki.md', 'Wiki'],
    ['guard.md', 'Guards'],
    ['user-questions.md', 'User interaction'],
    ['commands.md', 'Human commands'],
    ['goal.md', 'Goals'],
    ['schedule.md', 'Scheduled reminders'],
  ]],
  ['Platform and access', [
    ['web-server.md', 'HTTP server'],
    ['typert.md', 'Typert'],
    ['client-modules.md', 'Client modules'],
    ['storage.md', 'Storage'],
    ['workspace.md', 'Workspaces'],
    ['settings.md', 'User settings'],
    ['credentials.md', 'User credentials'],
  ]],
] as const

const subsystemsReference = subsystemGroups.flatMap(([section, files]) => englishPages(
  files.map(([file, label], order): EnglishPage => ({
    source: `docs/subsystems/${file}`,
    route: file === 'README.md' ? 'reference/subsystems/index.md' : `reference/subsystems/${file}`,
    label,
    sidebar: 'reference',
    section,
    order,
    // Subsystem pages carry long third-level sections a two-level outline reaches.
    outline: [2, 3],
    ...(file === 'README.md' ? { sourceAliases: ['docs/subsystems'] } : {}),
  })),
))

const reference = [
  ...englishPages(([
    ['docs/architecture.md', 'reference/index.md', 'Architecture', 0],
  ] as const).map(([source, route, label, order]): EnglishPage => ({
    source,
    route,
    label,
    sidebar: 'reference',
    section: 'Concepts',
    order,
  }))),
  ...englishPages(([
    ['docs/capability-seams.md', 'reference/capability-seams.md', 'Capability services', 2],
    ['docs/agent-lifecycle.md', 'reference/agent-lifecycle.md', 'Agent lifecycle', 3],
    ['docs/tool-execution-pipeline.md', 'reference/tool-execution-pipeline.md', 'Tool execution', 4],
  ] as const).map(([source, route, label, order]): EnglishPage => ({
    source,
    route,
    label,
    sidebar: 'reference',
    section: 'Concepts',
    order,
  }))),
  ...englishPages(([
    ['docs/config-catalog.md', 'reference/config-catalog.md', 'Plugin configuration'],
    ['docs/tool-catalog.md', 'reference/tool-catalog.md', 'Tool schemas'],
    ['docs/persistence-catalog.md', 'reference/persistence-catalog.md', 'Persistence events', 'deep'],
  ] as const).map(([source, route, label, outline], order): EnglishPage => ({
    source,
    route,
    label,
    sidebar: 'reference',
    section: 'Generated reference',
    order,
    ...(outline === undefined ? {} : { outline }),
  }))),
  ...englishPages(([
    ['context.md', 'Context'],
    ['events.md', 'Events'],
    ['fiber.md', 'Fiber'],
    ['registry.md', 'Plugin Registry'],
    ['service.md', 'Service'],
  ] as const).map(([file, label], order): EnglishPage => ({
    source: `docs/cordis-api/${file}`,
    route: `reference/cordis-api/${file}`,
    label,
    sidebar: 'reference',
    section: 'Cordis Core API',
    order,
  }))),
  ...englishPages(([
    ['inherited.md', 'Inherited surface'],
  ] as const).map(([file, label], order): EnglishPage => ({
    source: `docs/cordis-api/${file}`,
    route: `reference/cordis-api/${file}`,
    label,
    sidebar: 'reference',
    section: 'Cordis Core API',
    order: order + 5,
  }))),
  ...englishPages(([
    ['adding-a-package.md', 'Adding a package'],
    ['adding-a-tool.md', 'Adding a tool'],
    ['adding-an-llm-adapter.md', 'Adding an LLM adapter'],
    ['extension-cookbook.md', 'Extension patterns'],
  ] as const).map(([file, label], order): EnglishPage => ({
    source: `docs/cookbook/${file}`,
    route: `reference/cookbook/${file}`,
    label,
    sidebar: 'reference',
    section: 'Cookbook',
    order,
  }))),
  ...englishPages([{
    source: 'docs/cookbook/adding-a-conversation-node.md',
    route: 'reference/cookbook/adding-a-conversation-node.md',
    label: 'Adding a Conversation Node',
    sidebar: 'reference',
    section: 'Cookbook',
    order: 4,
  }]),
]

/** A sidebar group, matched to pages by `label`. */
export interface DocsSection {
  /** Group heading, equal to the `section` field of every page it holds. */
  label: string
  /** Render the group collapsed until it holds the page being read. */
  collapsed?: boolean
}

/**
 * Every sidebar group, in the order its locale renders it.
 *
 * The subsystem groups collapse because together they outnumber the rest of the
 * reference sidebar; expanded, they push every other group below the fold.
 */
const englishSections: readonly DocsSection[] = [
  { label: 'Guide' }, { label: 'SDK' },
  { label: 'Basics' }, { label: 'Framework' }, { label: 'Practice' }, { label: 'Cordis framework tutorial' },
  { label: 'Concepts' }, { label: 'Generated reference' }, { label: 'Cordis Core API' }, { label: 'Cookbook' },
  { label: 'Overview' },
  { label: 'Core and scopes', collapsed: true },
  { label: 'Sessions and persistence', collapsed: true },
  { label: 'Model and context', collapsed: true },
  { label: 'Execution and tools', collapsed: true },
  { label: 'Policy and interaction', collapsed: true },
  { label: 'Platform and access', collapsed: true },
]

const sections: Record<DocsLocale, readonly DocsSection[]> = {
  root: englishSections,
}

/**
 * Placement and collapse behavior of one sidebar group.
 *
 * @param locale - Route tree whose sidebar is being built.
 * @param label - Section label carried by the pages in the group.
 * @returns The declared group, plus its zero-based position in the locale.
 * @throws When the locale declares no placement for the label. Ranking by list
 *   membership alone would sort an undeclared group silently ahead of every
 *   declared one.
 */
export function sectionSpec(locale: DocsLocale, label: string): DocsSection & { index: number } {
  const declared = sections[locale]
  const section = declared.find(candidate => candidate.label === label)
  if (section === undefined) throw new Error(`Sidebar section "${label}" has no placement in the ${locale} locale.`)
  return { ...section, index: declared.indexOf(section) }
}

/** Every canonical page published by the documentation website. */
export const docsPages: DocsPage[] = [
  ...homeAndGuide,
  ...develop,
  ...cordisTutorial,
  ...cordisPrimerReference,
  ...subsystemsReference,
  ...reference,
]

/**
 * Pages of one sidebar collection, in the order the sidebar lists them.
 *
 * @param locale - Route tree whose sidebar is being built.
 * @param collection - Sidebar collection to read.
 * @returns The collection's pages, ordered by section placement then by `order`.
 */
export function orderedPages(locale: DocsLocale, collection: DocsSidebar): DocsPage[] {
  return docsPages
    .filter(page => page.sidebar === collection)
    .sort((left, right) => (
      sectionSpec(locale, left.section).index - sectionSpec(locale, right.section).index
      || left.order - right.order
    ))
}

/**
 * Site-relative link for a published route.
 *
 * @param route - Manifest route, including its `.md` suffix.
 * @returns The link VitePress serves the route at.
 */
export function routeLink(route: string): string {
  return `/${route.replace(/(?:index)?\.md$/, '')}`
}

/**
 * Where a top-level navigation item lands.
 *
 * The target is derived rather than written down: a collection whose first page
 * is renamed or reordered would otherwise leave the navigation bar pointing at
 * a route the manifest no longer publishes.
 *
 * @param locale - Route tree the navigation item belongs to.
 * @param collection - Sidebar collection the item opens.
 * @returns Site-relative link of the collection's first page.
 * @throws When the collection publishes no page.
 */
export function landingLink(locale: DocsLocale, collection: DocsSidebar): string {
  const first = orderedPages(locale, collection)[0]
  if (first === undefined) throw new Error(`Sidebar collection "${collection}" publishes no page.`)
  return routeLink(first.route)
}
