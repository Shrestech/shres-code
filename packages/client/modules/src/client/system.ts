/**
 * ClientModuleSystem — the implementation behind the {@link ClientModuleLoader}
 * contract. The conceptual contract (lazy CJS model, resolution branch order) is
 * documented on the public interfaces in `./manifest.ts`; this file owns the
 * state tables and the load/materialize machinery.
 */
import type {
  BootModuleRow, ClientGraphUpdate, ClientModuleLoader, ClientModuleRecord,
  ClientModuleSystemOptions, ClientPluginHandoff, ShresWindow,
} from './manifest.ts'

/** Default bundle-load hook: same-origin external classic script. */
const defaultLoadBundle = (url: string): Promise<void> => new Promise((resolve, reject) => {
  const el = document.createElement('script')
  el.async = true
  el.src = url
  el.addEventListener('load', () => {
    el.remove()
    resolve()
  }, { once: true })
  el.addEventListener('error', () => {
    el.remove()
    reject(new Error(`client-modules: bundle script ${url} failed to load`))
  }, { once: true })
  document.head.append(el)
})

/**
 * A plugin bundle IS its package's client half: `<id>/client` (the exports
 * subpath external bundles emit) and the bare graph id name the same
 * exports, so table lookups normalize the suffix away.
 */
const stripClientSuffix = (spec: string): string =>
  spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec

/**
 * Claim and inventory the <style> tags a factory injected during
 * materialization: preset-emitted tags arrive pre-tagged with data-plugin;
 * any untagged tag is claimed for the materializing plugin (HMR bookkeeping).
 */
const claimStyles = (id: string): string[] => {
  if (typeof document === 'undefined') return []
  for (const el of document.querySelectorAll('style:not([data-plugin])')) {
    el.setAttribute('data-plugin', id)
  }
  const owned: string[] = []
  for (const el of document.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`)) {
    owned.push(el.getAttribute('data-plugin-css') ?? id)
  }
  return owned
}

/** Remove style tags claimed by one materialized client bundle. */
const removeStyles = (id: string, styles: readonly string[]): void => {
  if (typeof document === 'undefined') return
  const owned = new Set(styles)
  for (const el of document.querySelectorAll('style[data-plugin]')) {
    const plugin = el.getAttribute('data-plugin')
    const css = el.getAttribute('data-plugin-css')
    if (plugin === id || (css !== null && owned.has(css))) el.remove()
  }
}

/**
 * The client module system: state tables plus the arrival/materialization
 * machinery implementing {@link ClientModuleLoader} (whose members carry the
 * contract documentation). Construction indexes the boot rows and installs the
 * `window.__ModuleLoader__` registration sink — once per page.
 */
export class ClientModuleSystem implements ClientModuleLoader {
  readonly version = 'client'
  readonly loadCache = new Map<string, ClientModuleRecord>()

  private readonly seed: Map<string, unknown>
  private readonly statics = new Map<string, unknown>()
  private readonly factories = new Map<string, ClientPluginHandoff['factory']>()
  /** In-flight prefetch (script load) per id; concurrent callers share it. */
  private readonly pendingArrival = new Map<string, Promise<void>>()
  /** Materialization re-entrancy guard: factory-form CJS cannot deliver partial exports, so a cycle is fatal. */
  private readonly materializing = new Set<string>()
  private readonly graphTable = new Map<string, BootModuleRow>()
  private readonly loadBundle: (url: string) => Promise<void>

  /**
   * Build the module system over the parsed boot rows.
   * @param options - Module rows, module-table staticModules, and bundle-load hook.
   */
  constructor(options: ClientModuleSystemOptions) {
    this.seed = new Map(Object.entries(options.staticModules))
    this.loadBundle = options.loadBundle ?? defaultLoadBundle

    for (const row of options.modules) {
      if (this.graphTable.has(row.id)) throw new Error(`client-modules: duplicate graph entry "${row.id}"`)
      this.graphTable.set(row.id, row)
    }

    const win = globalThis as ShresWindow
    if (win.__ModuleLoader__ !== undefined) throw new Error('client-modules: window.__ModuleLoader__ already installed (double boot?)')
    win.__ModuleLoader__ = {
      load: (handoff: ClientPluginHandoff): void => {
        // Registration is keyed by the handoff id; a duplicate means a bundle
        // executed twice without an invalidate — always a bug, always loud.
        if (this.factories.has(handoff.id)) throw new Error(`client-modules: duplicate factory registration for "${handoff.id}" (bundle executed twice without invalidate?)`)
        this.factories.set(handoff.id, handoff.factory)
      },
    }
  }

  /** Load one graph row so its factory is registered (idempotent per in-flight arrival). */
  private arrive(row: BootModuleRow): Promise<void> {
    const { id, url } = row
    const pending = this.pendingArrival.get(id)
    if (pending !== undefined) return pending
    if (this.factories.has(id)) return Promise.resolve()
    const task = this.loadBundle(url).then(() => {
      if (!this.factories.has(id)) {
        throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`)
      }
    }).finally(() => { this.pendingArrival.delete(id) })
    this.pendingArrival.set(id, task)
    return task
  }

  /** Materialize a registered factory (synchronous; memoized in loadCache). */
  private materialize(id: string): ClientModuleRecord {
    const existing = this.loadCache.get(id)
    if (existing !== undefined) return existing
    const registered = this.factories.get(id)
    /* v8 ignore next -- callers check the factory branch before dispatching here. */
    if (registered === undefined) throw new Error(`client-modules: no registered factory for "${id}"`)
    if (this.materializing.has(id)) {
      throw new Error(`client-modules: require cycle through "${id}" (factory-form CJS cannot deliver partial exports)`)
    }
    this.materializing.add(id)
    try {
      const edges = new Set<string>()
      const exports = registered(this.makeRequire(edges))
      const record: ClientModuleRecord = { id, exports, styles: claimStyles(id), edges }
      this.loadCache.set(id, record)
      return record
    } finally {
      this.materializing.delete(id)
    }
  }

  /**
   * The synchronous require answered to factories: seed → static → memoized
   * record → registered factory (recursive materialization — this is what
   * makes load order self-resolving). Fetching is async and therefore
   * unreachable from here; an unregistered plugin specifier is loud (and a
   * cross-plugin value import is already a build error upstream).
   */
  private makeRequire(edges: Set<string>): (spec: string) => unknown {
    return (spec: string): unknown => {
      edges.add(spec)
      if (this.seed.has(spec)) return this.seed.get(spec)
      if (this.statics.has(spec)) return this.statics.get(spec)
      const id = stripClientSuffix(spec)
      const record = this.loadCache.get(id)
      if (record !== undefined) return record.exports
      if (this.factories.has(id)) return this.materialize(id).exports
      throw new Error(
        `client-modules: require("${spec}") missed the module table — not a platform seed word, not a shell-own module, `
        + 'and no registered factory (a build-time externals drift, or a forbidden cross-plugin value import)',
      )
    }
  }

  async import(specifier: string): Promise<unknown> {
    if (this.seed.has(specifier)) return this.seed.get(specifier)
    const existing = this.loadCache.get(specifier)
    if (existing !== undefined) return existing.exports
    if (this.statics.has(specifier)) {
      const exports = this.statics.get(specifier)
      this.loadCache.set(specifier, { id: specifier, exports, styles: [], edges: new Set() })
      return exports
    }
    if (!this.factories.has(specifier)) {
      const row = this.graphTable.get(specifier)
      if (row === undefined) {
        throw new Error(
          `client-modules: cannot resolve "${specifier}" — not a seed word, not a shell-own module, `
          + 'and not a row in the boot graph (the runtime mirror of the bundle purity gate)',
        )
      }
      await this.arrive(row)
    }
    return this.materialize(specifier).exports
  }

  registerStatic(id: string, module: unknown): void {
    if (this.statics.has(id)) throw new Error(`client-modules: shell-own module "${id}" registered twice`)
    this.statics.set(id, module)
  }

  async prefetch(id: string): Promise<void> {
    if (this.statics.has(id)) return
    const row = this.graphTable.get(id)
    if (row === undefined) throw new Error(`client-modules: prefetch("${id}") — not a graph entry`)
    await this.arrive(row)
  }

  /**
   * Replace the browser graph rows after validating duplicate ids. Existing
   * rows stay materialized until the caller has removed their Loader entries;
   * the returned diff gives that caller the required lifecycle order.
   * @param rows - the host's validated module-view graph rows.
   * @returns rows added, withdrawn, or changed in place.
   */
  applyGraph(rows: readonly BootModuleRow[]): ClientGraphUpdate {
    const next = new Map<string, BootModuleRow>()
    for (const row of rows) {
      if (next.has(row.id)) throw new Error(`client-modules: duplicate graph entry "${row.id}"`)
      next.set(row.id, { ...row })
    }
    const added: BootModuleRow[] = []
    const removed: BootModuleRow[] = []
    const changed: Array<{ before: BootModuleRow; after: BootModuleRow }> = []
    for (const [id, before] of this.graphTable) {
      const after = next.get(id)
      if (after === undefined) removed.push({ ...before })
      else if (after.url !== before.url || after.rev !== before.rev) changed.push({ before: { ...before }, after: { ...after } })
    }
    for (const [id, after] of next) {
      if (!this.graphTable.has(id)) added.push({ ...after })
    }
    this.graphTable.clear()
    for (const [id, row] of next) this.graphTable.set(id, row)
    return { added, removed, changed }
  }

  /** Return a defensive snapshot of the current graph rows. */
  graphRows(): BootModuleRow[] {
    return [...this.graphTable.values()].map(row => ({ ...row }))
  }

  /**
   * Withdraw one graph row after its Loader entry has disposed. The cached
   * factory, materialized exports, and styles belong exclusively to that row.
   * @param id - graph entry name to remove.
   */
  withdraw(id: string): void {
    const record = this.loadCache.get(id)
    this.invalidate(id)
    this.graphTable.delete(id)
    if (record !== undefined) removeStyles(id, record.styles)
  }

  invalidate(id: string): void {
    this.factories.delete(id)
    this.loadCache.delete(id)
  }
}
