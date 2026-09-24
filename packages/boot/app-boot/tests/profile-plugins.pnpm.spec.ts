/** Offline package-manager evidence in isolated homes and stores; no browser or model is contacted. */
import { execFileSync } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import npa from 'npm-package-arg'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_BUNDLES, healProfilesModuleFallback, initProfile, resolveProfileDir } from '../src/profile.ts'
import { beginPluginInstall, pluginStates, removePlugin, withRecoveredProfile } from '../src/profile-plugins.ts'
import { nodePnpmRunner } from '../src/profile-pnpm.ts'
import { PLUGIN_JOURNAL } from '../src/profile-plugin-journal.ts'
import type { CoreOptions, InstallBegin } from '../src/profile-plugin-types.ts'

let root: string
let profile: string
let options: CoreOptions
const appAnchor = fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url))
async function fixture(name: string, extra: Record<string, unknown> = {}, parent = root): Promise<string> {
  const directory = join(parent, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name, version: '1.0.0', type: 'module', main: 'index.js', shres: { bundle: { patch: 'cordis.patch.yml' } }, ...extra,
  }))
  await writeFile(join(directory, 'index.js'), 'export const name = "fixture-plugin"\n')
  await writeFile(join(directory, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(directory, 'build.js'), 'import {writeFileSync} from "node:fs"; writeFileSync('
    + JSON.stringify(join(root, 'script-ran')) + ', "ran")\n')
  return directory
}
async function assertRefusal(result: InstallBegin, code: string): Promise<void> {
  if (result.kind === 'parked') { await result.install.cancel(); throw new Error('Unexpected consent preview for ' + code) }
  expect(result.refusal.code, JSON.stringify(result)).toBe(code)
  await expect(access(join(root, 'script-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'profile-pnpm-offline-'))
  const home = join(root, 'home')
  profile = resolveProfileDir('fixture', home)
  initProfile(profile, DEFAULT_PROFILE_BUNDLES)
  healProfilesModuleFallback(appAnchor, home)
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as Record<string, unknown>
  await writeFile(join(profile, 'package.json'), JSON.stringify({ ...manifest, scripts: { postinstall: 'node ./profile-hook.cjs' } }))
  await writeFile(join(profile, 'profile-hook.cjs'), 'require("node:fs").writeFileSync("profile-script-ran", "ran")\n')
  await writeFile(join(profile, '.pnpmfile.cjs'), 'throw new Error("pnpmfile must not execute")\n')
  options = {
    invokingCwd: root, signal: new AbortController().signal,
    runner: (args, run) => {
      const separator = args.indexOf('--')
      const flags = ['--config.offline=true', '--store-dir', join(root, 'store')]
      return nodePnpmRunner(separator < 0 ? [...args, ...flags] : [...args.slice(0, separator), ...flags, ...args.slice(separator)], run)
    },
  }
})
afterEach(async () => {
  try { await expect(access(join(profile, 'profile-script-ran'))).rejects.toMatchObject({ code: 'ENOENT' }) }
  finally { await rm(root, { recursive: true, force: true }) }
})

describe.runIf(process.platform !== 'win32')('offline managed plugin installation', () => {
  it.each(['relative', 'absolute', 'aliased-profile'])('snapshots a %s path, survives reinstall, composes templates, and removes the copy', async (mode) => {
    const source = await fixture('plugin-hello')
    if (mode === 'aliased-profile') {
      await symlink(join(root, 'home'), join(root, 'home-link'), 'dir')
      profile = join(root, 'home-link/profiles/fixture')
    }
    const begin = await beginPluginInstall(profile, mode === 'relative' ? './plugin-hello' : source, options)
    expect(begin.kind, JSON.stringify(begin)).toBe('parked')
    if (begin.kind !== 'parked') throw new Error(JSON.stringify(begin))
    let settled = false
    try {
      expect(begin.install.preview).toMatchObject({ name: 'plugin-hello', version: '1.0.0', source: 'path' })
      expect((await lstat(join(profile, 'node_modules/plugin-hello'))).isSymbolicLink()).toBe(false)
      await writeFile(join(source, 'index.js'), 'changed source after copy\n')
      expect(await readFile(join(profile, 'node_modules/plugin-hello/index.js'), 'utf8')).not.toContain('changed source')
      expect(await begin.install.confirm()).toMatchObject({ kind: 'committed', name: 'plugin-hello' })
      settled = true
    } finally { if (!settled) await begin.install.cancel() }
    expect(await pluginStates(profile, DEFAULT_PROFILE_BUNDLES)).toContainEqual({
      name: 'plugin-hello', version: '1.0.0', state: 'installed-restart-required', removable: true,
    })
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { dependencies: { 'plugin-hello': string } }
    const saved = npa(manifest.dependencies['plugin-hello'], profile)
    expect(saved.type).toBe('directory')
    expect(dirname(await realpath(String(saved.fetchSpec)))).toBe(await realpath(join(profile, '.shres-plugin-sources')))
    await withRecoveredProfile(profile, options, async () => {
      const reinstall = await options.runner(['install', '--offline', '--ignore-scripts', '--ignore-pnpmfile'], {
        cwd: profile, signal: options.signal,
      })
      expect(reinstall.exitCode, reinstall.stderr).toBe(0)
    })
    expect(await readFile(join(profile, 'node_modules/plugin-hello/index.js'), 'utf8')).not.toContain('changed source')
    expect(await readdir(join(profile, '.shres-plugin-sources'))).toHaveLength(1)
    if (mode === 'aliased-profile') profile = await realpath(profile)
    expect(await removePlugin(profile, 'plugin-hello', options)).toEqual({ kind: 'removed', pnpm: 'ok' })
    expect(await readdir(join(profile, '.shres-plugin-sources'))).toEqual([])
    const after: unknown = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(after).not.toHaveProperty('dependencies.plugin-hello')
  }, 30_000)
  it('refuses lifecycle builds without ever executing the package script', async () => {
    const source = await fixture('plugin-scripted', { scripts: { install: 'node build.js' } })
    const before = await readFile(join(profile, 'package.json'), 'utf8')
    await assertRefusal(await beginPluginInstall(profile, source, options), 'needs-build')
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
  }, 30_000)
  it('finds a transitive lifecycle build with scripts disabled', async () => {
    const source = await fixture('plugin-transitive', { dependencies: { 'native-dependency': 'file:./vendor/native-dependency' } })
    await fixture('native-dependency', { scripts: { postinstall: 'node build.js' } }, join(source, 'vendor'))
    await assertRefusal(await beginPluginInstall(profile, source, options), 'needs-build')
  }, 30_000)
  it('does not refuse a clean plugin because an unchanged scripted dependency is already installed', async () => {
    // A scripted package installed earlier (scripts disabled) stays byte-identical
    // while a clean plugin whose own dependency shares its name is added.
    const old = await fixture('build-foo', { version: '1.0.0', scripts: { install: 'node build.js' } }, join(root, 'old'))
    const setup = await options.runner(['add', '--ignore-scripts', '--ignore-pnpmfile', '--', 'file:' + old], { cwd: profile, signal: options.signal })
    expect(setup.exitCode, setup.stderr).toBe(0)
    const source = await fixture('plugin-clean', { dependencies: { 'build-foo': 'file:./vendor/build-foo' } })
    await fixture('build-foo', { version: '2.0.0', shres: undefined }, join(source, 'vendor'))
    const begin = await beginPluginInstall(profile, source, options)
    expect(begin.kind, JSON.stringify(begin)).toBe('parked')
    // The lockfile added a build-foo entry, which a name-only match would have
    // blamed on the unchanged scripted 1.0.0 tree still installed at the root.
    if (begin.kind === 'parked') {
      expect(begin.install.preview.addedPackages.some(key => key.startsWith('build-foo@'))).toBe(true)
    }
    const rootFoo = JSON.parse(await readFile(join(profile, 'node_modules/build-foo/package.json'), 'utf8')) as { version: string }
    expect(rootFoo.version).toBe('1.0.0')
    if (begin.kind === 'parked') expect(await begin.install.cancel()).toMatchObject({ filesRestored: true })
    await expect(access(join(root, 'script-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)
  it('refuses as needs-build when a build-declaring tree holds a special file it will not read', async () => {
    const native = join(profile, 'node_modules', 'native-fifo')
    await mkdir(native, { recursive: true })
    await writeFile(join(native, 'package.json'), JSON.stringify({ name: 'native-fifo', version: '1.0.0' }))
    await writeFile(join(native, 'binding.gyp'), '{}')
    execFileSync('mkfifo', [join(native, 'pipe')])
    const before = await readFile(join(profile, 'package.json'), 'utf8')
    const result = await beginPluginInstall(profile, await fixture('plugin-hello'), options)
    await assertRefusal(result, 'needs-build')
    if (result.kind === 'refused') expect(result.refusal.detail).toMatch(/pipe is not a regular file/)
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
  }, 30_000)
  it('refuses an isolated-layout profile, including a relinkable orphan store bucket, before pnpm runs', async () => {
    // The reviewer's orphan scenario: under the isolated linker a removed
    // package leaves its store bucket, which a later add could relink with no
    // tree change. Managed installs refuse the layout instead.
    const workspace = join(profile, 'pnpm-workspace.yaml')
    await writeFile(workspace, (await readFile(workspace, 'utf8')).replace('nodeLinker: hoisted', 'nodeLinker: isolated'))
    const native = await fixture('native-x', { scripts: { install: 'node build.js' } }, join(root, 'orphan'))
    const run = (args: string[]) => options.runner(args, { cwd: profile, signal: options.signal })
    expect((await run(['add', '--ignore-scripts', '--ignore-pnpmfile', '--', 'file:' + native])).exitCode).toBe(0)
    expect((await run(['remove', '--config.ignore-scripts=true', '--config.ignore-pnpmfile=true', '--', 'native-x'])).exitCode).toBe(0)
    const buckets = await readdir(join(profile, 'node_modules', '.pnpm'))
    expect(buckets.some(entry => entry.startsWith('native-x@'))).toBe(true)
    const manifestBefore = await readFile(join(profile, 'package.json'), 'utf8')
    const lockBefore = await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')
    const source = await fixture('plugin-relinks', { dependencies: { 'native-x': 'file:' + native } })
    const result = await beginPluginInstall(profile, source, options)
    if (result.kind === 'parked') await result.install.cancel()
    expect(result).toMatchObject({ kind: 'refused', refusal: { code: 'unsupported-layout', nodeLinker: 'isolated' } })
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')).toBe(lockBefore)
    await expect(access(join(profile, PLUGIN_JOURNAL))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(profile, '.shres-plugin-sources'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'script-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)
  it('refuses external local dependencies and symlinks without changing profile bytes', async () => {
    const source = await fixture('plugin-external', { dependencies: { sibling: 'file:../sibling' } })
    const before = await readFile(join(profile, 'package.json'), 'utf8')
    await assertRefusal(await beginPluginInstall(profile, source, options), 'link-spec')
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
    const linked = await fixture('plugin-linked')
    await symlink(join(linked, 'index.js'), join(linked, 'alias.js'))
    await assertRefusal(await beginPluginInstall(profile, linked, options), 'link-spec')
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
    await expect(access(join(profile, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(profile, '.shres-plugin-sources'))).toEqual([])
  }, 30_000)
  it('refuses foreign DSH bundles and live link requests', async () => {
    const source = await fixture('plugin-dsh', { shres: undefined, dsh: { bundle: { patch: 'cordis.patch.yml' } } })
    await assertRefusal(await beginPluginInstall(profile, source, options), 'foreign-dsh')
    await assertRefusal(await beginPluginInstall(profile, 'link:' + source, options), 'link-spec')
  }, 30_000)
})
