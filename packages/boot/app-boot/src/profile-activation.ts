/** Profile activation shares the install lease, with exact metadata restoration on failed live application. */
import { readFile, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isSeq, parseDocument } from 'yaml'
import type { PatchOptions } from '@shres-code/cordis-plugin-include'
import type { EntryOptions } from '@shres-code/cordis-plugin-loader'
import { writeFileAtomic } from '@shres-code/shres-code-atomic-write'
import { composeEntries, DEFAULT_PROFILE_BUNDLES, PROFILE_TEMPLATES, resolveBundleDir, resolveProfile, type ProfileManifest } from './profile.ts'
import { loadOverlayPatches, parsePatchList } from './patch-files.ts'
import { dependencyNames, managedManifestSchema, optionalText, type ManagedManifest } from './profile-plugin-inspect.ts'
import { withRecoveredProfile } from './profile-plugins.ts'
import { ProfilePluginError, type CoreOptions, type ProfileActivationOutcome, type ProfileBundleState } from './profile-plugin-types.ts'
import { isProfileManagementModule } from './profile-management-policy.ts'

const protectedBundles = new Set([...DEFAULT_PROFILE_BUNDLES, ...Object.values(PROFILE_TEMPLATES).flat()])

function manifestBytes(manifest: ManagedManifest): string { return JSON.stringify(manifest, null, 2) + '\n' }
function setBundles(manifest: ManagedManifest, bundles: string[]): ManagedManifest {
  return { ...manifest, shres: { ...manifest.shres, profile: { ...manifest.shres?.profile, bundles } } }
}

/** Flatten groups in the root Include; nested Include trees are independently owned. */
function flatten(entries: EntryOptions[]): EntryOptions[] {
  return entries.flatMap(entry => [entry, ...(entry.group && Array.isArray(entry.config) ? flatten(entry.config as EntryOptions[]) : [])])
}

/** Project protected rows with the enclosing group options that control their activation. */
function managementRows(entries: EntryOptions[], parents: Omit<EntryOptions, 'config'>[] = []): unknown[] {
  return entries.flatMap((entry) => {
    const rows: unknown[] = isProfileManagementModule(entry.name) ? [{ entry, parents }] : []
    if (entry.group && Array.isArray(entry.config)) {
      const parent = { ...entry }
      delete parent.config
      rows.push(...managementRows(entry.config as EntryOptions[], [...parents, parent]))
    }
    return rows
  })
}

/**
 * Compose the current and candidate bundle layers and project only the rows
 * that keep profile management reachable. The projection deliberately reads
 * patch files and package manifests only; it never imports a bundle module.
 * @param profileDir - initialized profile directory.
 * @param manifest - current validated profile manifest.
 * @param candidateBundles - bundle membership to compare with the manifest.
 * @param installAnchor - installation package anchor for bundle resolution.
 * @returns protected rows with their enclosing group options before and after the change.
 */
function projectBundleManagementRows(
  profileDir: string,
  manifest: ManagedManifest,
  candidateBundles: string[],
  installAnchor: string,
): { current: unknown[]; candidate: unknown[] } {
  const current = resolveProfile('shres', basename(profileDir), profileDir, manifest as ProfileManifest, installAnchor, {})
  const candidate = resolveProfile(
    'shres', basename(profileDir), profileDir, setBundles(manifest, candidateBundles) as ProfileManifest, installAnchor, {},
  )
  const compose = (profile: typeof current): unknown[] => managementRows(
    composeEntries([...profile.layers.map(layer => layer.patches), profile.patches]),
  )
  return { current: compose(current), candidate: compose(candidate) }
}

/** Inputs shared by live bundle and row mutations. */
export interface ProfileMutationOptions extends CoreOptions {
  /** Absolute package.json anchor for installation-owned bundle resolution. */
  installAnchor: string
  /** Optional and required bundles supplied by the running installation. */
  shippedBundles?: readonly string[]
  /**
   * Apply a validated candidate atomically; cancellation is honored before
   * invocation, and an in-flight application must settle. Omit for restart-only hosts.
   */
  apply?: (candidate: ProfileMutationCandidate) => Promise<ProfileActivationApplication>
}

/** Validated profile state handed to a launcher before a live Include update. */
export interface ProfileMutationCandidate {
  manifest: ManagedManifest
  bundles: readonly string[]
  profilePatches: readonly PatchOptions[]
}

/** Result supplied by a launcher after attempting a live candidate update. */
export type ProfileActivationApplication = 'applied' | 'restart-required' | 'overridden'

/** Edit the last applicable override, retaining YAML comments, tags, and unrelated nodes. */
function pluginOverride(before: string | null, id: string, moduleName: string, enabled: boolean): string {
  const document = parseDocument(before ?? '[]\n', {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  const items = document.contents.items
  const target = items.findLast((item, index) => {
    if (!isMap(item) || document.getIn([index, 'id']) !== id || item.has('insert')) return false
    const name = document.getIn([index, 'name'])
    return name === undefined || name === moduleName
  })
  if (isMap(target)) document.setIn([items.indexOf(target), 'disabled'], !enabled)
  else document.add({ id, name: moduleName, disabled: !enabled })
  return String(document)
}

async function restoreText(path: string, before: string | null): Promise<void> {
  if (before === null) {
    try { await unlink(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return
  }
  await writeFileAtomic(path, before, { mode: 0o600 })
}

async function readProfilePatches(profileDir: string): Promise<{ path: string; bytes: string | null; patches: PatchOptions[] }> {
  const path = join(profileDir, 'cordis.patch.yml')
  const bytes = await optionalText(path)
  return { path, bytes, patches: bytes === null ? [] : parsePatchList('shres', path, bytes, 'patches') }
}

interface BundleMetadata {
  description?: string
  version?: string
  rows: string[]
  modules: string[]
}

async function readBundleMetadata(
  profileDir: string,
  name: string,
  installAnchor: string,
): Promise<BundleMetadata> {
  const packageDir = resolveBundleDir('shres', name, installAnchor, profileDir)
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
    description?: unknown
    version?: unknown
    shres?: { bundle?: { patch?: unknown }; client?: unknown }
  }
  const patch = manifest.shres?.bundle?.patch
  if (typeof patch !== 'string' || patch.length === 0) throw new Error('package does not declare a profile patch')
  const patches = loadOverlayPatches('shres', join(packageDir, patch))
  const rows = flatten(composeEntries([patches]))
  return {
    ...typeof manifest.description === 'string' ? { description: manifest.description } : {},
    ...typeof manifest.version === 'string' ? { version: manifest.version } : {},
    rows: rows.filter(row => !row.group).map(row => 'include:' + row.id),
    modules: rows.map(row => row.name),
  }
}

/**
 * Enumerate installed profile bundles from package metadata without importing
 * plugin code. Missing or malformed selected bundles remain visible with an
 * error so the manager can report the broken profile instead of hiding it.
 * @param profileDir - initialized profile directory.
 * @param bootBundles - bundle names active in the current process.
 * @param options - installation anchor and shipped bundle names.
 * @returns bundle rows in manifest, active, then shipped discovery order.
 */
export async function listProfileBundles(
  profileDir: string,
  bootBundles: readonly string[],
  options: { installAnchor: string; shippedBundles?: readonly string[] },
): Promise<ProfileBundleState[]> {
  const manifest = managedManifestSchema.parse(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')))
  const selected = manifest.shres?.profile?.bundles ?? []
  const shipped = options.shippedBundles ?? []
  const names = [...new Set([...dependencyNames(manifest), ...selected, ...bootBundles, ...shipped])]
  const result: ProfileBundleState[] = []
  for (const name of names) {
    let metadata: BundleMetadata
    try {
      metadata = await readBundleMetadata(profileDir, name, options.installAnchor)
    } catch (error) {
      if (!selected.includes(name) && !bootBundles.includes(name) && !shipped.includes(name)) continue
      result.push({
        name,
        selected: selected.includes(name),
        active: bootBundles.includes(name),
        shipped: shipped.includes(name),
        rows: [],
        ...protectedBundles.has(name) ? { readOnlyReason: 'management-required' } : {},
        error: String(error),
      })
      continue
    }
    const metadataProtected = protectedBundles.has(name) || metadata.modules.some(isProfileManagementModule)
    let compositionError: unknown
    let managementChanged = false
    if (!metadataProtected) {
      const candidateBundles = selected.includes(name)
        ? selected.filter(bundle => bundle !== name)
        : [...selected, name]
      try {
        const projection = projectBundleManagementRows(profileDir, manifest, candidateBundles, options.installAnchor)
        managementChanged = !isDeepStrictEqual(projection.current, projection.candidate)
      } catch (error) {
        // A failed projection cannot prove that the candidate leaves the
        // management path intact. Keep the row visible, but refuse toggles.
        compositionError = error
      }
    }
    const readOnlyReason = metadataProtected || managementChanged
      ? 'management-required'
      : compositionError === undefined ? undefined : 'unaddressable'
    result.push({
      name,
      ...metadata.description === undefined ? {} : { description: metadata.description },
      ...metadata.version === undefined ? {} : { version: metadata.version },
      rows: metadata.rows,
      selected: selected.includes(name),
      active: bootBundles.includes(name),
      shipped: shipped.includes(name),
      ...readOnlyReason === undefined ? {} : { readOnlyReason },
      ...compositionError === undefined ? {} : { error: errorText(compositionError) },
    })
  }
  return result
}

function refused(code: Extract<ProfileActivationOutcome, { kind: 'refused' }>['code'], detail?: string): ProfileActivationOutcome {
  return { kind: 'refused', code, ...detail === undefined ? {} : { detail } }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  if (error === undefined) return 'Unknown profile composition error'
  try {
    return JSON.stringify(error)
  } catch {
    // A projection failure is diagnostic-only; an unserializable value must
    // still leave the row conservatively read-only.
    return 'Unknown profile composition error'
  }
}

/**
 * Toggle a bundle in the managed profile manifest, optionally reconciling the
 * running root Include after the manifest has been validated and saved.
 * @param profileDir - initialized profile directory.
 * @param name - installed bundle package name.
 * @param enabled - desired membership in `shres.profile.bundles`.
 * @param options - lease dependencies, resolution anchor, and live applier.
 * @returns the durable outcome and any live-application status.
 */
export async function setBundleEnabled(
  profileDir: string,
  name: string,
  enabled: boolean,
  options: ProfileMutationOptions,
): Promise<ProfileActivationOutcome> {
  if (process.platform === 'win32') return { kind: 'unsupported' }
  return withRecoveredProfile(profileDir, options, async () => {
    const manifestPath = join(profileDir, 'package.json')
    const beforeBytes = await readFile(manifestPath, 'utf8')
    const manifest = managedManifestSchema.parse(JSON.parse(beforeBytes))
    const dependencyNamesInManifest = dependencyNames(manifest)
    const desired = manifest.shres?.profile?.bundles ?? []
    if (!dependencyNamesInManifest.includes(name) && !options.shippedBundles?.includes(name) && !desired.includes(name)) {
      return refused('unknown-bundle', 'The bundle is not available in this profile.')
    }
    let metadata: BundleMetadata
    try {
      metadata = await readBundleMetadata(profileDir, name, options.installAnchor)
    } catch (error) {
      return refused('unknown-bundle', String(error))
    }
    if (protectedBundles.has(name) || metadata.modules.some(isProfileManagementModule)) {
      return refused('management-required', 'This bundle keeps plugin management available.')
    }
    const candidateBundles = enabled
      ? [...desired, ...desired.includes(name) ? [] : [name]]
      : desired.filter(bundle => bundle !== name)
    try {
      const projection = projectBundleManagementRows(profileDir, manifest, candidateBundles, options.installAnchor)
      if (!isDeepStrictEqual(projection.current, projection.candidate)) {
        return refused('management-required', 'This bundle changes the infrastructure required by plugin management.')
      }
    } catch (error) {
      return refused('invalid-composition', String(error))
    }
    const profilePatches = await readProfilePatches(profileDir)
    const candidateManifest = setBundles(manifest, candidateBundles)
    options.signal.throwIfAborted()
    await writeFileAtomic(manifestPath, manifestBytes(candidateManifest), { mode: 0o600 })
    try {
      options.signal.throwIfAborted()
      if (options.apply === undefined) return { kind: 'saved', application: 'restart-required' }
      const application = await options.apply({
        manifest: candidateManifest,
        bundles: candidateBundles,
        profilePatches: profilePatches.patches,
      })
      return { kind: 'saved', application }
    } catch (error) {
      try {
        await restoreText(manifestPath, beforeBytes)
      } catch (restoreError) {
        throw new ProfilePluginError('restore-failed', `Bundle mutation failed and manifest restoration failed: ${String(restoreError)}`)
      }
      return refused('invalid-composition', String(error))
    }
  })
}

/**
 * Persist an enablement override for one plugin row and optionally reconcile the running Include.
 * YAML comments, tags, and unrelated values are retained.
 * @param profileDir - initialized profile directory.
 * @param request - exact patch id, module identity, and desired enablement.
 * @param options - lease dependencies, resolution anchor, and live applier.
 * @returns the durable outcome and any live-application status.
 */
export async function setPluginEnabled(
  profileDir: string,
  request: { id: string; moduleName: string; enabled: boolean },
  options: ProfileMutationOptions,
): Promise<ProfileActivationOutcome> {
  if (process.platform === 'win32') return { kind: 'unsupported' }
  if (isProfileManagementModule(request.moduleName)) return refused('management-required')
  return withRecoveredProfile(profileDir, options, async () => {
    const manifest = managedManifestSchema.parse(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')))
    let profile: ReturnType<typeof resolveProfile>
    let current: Awaited<ReturnType<typeof readProfilePatches>>
    try {
      profile = resolveProfile('shres', basename(profileDir), profileDir, manifest as ProfileManifest, options.installAnchor, { userLayer: false })
      current = await readProfilePatches(profileDir)
      const composed = composeEntries([...profile.layers.map(layer => layer.patches), current.patches])
      const targets = flatten(composed).filter(row => row.id === request.id)
      const target = targets[0]
      if (targets.length !== 1 || target === undefined || target.group) return refused('unaddressable')
      if (target.name !== request.moduleName) return refused('unknown-plugin', 'The plugin identity changed; refresh the inventory.')
    } catch (error) {
      return refused('invalid-composition', String(error))
    }
    let candidateBytes: string
    let candidatePatches: PatchOptions[]
    try {
      candidateBytes = pluginOverride(current.bytes, request.id, request.moduleName, request.enabled)
      candidatePatches = parsePatchList('shres', current.path, candidateBytes, 'patches')
      composeEntries([...profile.layers.map(layer => layer.patches), candidatePatches])
    } catch (error) {
      return refused('invalid-composition', String(error))
    }
    options.signal.throwIfAborted()
    await writeFileAtomic(current.path, candidateBytes, { mode: 0o600 })
    try {
      options.signal.throwIfAborted()
      if (options.apply === undefined) return { kind: 'saved', application: 'restart-required' }
      const application = await options.apply({
        manifest,
        bundles: manifest.shres?.profile?.bundles ?? [],
        profilePatches: candidatePatches,
      })
      return { kind: 'saved', application }
    } catch (error) {
      try {
        await restoreText(current.path, current.bytes)
      } catch (restoreError) {
        throw new ProfilePluginError('restore-failed', `Plugin override failed and patch restoration failed: ${String(restoreError)}`)
      }
      return refused('invalid-composition', String(error))
    }
  })
}
