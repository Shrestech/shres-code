/** Consent-based plugin mutation and recovery shared by profile launchers and host administration. */
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@shres-code/shres-code-atomic-write'
import { DEFAULT_PROFILE_BUNDLES, PROFILE_TEMPLATES } from './profile.ts'
import {
  dependencyNames, inspectAddedPackages, inspectBundle, managedManifestSchema, optionalText,
  parsePackageRequest, retainedSource, validateComposition, PLUGIN_SOURCES_DIRECTORY, type ManagedManifest,
} from './profile-plugin-inspect.ts'
import { stagePluginSource } from './profile-plugin-source.ts'
import { BuildTreeRejection, changedBuildTrees, collectBuildTrees } from './profile-plugin-build.ts'
import { layoutRefusal, readModulesLayout } from './profile-plugin-layout.ts'
import { clearJournal, clearStagedSource, ownerAlive, readJournal, recoverLocked, restoreInstall, withProfileLease, writeJournal,
  type PluginJournal } from './profile-plugin-journal.ts'
import { ProfilePluginError, type CoreOptions, type InstallBegin, type InstallCommitted, type InstallPreview,
  type InstallRefusal, type InstallRefused, type ParkedInstall, type PluginStateEntry, type RecoveredProfile,
  type RecoveryOutcome, type RemoveOutcome, type RollbackReport } from './profile-plugin-types.ts'

/**
 * Names the managed core treats as shipped infrastructure: `removePlugin`
 * refuses them before the lock, and `pluginStates` reports them not removable.
 */
const PROTECTED_BUNDLES: ReadonlySet<string> = new Set([...DEFAULT_PROFILE_BUNDLES, ...Object.values(PROFILE_TEMPLATES).flat()])
const skipped: RollbackReport = { filesRestored: true, reinstall: 'skipped' }
type InstallOutcome = ({ kind: 'committed' } & InstallCommitted) | InstallRefused
function refusal(value: InstallRefusal, rollback: RollbackReport = skipped): InstallRefused {
  return { kind: 'refused', refusal: value, rollback }
}
function manifestBytes(manifest: ManagedManifest): string { return JSON.stringify(manifest, null, 2) + '\n' }
function setBundles(manifest: ManagedManifest, bundles: string[]): ManagedManifest {
  return { ...manifest, shres: { ...manifest.shres, profile: { ...manifest.shres?.profile, bundles } } }
}
async function requireRecovered(dir: string, options: CoreOptions): Promise<RecoveredProfile> {
  const result = await recoverLocked(dir, options)
  if (result.kind === 'owner-alive') throw new ProfilePluginError('transaction-pending', 'A live process owns the transaction.', result.pid)
  return result
}
/**
 * Hold the profile lock across recovery and one raw/expert operation. The callback is non-reentrant.
 * @param profileDir - profile directory.
 * @param options - explicit process dependencies.
 * @param operation - callback run only after recovery, under the same lock.
 * @returns the callback result after the lock releases.
 */
export async function withRecoveredProfile<T>(
  profileDir: string, options: CoreOptions, operation: (recovery: RecoveredProfile) => T | Promise<T>,
): Promise<T> {
  return withProfileLease(profileDir, options.signal, async () => {
    const recovery = await requireRecovered(profileDir, options)
    options.signal.throwIfAborted()
    return operation(recovery)
  })
}
/**
 * Recover interrupted metadata changes before profile composition; live owners are never stolen.
 * @param profileDir - profile directory.
 * @param options - explicit recovery runner and cancellation.
 * @returns whether recovery ran or another owner remains alive.
 */
export async function recoverPluginTransaction(profileDir: string, options: CoreOptions): Promise<RecoveryOutcome> {
  const journal = await readJournal(profileDir)
  if (journal === null) return { kind: 'none' }
  if (ownerAlive(journal)) return { kind: 'owner-alive', pid: journal.pid }
  return withProfileLease(profileDir, options.signal, () => recoverLocked(profileDir, options))
}
/**
 * Fetch a copied dependency without lifecycle scripts and hold the profile lock until a terminal decision.
 * @param profileDir - initialized profile directory.
 * @param spec - one npm package request, never pnpm arguments.
 * @param options - process runner, signal, and request directory.
 * @returns a preview with confirm/cancel methods or a refusal after restoration.
 */
export async function beginPluginInstall(profileDir: string, spec: string, options: CoreOptions): Promise<InstallBegin> {
  if (process.platform === 'win32') return refusal({ code: 'unsupported-platform' })
  const request = parsePackageRequest(spec, options.invokingCwd)
  if ('code' in request) return refusal(request)
  const ready = Promise.withResolvers<InstallBegin>()
  const decision = Promise.withResolvers<'confirm' | 'cancel'>()
  let requested: 'confirm' | 'cancel' | undefined
  const choose = (value: 'confirm' | 'cancel'): void => {
    if (requested !== undefined) return
    requested = value
    decision.resolve(value)
  }
  const abort = (): void => { choose('cancel') }
  options.signal.addEventListener('abort', abort, { once: true })
  const operation: Promise<InstallOutcome> = withProfileLease<InstallOutcome>(profileDir, options.signal, async (id) => {
    await requireRecovered(profileDir, options)
    const beforeBytes = await readFile(join(profileDir, 'package.json'), 'utf8')
    const before = managedManifestSchema.parse(JSON.parse(beforeBytes))
    const bundles = before.shres?.profile?.bundles ?? []
    const oldNames = dependencyNames(before)
    if (request.name !== undefined && (bundles.includes(request.name) || oldNames.includes(request.name))) {
      return refusal({ code: 'already-active', detail: 'Managed installation does not replace existing dependencies.' })
    }
    const sourceRoot = join(profileDir, PLUGIN_SOURCES_DIRECTORY)
    if (request.directory !== undefined) {
      let info: Awaited<ReturnType<typeof lstat>> | undefined
      try { info = await lstat(sourceRoot) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink())) {
        return refusal({ code: 'link-spec', detail: 'The profile source root must be a real directory.' })
      }
    }
    // Build inspection assumes pnpm's hoisted layout; refuse any other recorded
    // layout before the journal or pnpm touches the profile.
    const layoutBefore = layoutRefusal(await readModulesLayout(profileDir), 'before')
    if (layoutBefore !== undefined) return refusal(layoutBefore)
    const journal: PluginJournal = {
      version: 1, id, op: 'install', pid: process.pid, startedAt: new Date().toISOString(), spec,
      phase: 'mutating', manifestBytes: beforeBytes, lockfileBytes: await optionalText(join(profileDir, 'pnpm-lock.yaml')),
      ...request.directory === undefined ? {} : {
        sourcePath: request.directory, stagedPath: join(profileDir, PLUGIN_SOURCES_DIRECTORY, id),
      },
    }
    await writeJournal(profileDir, journal)
    const rollback = (reason: InstallRefusal): Promise<InstallRefused> => restoreInstall(profileDir, journal, {
      ...options, signal: new AbortController().signal,
    }).then(report => refusal(reason, report))
    let committed = false
    try {
      let target = request.target
      let requestedName = request.name
      if (journal.sourcePath !== undefined && journal.stagedPath !== undefined) {
        await mkdir(sourceRoot, { recursive: true, mode: 0o700 })
        if ((await lstat(sourceRoot)).isSymbolicLink()) return await rollback({ code: 'link-spec', detail: 'The profile source root changed to a symbolic link.' })
        const staged = await stagePluginSource(journal.sourcePath, journal.stagedPath, options.signal)
        if (staged.kind === 'refused') return await rollback(staged.refusal)
        requestedName = request.name ?? staged.name
        if (oldNames.includes(requestedName) || bundles.includes(requestedName)) return await rollback({ code: 'already-active' })
        target = (request.name === undefined ? '' : request.name + '@') + 'file:' + journal.stagedPath
      }
      // Digest every build-declaring tree before pnpm runs, under the same
      // journal and lease, so the added or changed ones can be identified.
      const buildBefore = await collectBuildTrees(profileDir, options.signal)
      const installed = await options.runner(['add', '--ignore-scripts', '--ignore-pnpmfile', '--', target], {
        cwd: profileDir, signal: options.signal,
      })
      if (installed.exitCode !== 0) return await rollback({
        code: installed.exitCode === 127 ? 'pnpm-not-found' : 'pnpm-failed', detail: installed.stderr || installed.stdout,
      })
      if (options.signal.aborted) return await rollback({ code: 'declined' })
      // pnpm's own record must confirm the hoisted layout before any inspection trusts the trees.
      const layoutAfter = layoutRefusal(await readModulesLayout(profileDir), 'after')
      if (layoutAfter !== undefined) return await rollback(layoutAfter)
      const stagedBytes = await readFile(join(profileDir, 'package.json'), 'utf8')
      const staged = managedManifestSchema.parse(JSON.parse(stagedBytes))
      const addedNames = dependencyNames(staged).filter(name => !oldNames.includes(name))
      const name = requestedName ?? (addedNames.length === 1 ? addedNames[0] : undefined)
      if (name === undefined || !addedNames.includes(name)) return await rollback({ code: 'not-a-bundle' })
      if (bundles.includes(name)) return await rollback({ code: 'already-active' })
      const bundle = await inspectBundle(profileDir, name)
      if ('code' in bundle) return await rollback(bundle)
      const packages = inspectAddedPackages(journal.lockfileBytes, await optionalText(join(profileDir, 'pnpm-lock.yaml')))
      const needsBuild = [...new Set([
        ...packages.requiresBuild,
        ...changedBuildTrees(buildBefore, await collectBuildTrees(profileDir, options.signal)),
      ])]
      if (needsBuild.length) return await rollback({ code: 'needs-build', detail: needsBuild.join(', ') })
      const preview: InstallPreview = {
        spec, name, version: bundle.version, source: request.source, clientHalf: bundle.clientHalf, addedPackages: packages.added,
        ...journal.sourcePath === undefined ? {} : { stagedFrom: journal.sourcePath },
      }
      const handle: ParkedInstall = {
        preview,
        confirm: () => { choose('confirm'); return operation },
        cancel: () => {
          choose('cancel')
          return operation.then((outcome) => {
            if (outcome.kind === 'refused') return outcome.rollback
            throw new Error('A committed install cannot be cancelled.')
          })
        },
      }
      ready.resolve({ kind: 'parked', install: handle })
      if (await decision.promise === 'cancel') return await rollback({ code: 'declined' })
      options.signal.throwIfAborted()
      const candidateBundles = [...bundles, name]
      validateComposition(profileDir, candidateBundles)
      const committedManifestBytes = manifestBytes(setBundles(staged, candidateBundles))
      await writeJournal(profileDir, { ...journal, phase: 'committing', committedManifestBytes })
      options.signal.throwIfAborted()
      await writeFileAtomic(join(profileDir, 'package.json'), committedManifestBytes, { mode: 0o600 })
      committed = true
      await clearJournal(profileDir)
      return { kind: 'committed', name, version: bundle.version, readiness: 'restart-required' }
    } catch (error) {
      if (committed) throw new ProfilePluginError('restore-failed', 'Install committed; recovery must clear its journal: ' + String(error))
      if (error instanceof ProfilePluginError) throw error
      // A package tree inspection refuses to read cannot be proven build-free.
      if (error instanceof BuildTreeRejection) return await rollback({ code: 'needs-build', detail: error.message })
      return await rollback({ code: options.signal.aborted ? 'declined' : 'compose-failed', detail: String(error) })
    }
  }).finally(() => { options.signal.removeEventListener('abort', abort) })
  // Both public phases observe this promise; auto-cancel errors remain available
  // to a later cancel/confirm call without becoming unhandled rejections.
  void operation.then((outcome) => { if (outcome.kind === 'refused') ready.resolve(outcome) }, (error: unknown) => { ready.reject(error) })
  return ready.promise
}
/**
 * Deactivate a non-template bundle before script-disabled dependency cleanup; recovery never reactivates it.
 * @param profileDir - profile directory.
 * @param name - exact active bundle dependency key.
 * @param options - explicit process dependencies.
 * @returns deactivation and package-manager cleanup status.
 */
export async function removePlugin(profileDir: string, name: string, options: CoreOptions): Promise<RemoveOutcome> {
  if (process.platform === 'win32') return { kind: 'refused', code: 'unsupported-platform' }
  if (PROTECTED_BUNDLES.has(name)) return { kind: 'refused', code: 'template-bundle' }
  return withProfileLease(profileDir, options.signal, async (id) => {
    await requireRecovered(profileDir, options)
    const bytes = await optionalText(join(profileDir, 'package.json'))
    if (bytes === null) return { kind: 'refused', code: 'not-installed' }
    const manifest = managedManifestSchema.parse(JSON.parse(bytes))
    const bundles = manifest.shres?.profile?.bundles ?? []
    if (!bundles.includes(name)) return { kind: 'refused', code: 'not-installed' }
    const committedManifestBytes = manifestBytes(setBundles(manifest, bundles.filter(bundle => bundle !== name)))
    const stagedPath = await retainedSource(profileDir, manifest, name)
    const journal: PluginJournal = {
      version: 1, id, op: 'remove', pid: process.pid, startedAt: new Date().toISOString(), spec: name,
      phase: 'committing', manifestBytes: bytes, lockfileBytes: await optionalText(join(profileDir, 'pnpm-lock.yaml')),
      committedManifestBytes, ...stagedPath === undefined ? {} : { stagedPath },
    }
    await writeJournal(profileDir, journal)
    await writeFileAtomic(join(profileDir, 'package.json'), committedManifestBytes, { mode: 0o600 })
    let result: RemoveOutcome
    try {
      const removed = await options.runner(['remove', '--config.ignore-scripts=true', '--config.ignore-pnpmfile=true', '--', name], {
        cwd: profileDir, signal: options.signal,
      })
      if (removed.exitCode === 0) await clearStagedSource(profileDir, stagedPath)
      result = removed.exitCode === 0 ? { kind: 'removed', pnpm: 'ok' }
        : { kind: 'removed', pnpm: 'failed', detail: removed.stderr || removed.stdout }
    } catch (error) {
      options.signal.throwIfAborted()
      result = { kind: 'removed', pnpm: 'failed', detail: String(error) }
    }
    await clearJournal(profileDir)
    return result
  })
}
/**
 * Compare desired profile membership with the running host's immutable boot snapshot.
 * @param profileDir - profile directory.
 * @param bootBundles - names captured before mounting the tree.
 * @returns active and restart-required bundle states, each reporting whether the core accepts its removal.
 */
export async function pluginStates(profileDir: string, bootBundles: readonly string[]): Promise<PluginStateEntry[]> {
  const manifest = managedManifestSchema.parse(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')))
  const desired = manifest.shres?.profile?.bundles ?? []
  return Promise.all([...new Set([...desired, ...bootBundles])].map(async (name) => {
    const bytes = await optionalText(join(profileDir, 'node_modules', name, 'package.json'))
    const version = bytes === null ? undefined : (JSON.parse(bytes) as { version?: string }).version
    const wanted = desired.includes(name)
    return {
      name, ...version === undefined ? {} : { version },
      state: wanted
        ? bootBundles.includes(name) ? 'active' as const : 'installed-restart-required' as const
        : 'removed-restart-required' as const,
      removable: wanted && !PROTECTED_BUNDLES.has(name),
    }
  }))
}
