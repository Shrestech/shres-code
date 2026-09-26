/** File-only package and lockfile inspection for managed plugin installation. */
import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import npa from 'npm-package-arg'
import { load } from 'js-yaml'
import { z } from 'zod'
import { composeEntries, resolveProfile } from './profile.ts'
import type { InstallPreview, InstallRefusal } from './profile-plugin-types.ts'
import { readPlainManifest } from './profile-plugin-build.ts'

const anchor = fileURLToPath(new URL('../package.json', import.meta.url))
function packageName(value: string): boolean {
  try { return npa(value).name === value } catch { return false }
}
const names = z.array(z.string().refine(packageName))
/** Parsed profile fields, preserving unrelated package-manager and Shres metadata. */
export const managedManifestSchema = z.object({
  dependencies: z.record(z.string().refine(packageName), z.string()).optional(),
  devDependencies: z.record(z.string().refine(packageName), z.string()).optional(),
  optionalDependencies: z.record(z.string().refine(packageName), z.string()).optional(),
  shres: z.object({ profile: z.object({ bundles: names.optional() }).loose().optional() }).loose().optional(),
}).loose()
/** Manifest representation retained across a managed transaction. */
export type ManagedManifest = z.infer<typeof managedManifestSchema>
const installedSchema = z.object({
  name: z.string(), version: z.string(),
  shres: z.object({ bundle: z.object({ patch: z.string().min(1) }).optional(), client: z.unknown().optional() }).loose().optional(),
  dsh: z.unknown().optional(),
}).loose()
const lockSchema = z.object({
  packages: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  snapshots: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
}).loose()
/** Parsed package request with an argv-safe normalized target. */
export interface PackageRequest { target: string; name?: string; directory?: string; source: InstallPreview['source'] }
/** Profile-owned snapshots retained by local directory dependencies. */
export const PLUGIN_SOURCES_DIRECTORY = '.shres-plugin-sources'
/**
 * Parse an npm request and turn local directories into copied file dependencies.
 * @param spec - operator-supplied package request.
 * @param cwd - the requesting CLI's directory, or an explicit host directory.
 * @returns a normalized request or an expected input refusal.
 */
export function parsePackageRequest(spec: string, cwd: string): PackageRequest | InstallRefusal {
  if (spec.startsWith('link:')) return { code: 'link-spec', detail: 'Managed installation requires a copy, not a live link.' }
  if (!spec.trim() || spec.startsWith('-')) return { code: 'invalid-spec', detail: 'Expected one package spec, not a pnpm option.' }
  let parsed: npa.Result
  try { parsed = npa(spec, cwd) } catch (error) { return { code: 'invalid-spec', detail: String(error) } }
  // npm-package-arg leaves the name undefined (not null) for nameless remote, git, and path specs.
  const name = typeof parsed.name === 'string' ? { name: parsed.name } : {}
  switch (parsed.type) {
    case 'directory': return { target: 'file:' + String(parsed.fetchSpec), directory: String(parsed.fetchSpec), source: 'path', ...name }
    case 'file': return { target: 'file:' + String(parsed.fetchSpec), source: 'tarball', ...name }
    case 'remote': return { target: spec, source: 'tarball', ...name }
    case 'git': return { target: spec, source: 'git', ...name }
    case 'alias':
    case 'tag':
    case 'version':
    case 'range': return { target: spec, source: 'registry', ...name }
  }
}
/**
 * Read an optional metadata file without hiding permission or I/O failures.
 * @param path - absolute metadata path.
 * @returns exact UTF-8 bytes, or null when absent.
 */
export async function optionalText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
/**
 * Resolve the dependency keys present in a profile manifest.
 * @param manifest - validated manifest.
 * @returns dependencies from every pnpm-owned dependency section.
 */
export function dependencyNames(manifest: ManagedManifest): string[] {
  return [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {})])]
}
function lockEntries(bytes: string | null): Record<string, Record<string, unknown>> {
  if (bytes === null) return {}
  const parsed = lockSchema.parse(load(bytes))
  const keys = new Set([...Object.keys(parsed.packages ?? {}), ...Object.keys(parsed.snapshots ?? {})])
  return Object.fromEntries([...keys].map(key => [key, { ...parsed.packages?.[key], ...parsed.snapshots?.[key] }]))
}
/**
 * Compare two lockfiles: the entries the transaction added, and which of them
 * pnpm itself marks `requiresBuild`. Installed package trees are compared
 * separately by the build-tree digests in `profile-plugin-build.ts`.
 * @param before - lockfile bytes before pnpm ran.
 * @param after - resulting lockfile bytes.
 * @returns added package keys and the added keys pnpm marks as requiring a build.
 */
export function inspectAddedPackages(before: string | null, after: string | null): {
  added: string[]
  requiresBuild: string[]
} {
  const old = lockEntries(before)
  const next = lockEntries(after)
  const added = Object.keys(next).filter(key => !(key in old))
  return { added, requiresBuild: added.filter(key => next[key]?.requiresBuild === true) }
}
/**
 * Read a newly installed root bundle's declaration without importing its code.
 * @param dir - profile directory.
 * @param name - validated dependency key.
 * @returns package metadata or its expected foreign/plain-package refusal.
 */
export async function inspectBundle(dir: string, name: string): Promise<{
  version: string
  clientHalf: boolean
} | InstallRefusal> {
  // A linked or special-file manifest is rejected before any read (BuildTreeRejection).
  const text = await readPlainManifest(join(dir, 'node_modules', name))
  if (text === undefined) return { code: 'not-a-bundle', detail: 'The installed package has no package.json.' }
  const raw: unknown = JSON.parse(text)
  const foreign = z.object({ dsh: z.unknown().optional() }).loose().parse(raw)
  if (foreign.dsh !== undefined) return { code: 'foreign-dsh', detail: 'DeepSeek Harness bundles are not Shres bundles.' }
  const parsed = installedSchema.safeParse(raw)
  if (!parsed.success || parsed.data.shres?.bundle === undefined) return { code: 'not-a-bundle' }
  return { version: parsed.data.version, clientHalf: parsed.data.shres.client !== undefined }
}
/**
 * Validate a candidate bundle list against the real profile patch composer; no JS is evaluated.
 * @param dir - profile directory.
 * @param bundles - consented candidate membership.
 */
export function validateComposition(dir: string, bundles: string[]): void {
  const profile = resolveProfile('shres', basename(dir), dir, { shres: { profile: { bundles } } }, anchor, {})
  composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
}

/**
 * Find a dependency's retained local snapshot, never an arbitrary file dependency.
 * @param dir - profile directory.
 * @param manifest - validated dependency declarations.
 * @param name - dependency key being removed.
 * @returns its owned snapshot path, when present.
 */
export async function retainedSource(dir: string, manifest: ManagedManifest, name: string): Promise<string | undefined> {
  const spec = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ?? manifest.optionalDependencies?.[name]
  if (spec === undefined || !spec.startsWith('file:')) return undefined
  const parsed = npa(spec, dir)
  if (parsed.type !== 'directory' || parsed.fetchSpec === null) return undefined
  const path = resolve(parsed.fetchSpec)
  const id = basename(path)
  if (!z.uuid().safeParse(id).success) return undefined
  let parent: string
  try { parent = await realpath(dirname(path)) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
  return parent === join(await realpath(dir), PLUGIN_SOURCES_DIRECTORY)
    ? join(resolve(dir), PLUGIN_SOURCES_DIRECTORY, id) : undefined
}
