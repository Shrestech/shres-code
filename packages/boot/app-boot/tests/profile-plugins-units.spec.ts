/**
 * Edge branches of the managed plugin transaction core over real temporary
 * profiles and a fabricated runner: platform refusals, source-root and
 * staging refusals, name resolution failures, rollback reporting, cancel
 * after commit, removal matrices, recovery refusals, and boot-snapshot state
 * projection.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
// The lease release finishes file cleanup asynchronously; let it settle before removal.
const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 25)) }
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Test-only fault injection over node:fs/promises, passing through otherwise:
 * a failing lstat of one path, a directory swapped for an outside link right
 * after its mkdir, and one failing rm of one path.
 */
const faults = vi.hoisted(() => ({
  lstat: undefined as { path: string; error: NodeJS.ErrnoException } | undefined,
  swapAfterMkdir: undefined as { path: string; target: string } | undefined,
  rmOnce: undefined as { path: string; error: NodeJS.ErrnoException } | undefined,
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (faults.lstat !== undefined && String(args[0]) === faults.lstat.path) throw faults.lstat.error
      return actual.lstat(...args)
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const made = await actual.mkdir(...args)
      const swap = faults.swapAfterMkdir
      if (swap !== undefined && String(args[0]) === swap.path) {
        faults.swapAfterMkdir = undefined
        await actual.rm(swap.path, { recursive: true, force: true })
        await actual.symlink(swap.target, swap.path, 'dir')
      }
      return made
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const fault = faults.rmOnce
      if (fault !== undefined && String(args[0]) === fault.path) {
        faults.rmOnce = undefined
        throw fault.error
      }
      return actual.rm(...args)
    },
  }
})

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}
import { beginPluginInstall, pluginStates, recoverPluginTransaction, removePlugin, withRecoveredProfile } from '../src/profile-plugins.ts'
import { PLUGIN_JOURNAL } from '../src/profile-plugin-journal.ts'
import { ProfilePluginError, type CoreOptions, type ParkedInstall } from '../src/profile-plugin-types.ts'
import type { PnpmRunner } from '../src/profile-pnpm.ts'

const dirs: string[] = []
const children: ReturnType<typeof spawn>[] = []

afterEach(async () => {
  faults.lstat = undefined
  faults.swapAfterMkdir = undefined
  faults.rmOnce = undefined
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await settle()
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shres-plugins-units-'))
  dirs.push(dir)
  return dir
}

const ok = { exitCode: 0, stdout: '', stderr: '' }
const options = (
  runner: PnpmRunner,
  signal: AbortSignal = new AbortController().signal,
  invokingCwd: string = tmpdir(),
): CoreOptions => ({ runner, signal, invokingCwd })

function write(path: string, body: string): void {
  writeFileSync(path, body)
}

function json(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2) + '\n')
}

function originalManifest(bundles: string[] = [], dependencies: Record<string, string> = {}): string {
  return JSON.stringify({ name: 'profile-fixture', private: true, shres: { profile: { bundles } }, dependencies }, null, 2) + '\n'
}

function seededProfile(bundles: string[] = [], dependencies: Record<string, string> = {}): string {
  const dir = scratch()
  write(join(dir, 'package.json'), originalManifest(bundles, dependencies))
  return dir
}

function packageFiles(dir: string, name: string, extra: Record<string, unknown> = {}): void {
  const folder = join(dir, 'node_modules', name)
  mkdirSync(folder, { recursive: true })
  json(join(folder, 'package.json'), { name, version: '1.0.0', shres: { bundle: { patch: 'cordis.patch.yml' } }, ...extra })
  write(join(folder, 'cordis.patch.yml'), '[]\n')
}

function stagedLock(names: string[]): string {
  return 'lockfileVersion: \'9.0\'\npackages:\n' + names.map(name => `  ${name}@1.0.0: {}\n`).join('') + 'snapshots: {}\n'
}

/** Record the hoisted layout real pnpm writes after an add; managed installs require it. */
function hoistedRecord(dir: string): void {
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  write(join(dir, 'node_modules', '.modules.yaml'), JSON.stringify({ layoutVersion: 5, nodeLinker: 'hoisted' }))
}

/** The happy fabricated add: declares the dependency, installs its files, and writes the lock. */
function addingRunner(dir: string, names: string[]): PnpmRunner {
  return async (args) => {
    if (args[0] !== 'add') return ok
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    for (const name of names) {
      manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
      packageFiles(dir, name)
    }
    json(join(dir, 'package.json'), manifest)
    write(join(dir, 'pnpm-lock.yaml'), stagedLock(names))
    hoistedRecord(dir)
    return ok
  }
}

async function parked(dir: string, spec: string, options: CoreOptions): Promise<ParkedInstall> {
  const result = await beginPluginInstall(dir, spec, options)
  if (result.kind !== 'parked') throw new Error('Expected a parked install: ' + JSON.stringify(result))
  return result.install
}

function stubWin32(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  return () => { Object.defineProperty(process, 'platform', descriptor) }
}

async function livePid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 2147483000)'], { stdio: 'ignore' })
  children.push(child)
  await new Promise<void>(resolve => setTimeout(resolve, 150))
  return child.pid!
}

describe('platform refusals', () => {
  it('refuses installs on win32 before touching the profile', async () => {
    const restore = stubWin32()
    try {
      const dir = seededProfile()
      const runner = vi.fn<PnpmRunner>().mockResolvedValue(ok)
      expect(await beginPluginInstall(dir, 'demo', options(runner))).toMatchObject({ kind: 'refused', refusal: { code: 'unsupported-platform' } })
      expect(runner).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('refuses removals on win32 before touching the profile', async () => {
    const restore = stubWin32()
    try {
      const dir = seededProfile(['demo'])
      const runner = vi.fn<PnpmRunner>().mockResolvedValue(ok)
      expect(await removePlugin(dir, 'demo', options(runner))).toEqual({ kind: 'refused', code: 'unsupported-platform' })
      expect(runner).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})

describe('withRecoveredProfile and recoverPluginTransaction', () => {
  it('reports an owner-alive journal as a pending transaction instead of recovering', async () => {
    const dir = seededProfile()
    json(join(dir, PLUGIN_JOURNAL), {
      version: 1, id: randomUUID(), op: 'install', pid: await livePid(), startedAt: new Date().toISOString(),
      spec: 'demo', phase: 'mutating', manifestBytes: originalManifest(), lockfileBytes: null,
    })
    await expect(withRecoveredProfile(dir, options(async () => ok), recovery => recovery))
      .rejects.toMatchObject({ code: 'transaction-pending' })
  })

  it('reports an empty profile as having nothing to recover', async () => {
    const dir = seededProfile()
    expect(await recoverPluginTransaction(dir, options(async () => ok))).toEqual({ kind: 'none' })
    await expect(withRecoveredProfile(dir, options(async () => ok), recovery => recovery)).resolves.toEqual({ kind: 'none' })
  })
})

describe('beginPluginInstall source-root guards', () => {
  it('refuses when the profile source root is a plain file', async () => {
    const dir = seededProfile()
    write(join(dir, '.shres-plugin-sources'), 'not a directory')
    expect(await beginPluginInstall(dir, './source', options(async () => ok)))
      .toMatchObject({ kind: 'refused', refusal: { code: 'link-spec' } })
  })

  it('refuses when the profile source root is a symbolic link', async () => {
    const dir = seededProfile()
    symlinkSync(scratch(), join(dir, '.shres-plugin-sources'), 'dir')
    expect(await beginPluginInstall(dir, './source', options(async () => ok)))
      .toMatchObject({ kind: 'refused', refusal: { code: 'link-spec' } })
  })

  it.skipIf(process.getuid?.() === 0)('propagates unreadable-profile failures from the source-root probe', async () => {
    const dir = seededProfile()
    chmodSync(dir, 0o400)
    await expect(beginPluginInstall(dir, './source', options(async () => ok))).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('propagates a source-root probe failure other than absence', async () => {
    const dir = seededProfile()
    faults.lstat = { path: join(dir, '.shres-plugin-sources'), error: errno('EIO') }
    await expect(beginPluginInstall(dir, './source', options(async () => ok, undefined, dir))).rejects.toMatchObject({ code: 'EIO' })
  })

  it('refuses a source root swapped for an outside link after its mkdir, touching nothing outside', async () => {
    const dir = seededProfile()
    const outside = scratch()
    write(join(outside, 'keep.txt'), 'keep')
    const source = join(dir, 'source')
    mkdirSync(source)
    json(join(source, 'package.json'), { name: 'demo', version: '1.0.0' })
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    faults.swapAfterMkdir = { path: join(dir, '.shres-plugin-sources'), target: outside }
    const outcome = beginPluginInstall(dir, './source', options(addingRunner(dir, ['demo']), undefined, dir))
    // Rollback refuses to clear staging through the link, so the failure is
    // reported as a restore failure rather than silently deleting outside.
    await expect(outcome).rejects.toMatchObject({ code: 'restore-failed' })
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it('rolls a staging refusal back to the exact prior metadata', async () => {
    const dir = seededProfile()
    const source = join(dir, 'source')
    mkdirSync(source)
    const before = await import('node:fs/promises').then(fs => fs.readFile(join(dir, 'package.json'), 'utf8'))
    expect(await beginPluginInstall(dir, './source', options(addingRunner(dir, []), undefined, dir)))
      .toMatchObject({ kind: 'refused', refusal: { code: 'invalid-spec' } })
    expect(await import('node:fs/promises').then(fs => fs.readFile(join(dir, 'package.json'), 'utf8'))).toBe(before)
  })
})

describe('beginPluginInstall layout guard', () => {
  it.each([
    ['an isolated layout', JSON.stringify({ nodeLinker: 'isolated' }), 'isolated'],
    ['a record without nodeLinker', JSON.stringify({ layoutVersion: 5 }), null],
    ['a malformed record', '{ unterminated', null],
  ] as const)('refuses %s before any journal, pnpm run, or metadata change', async (_label, record, linker) => {
    const dir = seededProfile()
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    write(join(dir, 'node_modules', '.modules.yaml'), record)
    const runner = vi.fn<PnpmRunner>(async () => ok)
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    const result = await beginPluginInstall(dir, 'demo', options(runner))
    if (result.kind === 'parked') await result.install.cancel()
    expect(result).toMatchObject({ kind: 'refused', refusal: { code: 'unsupported-layout', nodeLinker: linker }, rollback: { reinstall: 'skipped' } })
    expect(runner).not.toHaveBeenCalled()
    await expect(readFile(join(dir, PLUGIN_JOURNAL), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it.each([
    ['writes no layout record', undefined, null],
    ['records an isolated layout', JSON.stringify({ nodeLinker: 'isolated' }), 'isolated'],
  ] as const)('rolls back when pnpm %s', async (_label, record, linker) => {
    const dir = seededProfile()
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    const add = addingRunner(dir, ['demo'])
    const runner: PnpmRunner = async (args, run) => {
      const outcome = await add(args, run)
      if (args[0] === 'add') {
        rmSync(join(dir, 'node_modules', '.modules.yaml'))
        if (record !== undefined) write(join(dir, 'node_modules', '.modules.yaml'), record)
      }
      return outcome
    }
    const result = await beginPluginInstall(dir, 'demo', options(runner))
    if (result.kind === 'parked') await result.install.cancel()
    expect(result).toMatchObject({ kind: 'refused', refusal: { code: 'unsupported-layout', nodeLinker: linker }, rollback: { filesRestored: true } })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
    await expect(readFile(join(dir, PLUGIN_JOURNAL), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform !== 'win32')('refuses as needs-build when an installed manifest is a FIFO, without hanging', async () => {
    const dir = seededProfile()
    const tree = join(dir, 'node_modules', 'hostile')
    mkdirSync(tree, { recursive: true })
    spawnSync('mkfifo', [join(tree, 'package.json')])
    const runner = vi.fn<PnpmRunner>(async () => ok)
    const result = await beginPluginInstall(dir, 'demo', options(runner))
    if (result.kind === 'parked') await result.install.cancel()
    expect(result).toMatchObject({ kind: 'refused', refusal: { code: 'needs-build' } })
    expect(runner.mock.calls.some(([args]) => args[0] === 'add')).toBe(false)
  }, 5_000)
})

describe('beginPluginInstall name resolution and rollback reporting', () => {
  it('derives the requested name from the staged snapshot and reports stagedFrom', async () => {
    const dir = seededProfile()
    const source = join(dir, 'source')
    mkdirSync(source)
    json(join(source, 'package.json'), { name: 'demo', version: '1.0.0' })
    const install = await parked(dir, source, options(addingRunner(dir, ['demo'])))
    expect(install.preview).toMatchObject({ name: 'demo', version: '1.0.0', source: 'path', stagedFrom: source })
    expect(await install.confirm()).toMatchObject({ kind: 'committed', name: 'demo' })
  })

  it('stages a named directory spec under its explicit name', async () => {
    const dir = seededProfile()
    const source = join(dir, 'source')
    mkdirSync(source)
    json(join(source, 'package.json'), { name: 'demo', version: '1.0.0' })
    const runnerArgs: string[][] = []
    const install = await parked(dir, 'demo@file:./source', options(async (args) => {
      runnerArgs.push([...args])
      if (args[0] === 'add') {
        packageFiles(dir, 'demo')
        json(join(dir, 'package.json'), { name: 'profile-fixture', private: true, shres: { profile: { bundles: [] } }, dependencies: { demo: 'file:' + join(dir, '.shres-plugin-sources') } })
        write(join(dir, 'pnpm-lock.yaml'), stagedLock(['demo']))
        hoistedRecord(dir)
      }
      return ok
    }, undefined, dir))
    expect(install.preview).toMatchObject({ name: 'demo', source: 'path', stagedFrom: source })
    const target = runnerArgs[0]?.at(-1) ?? ''
    expect(target.startsWith('demo@file:' + join(dir, '.shres-plugin-sources') + '/')).toBe(true)
    expect(await install.confirm()).toMatchObject({ kind: 'committed', name: 'demo' })
  })

  it('refuses a staged snapshot whose name is already a dependency', async () => {
    const dir = seededProfile([], { demo: '0.9.0' })
    const source = join(dir, 'source')
    mkdirSync(source)
    json(join(source, 'package.json'), { name: 'demo', version: '1.0.0' })
    expect(await beginPluginInstall(dir, source, options(addingRunner(dir, ['other']))))
      .toMatchObject({ kind: 'refused', refusal: { code: 'already-active' } })
    expect(await import('node:fs/promises').then(fs => fs.readFile(join(dir, 'package.json'), 'utf8'))).toBe(originalManifest([], { demo: '0.9.0' }))
  })

  it('maps pnpm exit 127 to pnpm-not-found with the captured output', async () => {
    const dir = seededProfile()
    expect(await beginPluginInstall(dir, 'demo', options(async () => ({ exitCode: 127, stdout: 'not found', stderr: '' }))))
      .toMatchObject({ kind: 'refused', refusal: { code: 'pnpm-not-found', detail: 'not found' } })
  })

  it('maps other pnpm failures to pnpm-failed with stderr detail', async () => {
    const dir = seededProfile()
    expect(await beginPluginInstall(dir, 'demo', options(async () => ({ exitCode: 1, stdout: '', stderr: 'registry down' }))))
      .toMatchObject({ kind: 'refused', refusal: { code: 'pnpm-failed', detail: 'registry down' } })
  })

  it('auto-declines an install whose signal aborted during the pnpm run', async () => {
    const dir = seededProfile()
    const controller = new AbortController()
    expect(await beginPluginInstall(dir, 'demo', options(async () => {
      controller.abort()
      return ok
    }, controller.signal))).toMatchObject({ kind: 'refused', refusal: { code: 'declined' } })
  })

  it('refuses an add that yields no single new dependency', async () => {
    const dir = seededProfile()
    expect(await beginPluginInstall(dir, 'https://example.com/plugin-1.0.0.tgz', options(addingRunner(dir, ['alpha', 'beta']))))
      .toMatchObject({ kind: 'refused', refusal: { code: 'not-a-bundle' } })
  })

  it('refuses a staged name that never appears among the added dependencies', async () => {
    const dir = seededProfile()
    const source = join(dir, 'source')
    mkdirSync(source)
    json(join(source, 'package.json'), { name: 'demo', version: '1.0.0' })
    expect(await beginPluginInstall(dir, source, options(addingRunner(dir, ['unrelated']))))
      .toMatchObject({ kind: 'refused', refusal: { code: 'not-a-bundle' } })
  })

  it('refuses a derived name that is already an active bundle', async () => {
    const dir = seededProfile(['demo'])
    expect(await beginPluginInstall(dir, 'https://example.com/plugin-1.0.0.tgz', options(addingRunner(dir, ['demo']))))
      .toMatchObject({ kind: 'refused', refusal: { code: 'already-active' } })
  })

  it.each([
    ['changes a build input', (tree: string) => { write(join(tree, 'build.js'), 'changed during add\n') }],
    ['deletes a prior build artifact', (tree: string) => { rmSync(join(tree, 'prebuilt.node')) }],
  ] as const)('refuses as needs-build when the add %s of an unchanged-lock scripted tree', async (_label, mutate) => {
    // The lockfile keys and flags stay identical across the add, so only the
    // before/after build-tree digests can see this change.
    const dir = seededProfile()
    const tree = join(dir, 'node_modules', 'native-dep')
    mkdirSync(tree, { recursive: true })
    json(join(tree, 'package.json'), { name: 'native-dep', version: '1.0.0', scripts: { install: 'node build.js' } })
    write(join(tree, 'build.js'), 'build\n')
    write(join(tree, 'prebuilt.node'), 'artifact')
    const lock = stagedLock(['native-dep', 'demo'])
    write(join(dir, 'pnpm-lock.yaml'), lock)
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    const add = addingRunner(dir, ['demo'])
    const runner: PnpmRunner = async (args, run) => {
      const outcome = await add(args, run)
      if (args[0] === 'add') {
        mutate(tree)
        write(join(dir, 'pnpm-lock.yaml'), lock)
      }
      return outcome
    }
    const result = await beginPluginInstall(dir, 'demo', options(runner))
    // Cancel an unexpected parked transaction so a regression cannot leak the lease.
    if (result.kind === 'parked') await result.install.cancel()
    expect(result).toMatchObject({ kind: 'refused', refusal: { code: 'needs-build', detail: 'native-dep@1.0.0' } })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe(lock)
  })

  it('refuses to cancel a committed install', async () => {
    const dir = seededProfile()
    const install = await parked(dir, 'demo', options(addingRunner(dir, ['demo'])))
    expect(await install.confirm()).toMatchObject({ kind: 'committed' })
    await expect(install.cancel()).rejects.toThrow('A committed install cannot be cancelled.')
  })

  it('keeps a committed manifest when clearing the journal fails, and recovery keeps it too', async () => {
    const dir = seededProfile()
    const install = await parked(dir, 'demo', options(addingRunner(dir, ['demo'])))
    faults.rmOnce = { path: join(dir, PLUGIN_JOURNAL), error: errno('EIO') }
    await expect(install.confirm()).rejects.toMatchObject({ code: 'restore-failed' })
    const committed = await readFile(join(dir, 'package.json'), 'utf8')
    expect((JSON.parse(committed) as { shres: { profile: { bundles: string[] } } }).shres.profile.bundles).toContain('demo')
    // The committing journal survived and names exactly the committed bytes.
    expect(await readFile(join(dir, PLUGIN_JOURNAL), 'utf8')).toContain('"phase":"committing"')
    await settle()
    expect(await recoverPluginTransaction(dir, options(async () => ok))).toEqual({ kind: 'recovered', op: 'install' })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(committed)
    await expect(readFile(join(dir, PLUGIN_JOURNAL), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rethrows restore failures from the rollback path instead of disguising them', async () => {
    const dir = seededProfile()
    write(join(dir, 'pnpm-lock.yaml'), stagedLock([]))
    const controller = new AbortController()
    await expect(beginPluginInstall(dir, 'demo', options(async (args) => {
      if (args[0] === 'add') {
        rmSync(join(dir, 'pnpm-lock.yaml'))
        mkdirSync(join(dir, 'pnpm-lock.yaml'))
        return { exitCode: 1, stdout: '', stderr: 'failed' }
      }
      return ok
    }, controller.signal))).rejects.toBeInstanceOf(ProfilePluginError)
  })

  it('reports a declined install when the runner failure raced an abort', async () => {
    const dir = seededProfile()
    const controller = new AbortController()
    expect(await beginPluginInstall(dir, 'demo', options(async () => {
      controller.abort()
      throw new Error('aborted at pnpm')
    }, controller.signal))).toMatchObject({ kind: 'refused', refusal: { code: 'declined' } })
  })
})

describe('removePlugin', () => {
  it('refuses protected template bundles', async () => {
    const dir = seededProfile(['@shres-code/shres-code-base'])
    const runner = vi.fn<PnpmRunner>().mockResolvedValue(ok)
    expect(await removePlugin(dir, '@shres-code/shres-code-base', options(runner))).toEqual({ kind: 'refused', code: 'template-bundle' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('refuses a profile without a manifest', async () => {
    expect(await removePlugin(scratch(), 'demo', options(async () => ok))).toEqual({ kind: 'refused', code: 'not-installed' })
  })

  it('refuses a manifest without bundle membership and membership without the bundle', async () => {
    const bare = seededProfile()
    expect(await removePlugin(bare, 'demo', options(async () => ok))).toEqual({ kind: 'refused', code: 'not-installed' })
    const other = seededProfile(['other'])
    expect(await removePlugin(other, 'demo', options(async () => ok))).toEqual({ kind: 'refused', code: 'not-installed' })
    const noBundlesField = seededProfile()
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(noBundlesField, 'package.json'), JSON.stringify({ name: 'profile-fixture', shres: { profile: {} } }, null, 2) + '\n'))
    expect(await removePlugin(noBundlesField, 'demo', options(async () => ok))).toEqual({ kind: 'refused', code: 'not-installed' })
  })

  it('reports failed cleanup with stdout detail when stderr is empty', async () => {
    const dir = seededProfile(['demo'], { demo: '1.0.0' })
    const outcome = await removePlugin(dir, 'demo', options(async () => ({ exitCode: 1, stdout: 'cleanup out', stderr: '' })))
    expect(outcome).toEqual({ kind: 'removed', pnpm: 'failed', detail: 'cleanup out' })
    // The committed manifest is a zod-normalized rewrite: compare content, not bytes.
    const { readFile } = await import('node:fs/promises')
    const committed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      shres?: { profile?: { bundles?: string[] } }
      dependencies?: Record<string, string>
    }
    expect(committed.shres?.profile?.bundles).toEqual([])
    expect(committed.dependencies).toEqual({ demo: '1.0.0' })
  })

  it('reports a rejecting runner as failed cleanup and clears the journal', async () => {
    const dir = seededProfile(['demo'], { demo: '1.0.0' })
    const outcome = await removePlugin(dir, 'demo', options(async () => { throw new Error('remove exploded') }))
    expect(outcome).toEqual({ kind: 'removed', pnpm: 'failed', detail: 'Error: remove exploded' })
    await expect(import('node:fs/promises').then(fs => fs.readFile(join(dir, PLUGIN_JOURNAL)))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('pluginStates', () => {
  it('projects active, restart-required, and removed states against the boot snapshot', async () => {
    const dir = seededProfile(['demo', 'pending'])
    packageFiles(dir, 'demo')
    packageFiles(dir, 'gone')
    expect(await pluginStates(dir, ['demo', 'gone'])).toEqual([
      { name: 'demo', version: '1.0.0', state: 'active', removable: true },
      { name: 'pending', state: 'installed-restart-required', removable: true },
      { name: 'gone', version: '1.0.0', state: 'removed-restart-required', removable: false },
    ])
  })

  it('marks desired shipped template bundles not removable', async () => {
    const dir = seededProfile(['@shres-code/shres-code-base', '@shres-code/shres-code-web-app', 'demo'])
    packageFiles(dir, '@shres-code/shres-code-base')
    packageFiles(dir, 'demo')
    expect(await pluginStates(dir, ['@shres-code/shres-code-base', 'demo'])).toEqual([
      { name: '@shres-code/shres-code-base', version: '1.0.0', state: 'active', removable: false },
      { name: '@shres-code/shres-code-web-app', state: 'installed-restart-required', removable: false },
      { name: 'demo', version: '1.0.0', state: 'active', removable: true },
    ])
  })

  it('falls back to the boot snapshot when the manifest declares no bundles', async () => {
    const dir = scratch()
    write(join(dir, 'package.json'), '{"name":"profile-fixture"}\n')
    expect(await pluginStates(dir, ['solo'])).toEqual([{ name: 'solo', state: 'removed-restart-required', removable: false }])
  })
})
