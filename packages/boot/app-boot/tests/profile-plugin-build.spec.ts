/**
 * Build-tree digests: which build-declaring package trees a managed install
 * added or changed, across hoisted, nested, scoped, and `.pnpm` layouts,
 * without following links, reading special files, or importing code.
 */
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Test-only fault injection for the fs calls whose failure races cannot be staged on disk. */
const faults = vi.hoisted(() => ({
  open: undefined as NodeJS.ErrnoException | 'fifo' | undefined,
  lstatGyp: undefined as NodeJS.ErrnoException | undefined,
  lstatManifest: undefined as NodeJS.ErrnoException | undefined,
  realpath: undefined as NodeJS.ErrnoException | undefined,
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fault = faults.open
      if (fault === undefined) return actual.open(...args)
      if (fault === 'fifo') {
        const handle = await actual.open(...args)
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'stat') return async () => ({ isFile: () => false })
            const value: unknown = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) as unknown : value
          },
        })
      }
      throw fault
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (faults.lstatGyp !== undefined && String(args[0]).endsWith('binding.gyp')) throw faults.lstatGyp
      if (faults.lstatManifest !== undefined && String(args[0]).endsWith('package.json')) throw faults.lstatManifest
      return actual.lstat(...args)
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (faults.realpath !== undefined) throw faults.realpath
      return actual.realpath(...args)
    },
  }
})

const { BuildTreeRejection, changedBuildTrees, collectBuildTrees } = await import('../src/profile-plugin-build.ts')

const temps: string[] = []
afterEach(async () => {
  faults.open = undefined
  faults.lstatGyp = undefined
  faults.lstatManifest = undefined
  faults.realpath = undefined
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function profile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shres-build-trees-'))
  temps.push(dir)
  return dir
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

/** Write one package directory with an optional lifecycle script and extra files. */
async function pkg(dir: string, name: string, version: string, options: {
  script?: string
  gyp?: boolean
  files?: Record<string, string>
} = {}): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name, version, ...options.script === undefined ? {} : { scripts: { [options.script]: 'node build.js' } },
  }))
  await writeFile(join(dir, 'build.js'), 'build\n')
  if (options.gyp === true) await writeFile(join(dir, 'binding.gyp'), '{}')
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), content)
  }
}

const live = (): AbortSignal => new AbortController().signal
const ids = (trees: Awaited<ReturnType<typeof collectBuildTrees>>): string[] => [...trees.values()].map(tree => tree.id).sort()

describe('collectBuildTrees', () => {
  it('finds every build-declaring tree once across hoisted, nested, scoped, and .pnpm layouts', async () => {
    const dir = await profile()
    const modules = join(dir, 'node_modules')
    for (const [index, script] of ['preinstall', 'install', 'postinstall', 'prepare'].entries()) {
      await pkg(join(modules, 'script-' + String(index)), 'script-' + String(index), '1.0.0', { script })
    }
    await pkg(join(modules, 'native'), 'native', '1.0.0', { gyp: true })
    await pkg(join(modules, 'plain'), 'plain', '1.0.0', { script: 'test' })
    await pkg(join(modules, 'plain', 'node_modules', 'nested'), 'nested', '2.0.0', { script: 'install' })
    await pkg(join(modules, '@scope', 'scoped'), '@scope/scoped', '1.0.0', { script: 'install' })
    await pkg(join(modules, '.pnpm', 'store@1.0.0', 'node_modules', 'store'), 'store', '1.0.0', { script: 'install' })
    await pkg(join(modules, '.pnpm', 'node_modules', 'hoisted-store'), 'hoisted-store', '1.0.0', { script: 'install' })
    await writeFile(join(modules, '.pnpm', 'lock.yaml'), 'not a bucket')
    await mkdir(join(modules, 'no-manifest', 'node_modules'), { recursive: true })
    await pkg(join(modules, 'no-manifest', 'node_modules', 'deep'), 'deep', '1.0.0', { script: 'install' })
    await writeFile(join(modules, 'stray-file'), 'not a package')
    await pkg(join(modules, '.hidden'), 'hidden', '1.0.0', { script: 'install' })
    // Two links to the same real tree are one tree; a dangling link is none.
    await symlink(join(modules, 'native'), join(modules, 'native-alias'))
    await symlink(join(dir, 'missing'), join(modules, 'dangling'))

    expect(ids(await collectBuildTrees(dir, live()))).toEqual([
      '@scope/scoped@1.0.0', 'deep@1.0.0', 'hoisted-store@1.0.0', 'native@1.0.0', 'nested@2.0.0',
      'script-0@1.0.0', 'script-1@1.0.0', 'script-2@1.0.0', 'script-3@1.0.0', 'store@1.0.0',
    ])
  })

  it('returns nothing for a profile without node_modules', async () => {
    expect((await collectBuildTrees(await profile(), live())).size).toBe(0)
  })

  it.runIf(process.platform !== 'win32')('rejects a FIFO manifest before opening it', async () => {
    const dir = await profile()
    const tree = join(dir, 'node_modules', 'hostile')
    await mkdir(tree, { recursive: true })
    execFileSync('mkfifo', [join(tree, 'package.json')])
    await expect(collectBuildTrees(dir, live())).rejects.toThrow(/package\.json is a symbolic link or not a regular file/)
  }, 5_000)

  it.each([
    ['an outside regular file', true],
    ['nothing (dangling)', false],
  ])('rejects a manifest linked to %s instead of following it', async (_label, targetExists) => {
    const dir = await profile()
    const tree = join(dir, 'node_modules', 'hostile')
    await mkdir(tree, { recursive: true })
    const outside = join(dir, 'outside.json')
    if (targetExists) await writeFile(outside, JSON.stringify({ name: 'hostile', version: '9.9.9', scripts: { install: 'x' } }))
    await symlink(outside, join(tree, 'package.json'))
    await expect(collectBuildTrees(dir, live())).rejects.toBeInstanceOf(BuildTreeRejection)
  })

  it('rejects an abort before reading', async () => {
    const dir = await profile()
    await pkg(join(dir, 'node_modules', 'native'), 'native', '1.0.0', { gyp: true })
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(collectBuildTrees(dir, controller.signal)).rejects.toThrow('stopped')
  })

  it.runIf(process.platform !== 'win32')('refuses a special file inside a build-declaring tree without reading it', async () => {
    const dir = await profile()
    await pkg(join(dir, 'node_modules', 'native'), 'native', '1.0.0', { gyp: true })
    execFileSync('mkfifo', [join(dir, 'node_modules', 'native', 'pipe')])
    await expect(collectBuildTrees(dir, live())).rejects.toBeInstanceOf(BuildTreeRejection)
  })

  it('refuses a file that became a link or a special file after the listing', async () => {
    const dir = await profile()
    await pkg(join(dir, 'node_modules', 'native'), 'native', '1.0.0', { gyp: true })
    faults.open = errno('ELOOP')
    await expect(collectBuildTrees(dir, live())).rejects.toThrow(/changed to a symbolic link/)
    faults.open = 'fifo'
    await expect(collectBuildTrees(dir, live())).rejects.toThrow(/changed to a special file/)
  })

  it('propagates filesystem failures that are not absence', async () => {
    const dir = await profile()
    await pkg(join(dir, 'node_modules', 'native'), 'native', '1.0.0', { gyp: true })
    faults.open = errno('EMFILE')
    await expect(collectBuildTrees(dir, live())).rejects.toMatchObject({ code: 'EMFILE' })
    faults.open = undefined
    await pkg(join(dir, 'node_modules', 'plain'), 'plain', '1.0.0')
    faults.lstatGyp = errno('EIO')
    await expect(collectBuildTrees(dir, live())).rejects.toMatchObject({ code: 'EIO' })
    faults.lstatGyp = undefined
    faults.lstatManifest = errno('EIO')
    await expect(collectBuildTrees(dir, live())).rejects.toMatchObject({ code: 'EIO' })
    faults.lstatManifest = undefined
    faults.realpath = errno('EACCES')
    await expect(collectBuildTrees(dir, live())).rejects.toMatchObject({ code: 'EACCES' })
    faults.realpath = undefined
    const fileModules = await profile()
    await writeFile(join(fileModules, 'node_modules'), 'not a directory')
    await expect(collectBuildTrees(fileModules, live())).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('propagates an unreadable package manifest', async () => {
    const dir = await profile()
    await pkg(join(dir, 'node_modules', 'locked'), 'locked', '1.0.0', { script: 'install' })
    await chmod(join(dir, 'node_modules', 'locked', 'package.json'), 0o000)
    try {
      await expect(collectBuildTrees(dir, live())).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(join(dir, 'node_modules', 'locked', 'package.json'), 0o600)
    }
  })
})

describe('changedBuildTrees', () => {
  it('ignores an unchanged scripted tree while a clean new version installs beside it', async () => {
    const dir = await profile()
    await pkg(join(dir, 'node_modules', 'host', 'node_modules', 'foo'), 'foo', '1.0.0', { script: 'install' })
    const before = await collectBuildTrees(dir, live())
    await pkg(join(dir, 'node_modules', 'foo'), 'foo', '2.0.0')
    expect(changedBuildTrees(before, await collectBuildTrees(dir, live()))).toEqual([])
  })

  it('reports a new build-declaring tree', async () => {
    const dir = await profile()
    const before = await collectBuildTrees(dir, live())
    await pkg(join(dir, 'node_modules', 'foo'), 'foo', '2.0.0', { gyp: true })
    expect(changedBuildTrees(before, await collectBuildTrees(dir, live()))).toEqual(['foo@2.0.0'])
  })

  it('reports a changed build input behind a byte-identical manifest', async () => {
    const dir = await profile()
    const tree = join(dir, 'node_modules', 'foo')
    await pkg(tree, 'foo', '1.0.0', { script: 'install', files: { 'lib/prebuilt.node': 'artifact' } })
    const before = await collectBuildTrees(dir, live())
    await writeFile(join(tree, 'build.js'), 'different build\n')
    expect(changedBuildTrees(before, await collectBuildTrees(dir, live()))).toEqual(['foo@1.0.0'])
  })

  it('reports a removed build artifact', async () => {
    const dir = await profile()
    const tree = join(dir, 'node_modules', 'foo')
    await pkg(tree, 'foo', '1.0.0', { script: 'install', files: { 'lib/prebuilt.node': 'artifact' } })
    const before = await collectBuildTrees(dir, live())
    await rm(join(tree, 'lib', 'prebuilt.node'))
    expect(changedBuildTrees(before, await collectBuildTrees(dir, live()))).toEqual(['foo@1.0.0'])
  })

  it('hashes inner links by target without following them and excludes only the root node_modules', async () => {
    const dir = await profile()
    const tree = join(dir, 'node_modules', 'foo')
    const outside = join(dir, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'data'), 'one')
    await pkg(tree, 'foo', '1.0.0', { script: 'install', files: { 'lib/node_modules/vendored.js': 'v1' } })
    await symlink(join(outside, 'data'), join(tree, 'link'))
    const before = await collectBuildTrees(dir, live())

    // Changing what the link points at, or the tree's own root node_modules,
    // does not change the tree's digest.
    await writeFile(join(outside, 'data'), 'two')
    await pkg(join(tree, 'node_modules', 'child'), 'child', '1.0.0')
    expect(changedBuildTrees(before, await collectBuildTrees(dir, live()))).toEqual([])

    // A nested node_modules below the root is part of the tree.
    await writeFile(join(tree, 'lib', 'node_modules', 'vendored.js'), 'v2')
    const nested = await collectBuildTrees(dir, live())
    expect(changedBuildTrees(before, nested)).toEqual(['foo@1.0.0'])

    // Retargeting the link itself changes the digest.
    await rm(join(tree, 'link'))
    await symlink(join(outside, 'elsewhere'), join(tree, 'link'))
    expect(changedBuildTrees(nested, await collectBuildTrees(dir, live()))).toEqual(['foo@1.0.0'])
  })

  it('over-refuses an unchanged tree that moved to a new path', async () => {
    const dir = await profile()
    await pkg(join(dir, 'node_modules', 'host', 'node_modules', 'foo'), 'foo', '1.0.0', { script: 'install' })
    const before = await collectBuildTrees(dir, live())
    await rm(join(dir, 'node_modules', 'host'), { recursive: true })
    await pkg(join(dir, 'node_modules', 'foo'), 'foo', '1.0.0', { script: 'install' })
    expect(changedBuildTrees(before, await collectBuildTrees(dir, live()))).toEqual(['foo@1.0.0'])
  })
})
