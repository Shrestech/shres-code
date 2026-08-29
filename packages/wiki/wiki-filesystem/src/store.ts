/**
 * Markdown page store: frontmatter parse/serialize, atomic writes, generated
 * index, day-sharded logs, and project `config.yaml`.
 *
 * @module @shres-code/shres-code-wiki-filesystem/store
 */

import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { writeFileAtomic } from '@shres-code/shres-code-atomic-write'
import {
  isArchivedPath,
  isWikiPath,
  logPathOf,
  titleFrom,
  type WikiFrontmatter,
  type WikiLogSpec,
  type WikiPage,
  type WikiProjectConfig,
  type WikiWriteSpec,
} from '@shres-code/shres-code-wiki'

const FILE_MODE = 0o644
const DIR_MODE = 0o755

/** In-memory page plus index cache over one wiki root. */
export class WikiMarkdownStore {
  private pages = new Map<string, WikiPage>()
  private indexText = ''
  private project: WikiProjectConfig = {}
  private loaded = false
  private exists = false

  /**
   * @param root - absolute wiki root (the `.shres/wiki` directory).
   */
  constructor(readonly root: string) {}

  /**
   * Whether the wiki directory exists on disk.
   * @returns true after the first successful materialize or load that found it.
   */
  materialized(): boolean {
    return this.exists
  }

  /**
   * Whether a page or log shard is in the loaded index.
   * @param path - wiki-relative path.
   * @returns true when present.
   */
  has(path: string): boolean {
    return this.pages.has(path)
  }

  /**
   * Loaded project `config.yaml`, or `{}`.
   * @returns the last parsed project config.
   */
  projectConfig(): WikiProjectConfig {
    return this.project
  }

  /**
   * Drop the in-memory cache so the next load re-reads the tree.
   */
  invalidate(): void {
    this.loaded = false
  }

  /**
   * Load every markdown page under the root. Missing root is an empty wiki.
   * @returns this store after load.
   */
  async load(): Promise<this> {
    if (this.loaded) return this
    this.pages = new Map()
    this.indexText = ''
    this.project = {}
    try {
      const entries = await readdir(this.root, { withFileTypes: true, recursive: true })
      this.exists = true
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (!entry.name.endsWith('.md') && entry.name !== 'config.yaml') continue
        const parent = entry.parentPath
        const relativePath = posixJoin(relative(this.root, join(parent, entry.name)))
        if (relativePath === 'index.md') {
          this.indexText = await readFile(join(this.root, 'index.md'), 'utf8')
          continue
        }
        if (relativePath === 'config.yaml') {
          this.project = parseProjectConfig(await readFile(join(this.root, 'config.yaml'), 'utf8'))
          continue
        }
        if (relativePath.startsWith('log/') || isWikiPath(relativePath) || isArchivedPath(relativePath)) {
          const raw = await readFile(join(this.root, ...relativePath.split('/')), 'utf8')
          this.pages.set(relativePath, parsePage(relativePath, raw))
        }
      }
    } catch (error) {
      if (!isAbsent(error)) throw error
      this.exists = false
    }
    this.loaded = true
    return this
  }

  /**
   * Pages currently loaded.
   * @param includeArchive - when true, include `archive/` and `log/` paths.
   * @returns the page list.
   */
  list(includeArchive: boolean): WikiPage[] {
    return [...this.pages.values()].filter((page) => {
      if (page.path.startsWith('log/')) return includeArchive
      if (!includeArchive && (isArchivedPath(page.path) || page.frontmatter.status === 'archived')) return false
      return true
    })
  }

  /**
   * Generated index text.
   * @returns `index.md` contents, or `''`.
   */
  index(): string {
    return this.indexText
  }

  /**
   * Create the wiki directory tree on first write.
   */
  async materialize(): Promise<void> {
    await mkdir(join(this.root, 'log'), { recursive: true, mode: DIR_MODE })
    await mkdir(join(this.root, 'archive'), { recursive: true, mode: DIR_MODE })
    this.exists = true
  }

  /**
   * Atomically write a page.
   * @param spec - resolved write spec.
   * @param freshness - complete frontmatter.
   * @returns the stored page.
   */
  async writePage(spec: WikiWriteSpec, freshness: WikiFrontmatter): Promise<WikiPage> {
    await this.materialize()
    const page: WikiPage = {
      path: spec.path,
      title: spec.title,
      body: spec.body,
      frontmatter: freshness,
    }
    await this.writeRelative(spec.path, serializePage(page))
    this.pages.set(spec.path, page)
    return page
  }

  /**
   * Update only `touched`.
   * @param path - existing page path.
   * @param nowMs - access clock.
   * @returns the updated page.
   */
  async touch(path: string, nowMs: number): Promise<WikiPage> {
    const existing = this.pages.get(path)
    if (existing === undefined) throw new Error(`wiki page not found: ${path}`)
    const page: WikiPage = {
      ...existing,
      frontmatter: { ...existing.frontmatter, touched: new Date(nowMs).toISOString() },
    }
    await this.writeRelative(path, serializePage(page))
    this.pages.set(path, page)
    return page
  }

  /**
   * Append to the day shard.
   * @param spec - resolved log spec.
   * @param nowMs - append clock.
   * @returns the shard path.
   */
  async appendLog(spec: WikiLogSpec, nowMs: number): Promise<string> {
    await this.materialize()
    const path = logPathOf(nowMs)
    const existing = this.pages.get(path)
    const header = existing === undefined
      ? `---\ncreated: ${new Date(nowMs).toISOString()}\nupdated: ${new Date(nowMs).toISOString()}\ntouched: ${new Date(nowMs).toISOString()}\nstatus: active\n---\n\n# ${path}\n\n`
      : ''
    const previous = existing?.body ?? ''
    const body = existing === undefined ? spec.body : `${previous}\n${spec.body}`
    const nowIso = new Date(nowMs).toISOString()
    const raw = existing === undefined
      ? `${header}${spec.body}\n`
      : serializePage({
        ...existing,
        body,
        frontmatter: { ...existing.frontmatter, updated: nowIso, touched: nowIso },
      })
    await this.writeRelative(path, raw)
    this.pages.set(path, parsePage(path, raw))
    return path
  }

  /**
   * Move a page into `archive/`.
   * @param path - active path.
   * @param nowMs - demotion clock.
   */
  async demote(path: string, nowMs: number): Promise<void> {
    const existing = this.pages.get(path)
    if (existing === undefined) return
    const dest = isArchivedPath(path) ? path : `archive/${path}`
    const page: WikiPage = {
      ...existing,
      path: dest,
      frontmatter: {
        ...existing.frontmatter,
        status: 'archived',
        updated: new Date(nowMs).toISOString(),
      },
    }
    await this.materialize()
    await this.writeRelative(dest, serializePage(page))
    await rm(join(this.root, ...path.split('/')), { force: true })
    this.pages.delete(path)
    this.pages.set(dest, page)
  }

  /**
   * Replace generated `index.md`.
   * @param markdown - generated projection.
   */
  async writeIndex(markdown: string): Promise<void> {
    await this.materialize()
    await this.writeRelative('index.md', markdown)
    this.indexText = markdown
  }

  /**
   * Persist project `config.yaml`.
   * @param config - project overlay.
   */
  async writeProjectConfig(config: WikiProjectConfig): Promise<void> {
    await this.materialize()
    await this.writeRelative('config.yaml', stringifyYaml(config))
    this.project = config
  }

  private async writeRelative(path: string, content: string): Promise<void> {
    const filename = join(this.root, ...path.split('/'))
    await writeFileAtomic(filename, content, { mode: FILE_MODE, dirMode: DIR_MODE })
  }
}

/**
 * Parse a markdown file with optional YAML frontmatter into a {@link WikiPage}.
 * @param path - wiki-relative path.
 * @param raw - file contents.
 * @returns the parsed page; missing freshness fields become empty strings.
 */
export function parsePage(path: string, raw: string): WikiPage {
  const parsed = splitFrontmatter(raw)
  const data = parsed.data
  const status = data.status === 'archived' ? 'archived' : 'active'
  const frontmatter: WikiFrontmatter = {
    created: stringField(data, 'created'),
    updated: stringField(data, 'updated'),
    touched: stringField(data, 'touched'),
    status,
    ...optionalString(data, 'superseded_by'),
    ...optionalStringList(data, 'contradicts'),
    ...optionalStringList(data, 'tags'),
  }
  return {
    path,
    title: titleFrom(parsed.body, path),
    body: parsed.body,
    frontmatter,
  }
}

/**
 * Serialize a page to markdown with YAML frontmatter.
 * @param page - page to write.
 * @returns file contents.
 */
export function serializePage(page: WikiPage): string {
  const data: Record<string, unknown> = {
    created: page.frontmatter.created,
    updated: page.frontmatter.updated,
    touched: page.frontmatter.touched,
    status: page.frontmatter.status,
  }
  if (page.frontmatter.superseded_by !== undefined) data.superseded_by = page.frontmatter.superseded_by
  if (page.frontmatter.contradicts !== undefined && page.frontmatter.contradicts.length > 0) {
    data.contradicts = [...page.frontmatter.contradicts]
  }
  if (page.frontmatter.tags !== undefined && page.frontmatter.tags.length > 0) {
    data.tags = [...page.frontmatter.tags]
  }
  const yaml = stringifyYaml(data).trimEnd()
  const body = page.body.startsWith('\n') ? page.body : `\n${page.body}`
  return `---\n${yaml}\n---${body.endsWith('\n') ? body : `${body}\n`}`
}

/**
 * Parse project `config.yaml`. Unknown keys are ignored; invalid types omitted.
 * @param raw - file contents.
 * @returns a sparse project config.
 */
export function parseProjectConfig(raw: string): WikiProjectConfig {
  const parsed = parseYaml(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const data = parsed as Record<string, unknown>
  const roles = data.roles
  let librarian: WikiProjectConfig['roles'] | undefined
  if (typeof roles === 'object' && roles !== null && !Array.isArray(roles)) {
    const binding = (roles as Record<string, unknown>).librarian
    if (typeof binding === 'object' && binding !== null && !Array.isArray(binding)) {
      const record = binding as Record<string, unknown>
      const pair = {
        ...typeof record.provider === 'string' ? { provider: record.provider } : {},
        ...typeof record.model === 'string' ? { model: record.model } : {},
      }
      if (Object.keys(pair).length > 0) librarian = { librarian: pair }
    }
  }
  return {
    ...typeof data.enabled === 'boolean' ? { enabled: data.enabled } : {},
    ...typeof data.hotDays === 'number' ? { hotDays: data.hotDays } : {},
    ...typeof data.warmDays === 'number' ? { warmDays: data.warmDays } : {},
    ...typeof data.demoteDays === 'number' ? { demoteDays: data.demoteDays } : {},
    ...librarian === undefined ? {} : { roles: librarian },
  }
}

function splitFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return { data: {}, body: raw }
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/u, '')
  if (firstLine !== '---') return { data: {}, body: raw }
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/u, '')
    if (line === '---') {
      const yaml = raw.slice(start, lineStart)
      const parsed = parseYaml(yaml) as unknown
      const data = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
      const bodyStart = nextNewline < 0 ? raw.length : nextNewline + 1
      return { data, body: raw.slice(bodyStart) }
    }
    if (nextNewline < 0) return { data: {}, body: raw }
    lineStart = nextNewline + 1
  }
  /* v8 ignore next -- the loop always returns on EOF */
  return { data: {}, body: raw }
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  return typeof value === 'string' ? value : ''
}

function optionalString(data: Record<string, unknown>, key: string): { superseded_by: string } | Record<string, never> {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? { superseded_by: value } : {}
}

function optionalStringList(
  data: Record<string, unknown>,
  key: 'tags' | 'contradicts',
): { tags: string[] } | { contradicts: string[] } | Record<string, never> {
  const value = data[key]
  if (!Array.isArray(value)) return {}
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (items.length === 0) return {}
  return { [key]: items } as { tags: string[] } | { contradicts: string[] }
}

function posixJoin(path: string): string {
  return path.split(sep).join('/')
}

function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
