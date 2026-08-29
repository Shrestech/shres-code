/**
 * Markdown filesystem provider for the wiki capability seam (`ctx.wiki`).
 * Each session's wiki lives at `<projectRoot>/.shres/wiki`, where projectRoot
 * is the `.git`-walk root of the session's recorded `cwd` — one wiki per
 * repository (an explicit absolute `root` pins a single store). The directory
 * is created on the first write; enabled-by-default does not pollute a
 * project that has never written a page.
 *
 * @module @shres-code/shres-code-wiki-filesystem
 */

import { isAbsolute, join, resolve } from 'node:path'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type {} from '@shres-code/shres-code-fs'
import { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import {
  isArchivedPath,
  WikiService,
  type Config as WikiConfigShape,
  type WikiFrontmatter,
  type WikiLogSpec,
  type WikiPage,
  type WikiProjectConfig,
  type WikiRoleBinding,
  type WikiWriteSpec,
} from '@shres-code/shres-code-wiki'
import { WikiMarkdownStore } from './store.ts'
import { findProjectRoot } from './project-root.ts'

export { findProjectRoot } from './project-root.ts'
export { parsePage, parseProjectConfig, serializePage, WikiMarkdownStore } from './store.ts'

/** Provider plugin config. Extends the seam tunables with the store root and watch. */
export interface Config extends WikiConfigShape {
  /**
   * Wiki directory. Relative values resolve under the `.git`-walk project root
   * of each calling session's `cwd` (or `process.cwd()` when the session has
   * no recorded `cwd`). Absolute values pin one store for every session.
   */
  root?: string
  /** Starting directory for the `.git` walk when `root` is relative and the session has no recorded `cwd`. */
  cwd?: string
  /** Whether the materialized wiki root is watched for external edits. */
  watch?: boolean
}

const roleBinding: z<WikiRoleBinding> = z.object({
  provider: z.string(),
  model: z.string(),
})

/** Loader-validated provider config. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  hotDays: z.number().step(1).min(1).default(7),
  warmDays: z.number().step(1).min(1).default(30),
  demoteDays: z.number().step(1).min(1).default(90),
  indexMaxLines: z.number().step(1).min(8).default(200),
  roles: z.object({
    librarian: roleBinding,
  }),
  root: z.string().default('.shres/wiki'),
  cwd: z.string(),
  watch: z.boolean().default(true),
})

/**
 * File-backed wiki provider. A Cordis Service subclass mounted as `ctx.wiki`.
 */
export class FileWikiService extends WikiService {
  static override Config = Config

  /** Stores keyed by absolute wiki root; one per resolved repository. */
  private readonly stores = new Map<string, WikiMarkdownStore>()
  /** Resolved roots keyed by project cwd (`''` for the deployment default). */
  private readonly rootsByCwd = new Map<string, string>()
  private readonly configuredRoot: string
  private readonly defaultCwd: string
  private readonly watchEnabled: boolean
  private readonly watchers = new Map<string, FSWatcher>()

  /**
   * @param ctx - Cordis context.
   * @param config - resolved provider config.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, config)
    const relativeRoot = config.root ?? '.shres/wiki'
    if (relativeRoot.trim().length === 0) {
      throw new Error('wiki-filesystem: root must be a non-empty string')
    }
    this.configuredRoot = relativeRoot
    this.defaultCwd = config.cwd ?? process.cwd()
    if (isAbsolute(relativeRoot)) {
      const root = resolve(relativeRoot)
      this.stores.set(root, new WikiMarkdownStore(root))
    }
    this.watchEnabled = config.watch !== false
    ctx.effect(() => () => {
      for (const watcher of this.watchers.values()) void watcher.close()
      this.watchers.clear()
    }, 'wiki-filesystem watcher')
    ctx.on('fs/observed', (target) => {
      for (const [root, store] of this.stores) {
        if (target.displayPath.startsWith(root)) {
          store.invalidate()
          break
        }
      }
    })
  }

  /**
   * Resolve a relative wiki root against the `.git`-walk project root of `cwd`.
   * Absolute `root` values are unchanged. Called by tests and by store
   * resolution when the caller already knows the project root.
   * @param root - configured root.
   * @param cwd - walk origin.
   * @returns the absolute wiki directory.
   */
  static async resolveRoot(root: string, cwd: string): Promise<string> {
    if (isAbsolute(root)) return resolve(root)
    const projectRoot = await findProjectRoot(cwd)
    return join(projectRoot, root)
  }

  /**
   * Store for one session's repository. Relative roots resolve per project
   * cwd and cache, so every session of one repository shares a store.
   * @param projectCwd - absolute project directory of the calling session, when recorded.
   * @returns the store rooted at the session's wiki directory.
   */
  private async storeFor(projectCwd: string | undefined): Promise<WikiMarkdownStore> {
    const key = projectCwd ?? ''
    let root = this.rootsByCwd.get(key)
    if (root === undefined) {
      root = await FileWikiService.resolveRoot(this.configuredRoot, projectCwd ?? this.defaultCwd)
      this.rootsByCwd.set(key, root)
    }
    let store = this.stores.get(root)
    if (store === undefined) {
      store = new WikiMarkdownStore(root)
      this.stores.set(root, store)
    }
    return store
  }

  /**
   * Provider-selected project overlay for one repository root.
   * @param projectCwd - absolute project directory of the calling session, when recorded.
   * @returns the parsed project config, or `{}` when the root has no `config.yaml`.
   */
  override async projectConfigOf(projectCwd: string | undefined): Promise<WikiProjectConfig> {
    const store = await this.storeFor(projectCwd)
    await store.load()
    return store.projectConfig()
  }

  private ensureWatcher(store: WikiMarkdownStore): void {
    if (!this.watchEnabled || this.watchers.has(store.root) || !store.materialized()) return
    const watcher = chokidar.watch(store.root, {
      persistent: true,
      ignoreInitial: true,
      depth: 6,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    })
    /* v8 ignore next -- chokidar add/change/unlink all invalidate the page cache */
    const invalidate = (): void => { store.invalidate() }
    watcher.on('add', invalidate)
    watcher.on('change', invalidate)
    watcher.on('unlink', invalidate)
    this.watchers.set(store.root, watcher)
  }

  override async persistPage(projectCwd: string | undefined, spec: WikiWriteSpec, nowMs: number): Promise<WikiPage> {
    const store = await this.storeFor(projectCwd)
    await store.load()
    const existing = store.list(true).find(page => page.path === spec.path)
    const archived = isArchivedPath(spec.path)
    const freshness: WikiFrontmatter = {
      ...this.freshness(new Date(nowMs).toISOString(), existing?.frontmatter, archived),
      tags: spec.tags,
      contradicts: spec.contradicts,
      ...spec.superseded_by === undefined ? {} : { superseded_by: spec.superseded_by },
    }
    const page = await store.writePage(spec, freshness)
    this.ensureWatcher(store)
    return page
  }

  override async persistTouch(projectCwd: string | undefined, path: string, nowMs: number): Promise<WikiPage> {
    const store = await this.storeFor(projectCwd)
    await store.load()
    return store.touch(path, nowMs)
  }

  override async persistLog(projectCwd: string | undefined, spec: WikiLogSpec, nowMs: number): Promise<string> {
    const store = await this.storeFor(projectCwd)
    await store.load()
    const path = await store.appendLog(spec, nowMs)
    this.ensureWatcher(store)
    return path
  }

  override async persistDemote(projectCwd: string | undefined, path: string, nowMs: number): Promise<void> {
    const store = await this.storeFor(projectCwd)
    await store.load()
    await store.demote(path, nowMs)
  }

  override async persistIndex(projectCwd: string | undefined, markdown: string): Promise<void> {
    const store = await this.storeFor(projectCwd)
    await store.load()
    await store.writeIndex(markdown)
  }

  override async loadPages(projectCwd: string | undefined, includeArchive: boolean): Promise<WikiPage[]> {
    const store = await this.storeFor(projectCwd)
    await store.load()
    return store.list(includeArchive)
  }

  override async loadIndex(projectCwd: string | undefined): Promise<string> {
    const store = await this.storeFor(projectCwd)
    await store.load()
    return store.index()
  }

  override hasPage(path: string): boolean {
    for (const store of this.stores.values()) {
      if (store.has(path)) return true
    }
    return false
  }
}

export default FileWikiService
