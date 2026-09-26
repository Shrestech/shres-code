/**
 * File-only inspection for managed plugin installation: request parsing per
 * npm source kind and its expected refusals, metadata reads that never hide
 * I/O failures, lockfile diffing, bundle metadata checks that refuse linked or
 * special-file manifests before reading them, composition
 * validation, and retained local snapshots.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  dependencyNames, inspectAddedPackages, inspectBundle, managedManifestSchema, optionalText,
  parsePackageRequest, retainedSource, validateComposition,
  type PackageRequest,
} from '../src/profile-plugin-inspect.ts'
import type { InstallRefusal } from '../src/profile-plugin-types.ts'
import { BuildTreeRejection } from '../src/profile-plugin-build.ts'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) rmFixture(dirs.pop()!)
})

function rmFixture(dir: string): void {
  chmodSync(dir, 0o700)
  rmSync(dir, { recursive: true, force: true })
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shres-plugin-inspect-'))
  dirs.push(dir)
  return dir
}

function write(path: string, body: string): void {
  writeFileSync(path, body)
}

function pkg(dir: string, name: string, extra: Record<string, unknown> = {}): void {
  const folder = join(dir, name)
  mkdirSync(folder, { recursive: true })
  write(join(folder, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }))
}

const lock = (entries: string): string => 'lockfileVersion: \'9.0\'\n' + entries

/** Unwrap a parsed request, failing the test when the parser returned a refusal. */
function parsed(value: PackageRequest | InstallRefusal): PackageRequest {
  if ('code' in value) throw new Error('Expected a parsed request, got: ' + JSON.stringify(value))
  return value
}

describe('parsePackageRequest', () => {
  it('refuses link specs and pnpm options before parsing', () => {
    const refusal = parsePackageRequest('link:../source', '/tmp')
    expect(refusal).toMatchObject({ code: 'link-spec' })
    if ('code' in refusal) expect(refusal.detail).toContain('copy')
    expect(parsePackageRequest('-config.ignore-scripts=false', '/tmp')).toMatchObject({ code: 'invalid-spec' })
  })

  it('rejects specs npm-package-arg cannot parse', () => {
    expect(parsePackageRequest('a b', '/tmp')).toMatchObject({ code: 'invalid-spec' })
  })

  it('rejects manifest dependency keys npm-package-arg cannot parse', () => {
    expect(() => managedManifestSchema.parse({ dependencies: { 'a b': '1.0.0' } })).toThrow()
    expect(managedManifestSchema.parse({ dependencies: { demo: '1.0.0' } })).toMatchObject({ dependencies: { demo: '1.0.0' } })
  })

  it('maps every npm source kind to its normalized request', () => {
    const cwd = scratch()
    expect(parsePackageRequest('./local-plugin', cwd)).toMatchObject({ source: 'path', directory: join(cwd, 'local-plugin'), target: 'file:' + join(cwd, 'local-plugin') })
    expect(parsePackageRequest('file:./plugin-1.0.0.tgz', cwd)).toMatchObject({ source: 'tarball', target: 'file:' + join(cwd, 'plugin-1.0.0.tgz') })
    // npm-package-arg leaves the name undefined for remote and git specs.
    const remote = parsed(parsePackageRequest('https://example.com/plugin-1.0.0.tgz', cwd))
    expect(remote).toMatchObject({ source: 'tarball', target: 'https://example.com/plugin-1.0.0.tgz' })
    expect(remote.name).toBeUndefined()
    const git = parsed(parsePackageRequest('git+https://example.com/repo.git', cwd))
    expect(git).toMatchObject({ source: 'git', target: 'git+https://example.com/repo.git' })
    expect(git.name).toBeUndefined()
    for (const spec of ['npm:left-pad@1', 'left-pad@latest', 'left-pad@1.2.3', 'left-pad@^1']) {
      expect(parsePackageRequest(spec, cwd)).toMatchObject({ source: 'registry', target: spec })
    }
    expect(parsePackageRequest('left-pad@^1', cwd)).toMatchObject({ name: 'left-pad' })
  })
})

describe('optionalText', () => {
  it('returns null for a missing file and exact bytes for a present one', async () => {
    const dir = scratch()
    expect(await optionalText(join(dir, 'absent.json'))).toBeNull()
    write(join(dir, 'present.json'), '{"a":1}\n')
    expect(await optionalText(join(dir, 'present.json'))).toBe('{"a":1}\n')
  })

  it('does not hide non-missing read failures', async () => {
    const dir = scratch()
    write(join(dir, 'blocker'), 'x')
    await expect(optionalText(join(dir, 'blocker', 'child.json'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('dependencyNames', () => {
  it('unions every pnpm-owned dependency section without duplicates', () => {
    const manifest = managedManifestSchema.parse({
      dependencies: { demo: '1.0.0', shared: '1.0.0' },
      devDependencies: { devonly: '1.0.0', shared: '1.0.0' },
      optionalDependencies: { optional: '1.0.0' },
    })
    expect(dependencyNames(manifest)).toEqual(['demo', 'shared', 'devonly', 'optional'])
  })
})

describe('inspectAddedPackages', () => {
  it('diffs added lock keys across packages and snapshots and merges their fields', () => {
    const before = lock('packages:\n  kept@1.0.0: {}\n')
    const after = lock('packages:\n  kept@1.0.0: {}\n  demo@1.0.0: { requiresBuild: true }\nsnapshots:\n  demo@1.0.0: { dependencies: { demo: 1.0.0 } }\n')
    expect(inspectAddedPackages(before, after)).toEqual({ added: ['demo@1.0.0'], requiresBuild: ['demo@1.0.0'] })
  })

  it('reads lockfiles without a packages section and treats an absent lockfile as empty', () => {
    expect(inspectAddedPackages(null, lock('snapshots:\n  demo@1.0.0: {}\n'))).toEqual({ added: ['demo@1.0.0'], requiresBuild: [] })
    expect(inspectAddedPackages(null, null)).toEqual({ added: [], requiresBuild: [] })
  })
})

describe('inspectBundle', () => {
  it('reports version and client half for a shres bundle', async () => {
    const dir = scratch()
    pkg(join(dir, 'node_modules'), 'demo', { shres: { bundle: { patch: 'cordis.patch.yml' }, client: {} } })
    expect(await inspectBundle(dir, 'demo')).toEqual({ version: '1.0.0', clientHalf: true })
    pkg(join(dir, 'node_modules'), 'plain-bundle', { shres: { bundle: { patch: 'cordis.patch.yml' } } })
    expect(await inspectBundle(dir, 'plain-bundle')).toEqual({ version: '1.0.0', clientHalf: false })
  })

  it('refuses foreign dsh bundles and packages without a bundle declaration', async () => {
    const dir = scratch()
    pkg(join(dir, 'node_modules'), 'foreign', { dsh: { bundle: {} } })
    const foreign = await inspectBundle(dir, 'foreign')
    expect(foreign).toMatchObject({ code: 'foreign-dsh' })
    if ('code' in foreign) expect(foreign.detail).toContain('DeepSeek')
    pkg(join(dir, 'node_modules'), 'library', { bin: { x: './x.js' } })
    expect(await inspectBundle(dir, 'library')).toEqual({ code: 'not-a-bundle' })
  })
})

describe('inspectBundle manifest guard', () => {
  it('refuses a missing manifest as not a bundle', async () => {
    const dir = scratch()
    mkdirSync(join(dir, 'node_modules', 'bare'), { recursive: true })
    expect(await inspectBundle(dir, 'bare')).toMatchObject({ code: 'not-a-bundle' })
  })

  it('rejects a linked manifest without following it', async () => {
    const dir = scratch()
    mkdirSync(join(dir, 'node_modules', 'linked'), { recursive: true })
    writeFileSync(join(dir, 'outside.json'), JSON.stringify({ name: 'linked', version: '1.0.0', shres: { bundle: { patch: 'p.yml' } } }))
    symlinkSync(join(dir, 'outside.json'), join(dir, 'node_modules', 'linked', 'package.json'))
    await expect(inspectBundle(dir, 'linked')).rejects.toBeInstanceOf(BuildTreeRejection)
  })

  it.runIf(process.platform !== 'win32')('rejects a FIFO manifest before opening it', async () => {
    const dir = scratch()
    mkdirSync(join(dir, 'node_modules', 'piped'), { recursive: true })
    execFileSync('mkfifo', [join(dir, 'node_modules', 'piped', 'package.json')])
    await expect(inspectBundle(dir, 'piped')).rejects.toBeInstanceOf(BuildTreeRejection)
  }, 5_000)
})

describe('validateComposition', () => {
  it('accepts a real patch composition and rejects a broken one without evaluating code', async () => {
    const dir = scratch()
    pkg(join(dir, 'node_modules'), 'demo', { shres: { bundle: { patch: 'cordis.patch.yml' } } })
    write(join(dir, 'node_modules', 'demo', 'cordis.patch.yml'), '[]\n')
    expect(() => { validateComposition(dir, ['demo']) }).not.toThrow()
    write(join(dir, 'node_modules', 'demo', 'cordis.patch.yml'), '[broken\n')
    expect(() => { validateComposition(dir, ['demo']) }).toThrow()
  })
})

describe('retainedSource', () => {
  const manifestWith = (section: string, spec: string): unknown => ({ [section]: { '00000000-0000-4000-8000-000000000000': spec } })

  it('returns the owned snapshot path for a file dependency below the profile sources', async () => {
    const dir = scratch()
    const sources = join(dir, '.shres-plugin-sources')
    mkdirSync(sources, { recursive: true })
    const manifest = managedManifestSchema.parse(manifestWith('dependencies', 'file:' + join(sources, '00000000-0000-4000-8000-000000000000')))
    expect(await retainedSource(dir, manifest, '00000000-0000-4000-8000-000000000000')).toBe(join(dir, '.shres-plugin-sources', '00000000-0000-4000-8000-000000000000'))
  })

  it('finds snapshots declared as dev or optional dependencies', async () => {
    const dir = scratch()
    const sources = join(dir, '.shres-plugin-sources')
    mkdirSync(sources, { recursive: true })
    const id = '00000000-0000-4000-8000-000000000000'
    for (const section of ['devDependencies', 'optionalDependencies'] as const) {
      const manifest = managedManifestSchema.parse(manifestWith(section, 'file:' + join(sources, id)))
      expect(await retainedSource(dir, manifest, id)).toBe(join(sources, id))
    }
  })

  it('ignores non-file specs, tarballs, non-uuid directories, and external uuid directories', async () => {
    const dir = scratch()
    const registry = managedManifestSchema.parse({ dependencies: { demo: '^1.0.0' } })
    expect(await retainedSource(dir, registry, 'demo')).toBeUndefined()
    const outside = scratch()
    const externalId = '11111111-1111-4111-8111-111111111111'
    mkdirSync(join(outside, externalId), { recursive: true })
    const tarball = managedManifestSchema.parse({ dependencies: { demo: 'file:./demo-1.0.0.tgz' } })
    expect(await retainedSource(dir, tarball, 'demo')).toBeUndefined()
    const plain = managedManifestSchema.parse({ dependencies: { demo: 'file:./demo' } })
    expect(await retainedSource(dir, plain, 'demo')).toBeUndefined()
    const external = managedManifestSchema.parse({ dependencies: { [externalId]: 'file:' + join(outside, externalId) } })
    expect(await retainedSource(dir, external, externalId)).toBeUndefined()
  })

  it('treats an absent snapshot parent as no snapshot', async () => {
    const dir = scratch()
    const id = '22222222-2222-4222-8222-222222222222'
    const absent = managedManifestSchema.parse({ dependencies: { [id]: 'file:' + join(dir, 'no-such-parent', id) } })
    expect(await retainedSource(dir, absent, id)).toBeUndefined()
  })

  it.skipIf(process.getuid?.() === 0)('surfaces permission failures on the snapshot parent', async () => {
    const dir = scratch()
    const sources = join(dir, '.shres-plugin-sources')
    mkdirSync(sources, { recursive: true })
    const id = '33333333-3333-4333-8333-333333333333'
    mkdirSync(join(sources, id), { recursive: true })
    // Without the search bit on the profile dir, resolving the snapshot path fails.
    chmodSync(dir, 0o644)
    const manifest = managedManifestSchema.parse({ dependencies: { [id]: 'file:' + join(sources, id) } })
    await expect(retainedSource(dir, manifest, id)).rejects.toMatchObject({ code: 'EACCES' })
  })
})
