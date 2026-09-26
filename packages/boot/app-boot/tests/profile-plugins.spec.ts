/** Managed profile transactions with real temporary files and a deterministic package-manager boundary. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginPluginInstall, pluginStates, recoverPluginTransaction, removePlugin, withRecoveredProfile } from '../src/profile-plugins.ts'
import { PLUGIN_JOURNAL } from '../src/profile-plugin-journal.ts'
import type { CoreOptions } from '../src/profile-plugin-types.ts'
import type { PnpmRunner } from '../src/profile-pnpm.ts'

let dir: string
let original: string
let runner: ReturnType<typeof vi.fn<PnpmRunner>>
let options: CoreOptions
const ok = { exitCode: 0, stdout: '', stderr: '' }
async function json(path: string, value: unknown): Promise<void> { await writeFile(path, JSON.stringify(value, null, 2) + '\n') }
async function packageFiles(name: string, extra: Record<string, unknown> = {}): Promise<void> {
  const folder = join(dir, 'node_modules', name)
  await mkdir(folder, { recursive: true })
  await json(join(folder, 'package.json'), { name, version: '1.0.0', main: 'index.js', type: 'module', shres: { bundle: { patch: 'cordis.patch.yml' } }, ...extra })
  await writeFile(join(folder, 'index.js'), 'throw new Error("Package module must not execute before a real boot")\n')
  await writeFile(join(folder, 'cordis.patch.yml'), '[]\n')
}
async function stage(extra: Record<string, unknown> = {}): Promise<void> {
  await json(join(dir, 'package.json'), { ...JSON.parse(original), dependencies: { demo: '1.0.0' } })
  await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\npackages:\n  demo@1.0.0: {}\nsnapshots:\n  demo@1.0.0: {}\n')
  await packageFiles('demo', extra)
  // Real pnpm records the linker it materialized; managed installs require hoisted.
  await writeFile(join(dir, 'node_modules/.modules.yaml'), JSON.stringify({ layoutVersion: 5, nodeLinker: 'hoisted' }))
}
async function parked() {
  const result = await beginPluginInstall(dir, 'demo', options)
  expect(result.kind).toBe('parked')
  if (result.kind !== 'parked') throw new Error('Expected staged install: ' + JSON.stringify(result))
  return result.install
}
async function journal(extra: Record<string, unknown> = {}): Promise<void> {
  await json(join(dir, PLUGIN_JOURNAL), {
    version: 1, id: randomUUID(), op: 'install', pid: process.pid, startedAt: new Date().toISOString(),
    spec: 'demo', phase: 'mutating', manifestBytes: original, lockfileBytes: null, ...extra,
  })
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'profile-plugins-'))
  original = '{"name":"profile-fixture","private":true,"shres":{"profile":{"bundles":[]}}}\n'
  await writeFile(join(dir, 'package.json'), original)
  runner = vi.fn<PnpmRunner>().mockImplementation(async (args) => { if (args[0] === 'add') await stage(); return ok })
  options = { runner, signal: new AbortController().signal, invokingCwd: dir }
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('managed profile plugins', () => {
  it('journals before pnpm, holds the lock through preview, and composes without executing package code', async () => {
    runner.mockImplementation(async (args) => {
      if (args[0] === 'add') {
        expect(JSON.parse(await readFile(join(dir, PLUGIN_JOURNAL), 'utf8')) as unknown).toHaveProperty('manifestBytes', original)
        expect(args).toEqual(['add', '--ignore-scripts', '--ignore-pnpmfile', '--', 'demo'])
        await stage()
      }
      return ok
    })
    const install = await parked()
    expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as unknown).toHaveProperty('shres.profile.bundles', [])
    expect(await recoverPluginTransaction(dir, options)).toEqual({ kind: 'owner-alive', pid: process.pid })
    await expect(removePlugin(dir, 'demo', options)).rejects.toMatchObject({ code: 'transaction-pending' })
    expect(await install.confirm()).toEqual({ kind: 'committed', name: 'demo', version: '1.0.0', readiness: 'restart-required' })
    expect(await pluginStates(dir, [])).toEqual([{ name: 'demo', version: '1.0.0', state: 'installed-restart-required', removable: true }])
    await expect(readFile(join(dir, PLUGIN_JOURNAL))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('restores exact metadata and removes a lockfile created by a declined install', async () => {
    const install = await parked()
    expect(await install.cancel()).toEqual({ filesRestored: true, reinstall: 'ok' })
    expect(await install.cancel()).toEqual({ filesRestored: true, reinstall: 'ok' })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(original)
    await expect(readFile(join(dir, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('restores prior lockfile bytes even if offline pnpm rewrites them', async () => {
    const lock = 'lockfileVersion: \'9.0\'\npackages: {}\n'
    await writeFile(join(dir, 'pnpm-lock.yaml'), lock)
    const install = await parked()
    runner.mockImplementation(async () => { await writeFile(join(dir, 'pnpm-lock.yaml'), 'changed'); return ok })
    await install.cancel()
    expect(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe(lock)
  })
  it.each(['link:../source', '--config.ignore-scripts=false', ''])('refuses unsafe input %s before mutation', async (spec) => {
    const result = await beginPluginInstall(dir, spec, options)
    expect(result.kind).toBe('refused')
    expect(runner).not.toHaveBeenCalled()
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(original)
  })
  it('refuses an existing dependency rather than replacing it', async () => {
    await json(join(dir, 'package.json'), { dependencies: { demo: '0.9.0' } })
    expect(await beginPluginInstall(dir, 'demo@latest', options)).toMatchObject({ kind: 'refused', refusal: { code: 'already-active' } })
    expect(runner).not.toHaveBeenCalled()
  })
  it.each([
    [{ shres: undefined }, 'not-a-bundle'],
    [{ dsh: { bundle: {} } }, 'foreign-dsh'],
    [{ scripts: { install: 'node build.js' } }, 'needs-build'],
  ] as const)('refuses incompatible package metadata %j', async (extra, code) => {
    runner.mockImplementation(async (args) => { if (args[0] === 'add') await stage(extra); return ok })
    expect(await beginPluginInstall(dir, 'demo', options)).toMatchObject({ kind: 'refused', refusal: { code } })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(original)
  })
  it('ignores pre-existing scripted packages when inspecting a new file dependency', async () => {
    await packageFiles('existing-native', { scripts: { install: 'node build.js' } })
    runner.mockImplementation(async (args) => {
      if (args[0] === 'add') {
        await stage()
        await writeFile(join(dir, 'pnpm-lock.yaml'), 'packages:\n  demo@file:../source: {}\nsnapshots: {}\n')
      }
      return ok
    })
    await mkdir(join(dir, 'source'))
    await json(join(dir, 'source/package.json'), { name: 'demo', version: '1.0.0' })
    const result = await beginPluginInstall(dir, './source', options)
    expect(result.kind).toBe('parked')
    if (result.kind !== 'parked') throw new Error('Expected local install to reach consent')
    expect(runner.mock.calls[0]?.[0].at(-1)).toContain('file:' + join(dir, '.shres-plugin-sources') + '/')
    await result.install.cancel()
  })

  it('inspects transitive manifests for lifecycle builds', async () => {
    runner.mockImplementation(async (args) => {
      if (args[0] === 'add') {
        await stage()
        await packageFiles('native-helper', { scripts: { postinstall: 'node build.js' } })
        await writeFile(join(dir, 'pnpm-lock.yaml'), 'packages:\n  demo@1.0.0: {}\n  native-helper@1.0.0: {}\nsnapshots: {}\n')
      }
      return ok
    })
    expect(await beginPluginInstall(dir, 'demo', options)).toMatchObject({ kind: 'refused', refusal: { code: 'needs-build' } })
  })
  it('refuses invalid composed patches and rolls back the dependency declaration', async () => {
    const install = await parked()
    await writeFile(join(dir, 'node_modules/demo/cordis.patch.yml'), '[broken')
    expect(await install.confirm()).toMatchObject({ kind: 'refused', refusal: { code: 'compose-failed' } })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(original)
  })
  it('auto-cancels a parked install through its owner signal', async () => {
    const controller = new AbortController()
    options.signal = controller.signal
    const install = await parked()
    controller.abort()
    expect(await install.cancel()).toMatchObject({ filesRestored: true })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(original)
  })
  it('recovers an orphan owned by this PID and its abandoned lock', async () => {
    await stage()
    await journal()
    await writeFile(join(dir, 'package.json.lock'), String(process.pid) + '\n')
    expect(await recoverPluginTransaction(dir, options)).toMatchObject({ kind: 'recovered', op: 'install', rollback: { reinstall: 'ok' } })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(original)
  })
  it('preserves a consented manifest when the process stopped before clearing its journal', async () => {
    const committed = '{"shres":{"profile":{"bundles":["demo"]}}}\n'
    await writeFile(join(dir, 'package.json'), committed)
    await journal({ phase: 'committing', committedManifestBytes: committed })
    expect(await recoverPluginTransaction(dir, options)).toEqual({ kind: 'recovered', op: 'install' })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(committed)
    expect(runner).not.toHaveBeenCalled()
  })
  it('recovers an owned source snapshot through a canonical profile alias', async () => {
    const id = randomUUID()
    const snapshot = join(dir, '.shres-plugin-sources', id)
    await mkdir(snapshot, { recursive: true })
    await writeFile(join(snapshot, 'keep-until-recovery'), 'staged')
    await journal({ id, stagedPath: snapshot })
    expect(await recoverPluginTransaction(await realpath(dir), options)).toMatchObject({ kind: 'recovered', op: 'install' })
    await expect(readFile(join(snapshot, 'keep-until-recovery'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an unowned journal path without deleting it and names the repair location', async () => {
    const id = randomUUID()
    const outside = join(dir, 'other-profile', '.shres-plugin-sources', id)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'keep'), 'unowned')
    await journal({ id, stagedPath: outside })
    await expect(recoverPluginTransaction(dir, options)).rejects.toThrow(join(dir, PLUGIN_JOURNAL))
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('unowned')
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(original)
    expect(runner).not.toHaveBeenCalled()
  })

  it('times out without stealing a foreign process lock', async () => {
    const pid = String(process.ppid) + '\n'
    await writeFile(join(dir, 'package.json.lock'), pid)
    await expect(withRecoveredProfile(dir, options, () => 0)).rejects.toMatchObject({ code: 'lock-timeout' })
    expect(await readFile(join(dir, 'package.json.lock'), 'utf8')).toBe(pid)
  })

  it('reports a live foreign owner without mutating the profile', async () => {
    await journal({ pid: process.ppid })
    expect(await recoverPluginTransaction(dir, options)).toEqual({ kind: 'owner-alive', pid: process.ppid })
    expect(runner).not.toHaveBeenCalled()
  })
  it('keeps the same lock across raw-command recovery and mutation', async () => {
    await journal()
    await withRecoveredProfile(dir, options, async (recovery) => {
      expect(recovery.kind).toBe('recovered')
      expect(await readFile(join(dir, 'package.json.lock'), 'utf8')).toBe(String(process.pid) + '\n')
      await expect(beginPluginInstall(dir, 'other', options)).rejects.toMatchObject({ code: 'transaction-pending' })
    })
    await expect(readFile(join(dir, 'package.json.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('deactivates before removal even when package-manager cleanup fails', async () => {
    await json(join(dir, 'package.json'), { shres: { profile: { bundles: ['demo'] } }, dependencies: { demo: '1.0.0' } })
    runner.mockImplementation(async () => {
      expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as unknown).toHaveProperty('shres.profile.bundles', [])
      return { exitCode: 1, stdout: '', stderr: 'cleanup failed' }
    })
    expect(await removePlugin(dir, 'demo', options)).toEqual({ kind: 'removed', pnpm: 'failed', detail: 'cleanup failed' })
    expect(await pluginStates(dir, ['demo'])).toEqual([{ name: 'demo', state: 'removed-restart-required', removable: false }])
  })
})
