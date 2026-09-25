/**
 * Local plugin staging: the copy is independent of the source, skips VCS and
 * installed dependencies, refuses links and special files, and admits only
 * in-tree local dependencies alongside registry, git, and remote specs.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stagePluginSource } from '../src/profile-plugin-source.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shres-plugin-source-'))
  temps.push(dir)
  return dir
}

async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
}

/** A plugin source directory plus a fresh staging path outside it. */
async function layout(manifest: Record<string, unknown> = {}): Promise<{ base: string; source: string; staged: string }> {
  const base = await temp()
  const source = join(base, 'plugin')
  await writeManifest(source, { name: 'plugin-hello', version: '1.0.0', ...manifest })
  await writeFile(join(source, 'index.js'), 'export const version = 1\n')
  return { base, source, staged: join(base, 'staging', 'uuid-1') }
}

const live = (): AbortSignal => new AbortController().signal

async function stage(source: string, staged: string, signal = live()): ReturnType<typeof stagePluginSource> {
  await mkdir(join(staged, '..'), { recursive: true })
  return stagePluginSource(source, staged, signal)
}

function refusalDetail(
  outcome: Awaited<ReturnType<typeof stagePluginSource>>, code: 'link-spec' | 'invalid-spec' = 'link-spec',
): string {
  if (outcome.kind !== 'refused') throw new Error(`expected a refusal, got ${outcome.kind}`)
  expect(outcome.refusal.code).toBe(code)
  return outcome.refusal.detail
}

describe('stagePluginSource', () => {
  it('copies the source so later edits to the original do not reach the staged copy', async () => {
    const { source, staged } = await layout()
    expect(await stage(source, staged)).toEqual({ kind: 'staged', name: 'plugin-hello', version: '1.0.0' })
    await writeFile(join(source, 'index.js'), 'export const version = 2\n')
    await writeFile(join(source, 'added.js'), 'late\n')
    expect(await readFile(join(staged, 'index.js'), 'utf8')).toBe('export const version = 1\n')
    expect(existsSync(join(staged, 'added.js'))).toBe(false)
  })

  it('skips .git and node_modules at any depth', async () => {
    const { source, staged } = await layout()
    await mkdir(join(source, '.git'), { recursive: true })
    await writeFile(join(source, '.git', 'HEAD'), 'ref\n')
    await mkdir(join(source, 'node_modules', 'dep'), { recursive: true })
    await mkdir(join(source, 'lib', 'node_modules', 'nested'), { recursive: true })
    await mkdir(join(source, 'lib', '.git'), { recursive: true })
    await writeFile(join(source, 'lib', 'util.js'), 'util\n')
    expect(await stage(source, staged)).toMatchObject({ kind: 'staged' })
    expect((await readdir(staged)).sort()).toEqual(['index.js', 'lib', 'package.json'])
    expect(await readdir(join(staged, 'lib'))).toEqual(['util.js'])
  })

  it('resolves a link to the source directory itself before copying', async () => {
    const { base, source, staged } = await layout()
    const alias = join(base, 'alias')
    await symlink(source, alias)
    expect(await stage(alias, staged)).toMatchObject({ kind: 'staged', name: 'plugin-hello' })
  })

  it.each([
    ['a file link', async (source: string, outside: string) => { await symlink(join(outside, 'secret'), join(source, 'leak.txt')) }],
    ['a directory link', async (source: string, outside: string) => { await symlink(outside, join(source, 'linked')) }],
    ['a nested link', async (source: string, outside: string) => {
      await mkdir(join(source, 'lib'))
      await symlink(join(outside, 'secret'), join(source, 'lib', 'leak.txt'))
    }],
  ])('refuses %s anywhere in the source', async (_label, plant) => {
    const { base, source, staged } = await layout()
    const outside = join(base, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret'), 'secret\n')
    await plant(source, outside)
    expect(refusalDetail(await stage(source, staged))).toMatch(/symbolic link/)
  })

  it.runIf(process.platform !== 'win32')('refuses a FIFO without blocking on it', async () => {
    const { source, staged } = await layout()
    execFileSync('mkfifo', [join(source, 'pipe')])
    expect(refusalDetail(await stage(source, staged))).toMatch(/not a regular file or directory/)
  })

  it('refuses a source that is not a directory', async () => {
    const { source, staged } = await layout()
    expect(refusalDetail(await stage(join(source, 'index.js'), staged))).toMatch(/not a directory/)
  })

  it('refuses a staging path inside the source, which would copy the source into itself', async () => {
    const { source } = await layout()
    expect(refusalDetail(await stage(source, join(source, 'staging', 'uuid-1')))).toMatch(/inside the plugin directory/)
    expect(refusalDetail(await stagePluginSource(source, source, live()))).toMatch(/inside the plugin directory/)
  })

  it('requires a fresh staging path', async () => {
    const { source, staged } = await layout()
    await mkdir(staged, { recursive: true })
    await expect(stagePluginSource(source, staged, live())).rejects.toThrow(/already exists/)
  })

  it.each([
    ['a missing manifest', undefined],
    ['invalid JSON', '{'],
    ['a missing version', JSON.stringify({ name: 'plugin-hello' })],
    ['an invalid name', JSON.stringify({ name: 'Bad Name', version: '1.0.0' })],
    ['a range version', JSON.stringify({ name: 'plugin-hello', version: '^1.0.0' })],
    ['a scoped-name mismatch', JSON.stringify({ name: '@scope', version: '1.0.0' })],
  ])('refuses a copied manifest with %s as an invalid spec', async (_label, text) => {
    const { source, staged } = await layout()
    if (text === undefined) await rm(join(source, 'package.json'))
    else await writeFile(join(source, 'package.json'), text)
    expect(refusalDetail(await stage(source, staged), 'invalid-spec')).toMatch(/package\.json/)
  })

  it('allows registry, alias, git, remote, and in-tree local dependencies, and walks in-tree directories', async () => {
    const { source, staged } = await layout({
      dependencies: {
        registry: '^1.0.0',
        aliased: 'npm:real@1.0.0',
        git: 'github:owner/repo',
        remote: 'https://example.com/pkg.tgz',
        vendored: 'file:./vendor/a',
        bare: './vendor/b',
        tarball: 'file:./vendor/c.tgz',
      },
      optionalDependencies: { optional: 'file:./vendor/b' },
    })
    await writeManifest(join(source, 'vendor', 'a'), { name: 'a', version: '1.0.0', dependencies: { b: 'file:../b', self: 'file:.' } })
    await writeManifest(join(source, 'vendor', 'b'), { name: 'b', version: '1.0.0', dependencies: { a: 'file:../a' } })
    await writeFile(join(source, 'vendor', 'c.tgz'), 'tarball')
    expect(await stage(source, staged)).toMatchObject({ kind: 'staged', name: 'plugin-hello' })
  })

  it('ignores devDependencies and peerDependencies, which a dependency install never reads', async () => {
    const { source, staged } = await layout({
      devDependencies: { dev: 'link:../outside' },
      peerDependencies: { peer: 'workspace:*' },
    })
    expect(await stage(source, staged)).toMatchObject({ kind: 'staged' })
  })

  it.each([
    ['link:', 'link:./vendor/a'],
    ['portal:', 'portal:./vendor/a'],
    ['workspace:', 'workspace:*'],
  ])('refuses a %s dependency', async (_label, spec) => {
    const { source, staged } = await layout({ dependencies: { live: spec } })
    expect(refusalDetail(await stage(source, staged))).toMatch(/live path/)
  })

  it.each([
    ['a file: directory', 'file:../outside'],
    ['a bare relative directory', '../outside'],
    ['an absolute directory', '/'],
    ['a tarball', 'file:../outside.tgz'],
  ])('refuses %s outside the plugin directory', async (_label, spec) => {
    const { source, staged } = await layout({ dependencies: { external: spec } })
    expect(refusalDetail(await stage(source, staged))).toMatch(/outside the plugin directory/)
  })

  it('refuses an external dependency declared by a nested in-tree dependency', async () => {
    const { source, staged } = await layout({ optionalDependencies: { nested: 'file:./vendor/a' } })
    await writeManifest(join(source, 'vendor', 'a'), { name: 'a', version: '1.0.0', dependencies: { escape: 'file:../../../outside' } })
    expect(refusalDetail(await stage(source, staged))).toMatch(/vendor\/a\/package\.json dependencies\.escape/)
  })

  it('refuses a dependency spec npm cannot parse', async () => {
    const { source, staged } = await layout({ dependencies: { odd: 'catalog:default' } })
    expect(refusalDetail(await stage(source, staged))).toMatch(/unsupported spec/)
  })

  it('refuses an in-tree dependency directory without a manifest', async () => {
    const { source, staged } = await layout({ dependencies: { empty: 'file:./vendor/empty' } })
    await mkdir(join(source, 'vendor', 'empty'), { recursive: true })
    expect(refusalDetail(await stage(source, staged), 'invalid-spec')).toMatch(/vendor\/empty\/package\.json is missing/)
  })

  it('rejects a pre-aborted signal before touching the filesystem', async () => {
    const { source, staged } = await layout()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(stage(source, staged, controller.signal)).rejects.toThrow('cancelled')
    expect(existsSync(staged)).toBe(false)
  })

  it('rejects an abort that arrives during the copy and leaves the partial copy to the caller', async () => {
    const { source, staged } = await layout()
    await mkdir(join(source, 'lib'))
    for (let index = 0; index < 5; index += 1) await writeFile(join(source, 'lib', `f${index}.js`), 'x\n')
    // A signal that aborts on its fourth check lands the abort inside the
    // copy filter, deterministically mid-copy.
    const controller = new AbortController()
    let checks = 0
    const signal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === 'throwIfAborted') {
          return () => {
            checks += 1
            if (checks === 4) controller.abort(new Error('cancelled mid-copy'))
            target.throwIfAborted()
          }
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) as unknown : value
      },
    })
    await expect(stage(source, staged, signal)).rejects.toThrow('cancelled mid-copy')
    expect(checks).toBe(4)
    // The partial copy is the caller's to remove.
    expect(existsSync(staged)).toBe(true)
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'propagates a filesystem failure that is not a refusal',
    async () => {
      const { base, source } = await layout()
      const locked = join(base, 'locked')
      await mkdir(locked)
      await chmod(locked, 0o000)
      try {
        await expect(stagePluginSource(source, join(locked, 'uuid-1'), live())).rejects.toMatchObject({ code: 'EACCES' })
      } finally {
        await chmod(locked, 0o700)
      }
      const unreadable = join(source, 'secret.js')
      await writeFile(unreadable, 'secret\n')
      await chmod(unreadable, 0o000)
      try {
        await expect(stage(source, join(base, 'staging', 'uuid-2'))).rejects.toMatchObject({ code: 'EACCES' })
      } finally {
        await chmod(unreadable, 0o600)
      }
    },
  )
})
