/**
 * Markdown filesystem provider for the wiki capability seam (`ctx.wiki`).
 * Pages live at `<projectRoot>/.shres/wiki` (or an explicit absolute `root`).
 * The directory is created on the first write; enabled-by-default does not
 * pollute a project that has never written a page.
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
   * of `cwd` (or `process.cwd()`). Absolute values are used as-is.
   */
  root?: string
  /** Starting directory for the `.git` walk when `root` is relative. */
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

  private store: WikiMarkdownStore
  private readonly configuredRoot: string
  private readonly cwd: string
  private readonly watchEnabled: boolean
  private relocated = false
  private watcher: FSWatcher | undefined
  private watching = false

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
    this.cwd = config.cwd ?? process.cwd()
    const root = isAbsolute(relativeRoot) ? resolve(relativeRoot) : join(this.cwd, relativeRoot)
    this.store = new WikiMarkdownStore(root)
    this.relocated = isAbsolute(relativeRoot)
    this.watchEnabled = config.watch !== false
    ctx.effect(() => () => {
      void this.closeWatcher()
    }, 'wiki-filesystem watcher')
    ctx.on('fs/observed', (target) => {
      if (target.displayPath.startsWith(this.store.root)) this.store.invalidate()
    })
  }

  /**
   * Resolve a relative wiki root against the `.git`-walk project root of `cwd`.
   * Absolute `root` values are unchanged. Called by tests and by apply-time
   * construction when the caller already knows the project root.
   * @param root - configured root.
   * @param cwd - walk origin.
   * @returns the absolute wiki directory.
   */
  static async resolveRoot(root: string, cwd: string): Promise<string> {
    if (isAbsolute(root)) return resolve(root)
    const projectRoot = await findProjectRoot(cwd)
    return join(projectRoot, root)
  }

  override projectConfig(): WikiProjectConfig {
    return this.store.projectConfig()
  }

  private async ensureRoot(): Promise<void> {
    if (this.relocated) return
    const next = await FileWikiService.resolveRoot(this.configuredRoot, this.cwd)
    if (next !== this.store.root) this.store = new WikiMarkdownStore(next)
    this.relocated = true
  }

  override async persistPage(spec: WikiWriteSpec, nowMs: number): Promise<WikiPage> {
    await this.ensureRoot()
    await this.store.load()
    const existing = this.store.list(true).find(page => page.path === spec.path)
    const archived = isArchivedPath(spec.path)
    const freshness: WikiFrontmatter = {
      ...this.freshness(new Date(nowMs).toISOString(), existing?.frontmatter, archived),
      tags: spec.tags,
      contradicts: spec.contradicts,
      ...spec.superseded_by === undefined ? {} : { superseded_by: spec.superseded_by },
    }
    const page = await this.store.writePage(spec, freshness)
    this.ensureWatcher()
    return page
  }

  override async persistTouch(path: string, nowMs: number): Promise<WikiPage> {
    await this.ensureRoot()
    await this.store.load()
    return this.store.touch(path, nowMs)
  }

  override async persistLog(spec: WikiLogSpec, nowMs: number): Promise<string> {
    await this.ensureRoot()
    await this.store.load()
    const path = await this.store.appendLog(spec, nowMs)
    this.ensureWatcher()
    return path
  }

  override async persistDemote(path: string, nowMs: number): Promise<void> {
    await this.ensureRoot()
    await this.store.load()
    await this.store.demote(path, nowMs)
  }

  override async persistIndex(markdown: string): Promise<void> {
    await this.ensureRoot()
    await this.store.load()
    await this.store.writeIndex(markdown)
  }

  override async loadPages(includeArchive: boolean): Promise<WikiPage[]> {
    await this.ensureRoot()
    await this.store.load()
    return this.store.list(includeArchive)
  }

  override async loadIndex(): Promise<string> {
    await this.ensureRoot()
    await this.store.load()
    return this.store.index()
  }

  override hasPage(path: string): boolean {
    return this.store.has(path)
  }

  private ensureWatcher(): void {
    if (!this.watchEnabled || this.watching || !this.store.materialized()) return
    this.watching = true
    this.watcher = chokidar.watch(this.store.root, {
      persistent: true,
      ignoreInitial: true,
      depth: 6,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    })
    /* v8 ignore next -- chokidar add/change/unlink all invalidate the page cache */
    const invalidate = (): void => { this.store.invalidate() }
    this.watcher.on('add', invalidate)
    this.watcher.on('change', invalidate)
    this.watcher.on('unlink', invalidate)
  }

  private async closeWatcher(): Promise<void> {
    const watcher = this.watcher
    this.watcher = undefined
    this.watching = false
    if (watcher !== undefined) await watcher.close()
  }
}

export default FileWikiService
