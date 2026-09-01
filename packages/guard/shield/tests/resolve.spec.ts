/**
 * Resolve-leg regression tests for the paid Shield payload: the published
 * specifier is pinned (a revert to the old `@shres-shield/plugin` fails), and
 * the profile-installed leg resolves from a fixture profile `node_modules`
 * when env and sibling are absent. The sibling checkout exists on the
 * developer machine, so every profile-leg assertion injects a throwaway
 * `repoRoot` to neutralize it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PAYLOAD_IMPORT_BUST_PARAM, PAYLOAD_SPECIFIER, fileImportHref, propagateShieldImportBust,
  resolveProfileSpecifier, resolveShieldEngine, repoRootFromSeat, siblingPluginPath,
} from '@shres-code/shres-code-shield'

const OLD_WRONG_SPECIFIER = '@shres-shield/plugin'
const fixtureUrl = fileURLToPath(new URL('./fixtures/fake-shield-plugin.ts', import.meta.url))

/** A fake payload module that also exposes a `stats.snapshot` reader. */
const FULL_MODULE = `
export async function apply() { return { dispose: async () => {} } }
export const stats = { snapshot: (cwd) => ({ cwd: cwd ?? '/fake', screened: 1 }) }
`

/** A fake payload module exposing only `apply`. */
const APPLY_ONLY_MODULE = `
export async function apply() { return { dispose: async () => {} } }
`

/** A fake payload module exposing a top-level `snapshot` (no `stats`). */
const TOP_LEVEL_SNAPSHOT_MODULE = `
export async function apply() { return { dispose: async () => {} } }
export function snapshot(cwd) { return { cwd: cwd ?? '/top', screened: 2 } }
`

/** A fake payload module whose `apply` is not a function (a malformed payload). */
const INVALID_APPLY_MODULE = `
export const apply = 'not-a-function'
`

let savedModule: string | undefined

beforeEach(() => {
  savedModule = process.env.SHRES_SHIELD_MODULE
  delete process.env.SHRES_SHIELD_MODULE
})

afterEach(() => {
  if (savedModule === undefined) delete process.env.SHRES_SHIELD_MODULE
  else process.env.SHRES_SHIELD_MODULE = savedModule
})

/** A scratch repo whose `../shres-shield` sibling cannot collide with tmpdir leftovers. */
function neutralSiblingRoot(): string {
  const parent = resolve(tmpdir(), `shres-shield-neutral-${Math.random().toString(36).slice(2)}`)
  const root = join(parent, 'repo')
  mkdirSync(root, { recursive: true })
  return root
}

/** Build a fake profile directory carrying the payload under its own node_modules. */
function makeProfileDir(moduleSource: string = FULL_MODULE): { dir: string; cleanup(): void } {
  const dir = resolve(tmpdir(), `shres-shield-profile-${Math.random().toString(36).slice(2)}`)
  const pkgDir = join(dir, 'node_modules', '@shrestech', 'shres-shield-plugin')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"profile-test","private":true,"dependencies":{}}\n')
  writeFileSync(
    join(pkgDir, 'package.json'),
    '{"name":"@shrestech/shres-shield-plugin","version":"0.2.0","type":"module","main":"index.js"}\n',
  )
  writeFileSync(join(pkgDir, 'index.js'), moduleSource)
  return {
    dir,
    cleanup: () =>{  rmSync(dir, { recursive: true, force: true }) },
  }
}

describe('shield payload resolve', () => {
  it('pins the published npm specifier and rejects the old name', () => {
    expect(PAYLOAD_SPECIFIER).toBe('@shrestech/shres-shield-plugin')
    expect(PAYLOAD_SPECIFIER).not.toBe(OLD_WRONG_SPECIFIER)
  })

  it('resolves the sibling path from the real seat and an injected root', () => {
    expect(siblingPluginPath('/repo')).toBe(resolve('/repo', '../shres-shield/packages/plugin/dist/index.js'))
    expect(siblingPluginPath(repoRootFromSeat())).toBe(
      resolve(repoRootFromSeat(), '../shres-shield/packages/plugin/dist/index.js'),
    )
  })

  it('resolves the payload specifier from a profile node_modules', () => {
    const profile = makeProfileDir()
    try {
      const resolved = resolveProfileSpecifier(profile.dir)
      expect(resolved).toBeTruthy()
      expect(existsSync(resolved as string)).toBe(true)
    } finally {
      profile.cleanup()
    }
  })

  it('returns undefined when a profile does not carry the payload', () => {
    const profile = makeProfileDir()
    try {
      rmSync(join(profile.dir, 'node_modules', '@shrestech'), { recursive: true, force: true })
      expect(resolveProfileSpecifier(profile.dir)).toBeUndefined()
    } finally {
      profile.cleanup()
    }
  })

  it('prefers a profile payload over a well-formed sibling checkout', async () => {
    const parent = resolve(tmpdir(), `shres-shield-profile-wins-${Math.random().toString(36).slice(2)}`)
    const repo = join(parent, 'repo')
    const dist = join(parent, 'shres-shield', 'packages', 'plugin', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.js'), APPLY_ONLY_MODULE)
    writeFileSync(join(dist, 'package.json'), '{"type":"module"}\n')
    const profile = makeProfileDir()
    try {
      const engine = await resolveShieldEngine({ profileDir: profile.dir, repoRoot: repo })
      expect(engine?.source).toBe('profile')
      expect(engine?.entry).toContain(join('node_modules', '@shrestech', 'shres-shield-plugin'))
    } finally {
      profile.cleanup()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('picks up the profile-installed payload when env and sibling are absent', async () => {
    const profile = makeProfileDir()
    try {
      const engine = await resolveShieldEngine({
        profileDir: profile.dir,
        repoRoot: neutralSiblingRoot(),
      })
      expect(engine?.source).toBe('profile')
      expect(typeof engine?.apply).toBe('function')
      expect(engine?.snapshot).toBeDefined()
      expect(engine?.snapshot?.('/cwd')).toEqual({ cwd: '/cwd', screened: 1 })
    } finally {
      profile.cleanup()
    }
  })

  it('resolves an env-module override first', async () => {
    process.env.SHRES_SHIELD_MODULE = fixtureUrl
    const engine = await resolveShieldEngine({ repoRoot: neutralSiblingRoot() })
    expect(engine?.source).toBe('env')
  })

  it('resolves a file:-URL env override', async () => {
    process.env.SHRES_SHIELD_MODULE = pathToFileURL(fixtureUrl).href
    const engine = await resolveShieldEngine()
    expect(engine?.source).toBe('env')
  })

  it('resolves an injected sibling layout when no profile is given', async () => {
    // A unique parent keeps the injected `../shres-shield` from colliding with
    // the neutralization scratch dirs used by the profile-leg tests below.
    const parent = resolve(tmpdir(), `shres-shield-sibling-${Math.random().toString(36).slice(2)}`)
    const repo = join(parent, 'repo')
    const dist = join(parent, 'shres-shield', 'packages', 'plugin', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.js'), APPLY_ONLY_MODULE)
    writeFileSync(join(dist, 'package.json'), '{"type":"module"}\n')
    try {
      const engine = await resolveShieldEngine({ repoRoot: repo })
      expect(engine?.source).toBe('sibling')
      expect(engine?.entry).toBe(join(dist, 'index.js'))
      expect(engine?.snapshot).toBeUndefined()
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('falls back to the published package when env, profile, and sibling miss', async () => {
    const engine = await resolveShieldEngine({ repoRoot: neutralSiblingRoot() })
    expect(engine?.source).toBe('package')
    expect(engine?.entry).toBe(PAYLOAD_SPECIFIER)
  })

  it('does not fall through to profile or package when env is set but unresolvable', async () => {
    process.env.SHRES_SHIELD_MODULE = '/no/such/shield-module.js'
    const profile = makeProfileDir()
    try {
      const engine = await resolveShieldEngine({ profileDir: profile.dir, repoRoot: neutralSiblingRoot() })
      expect(engine).toBeUndefined()
    } finally {
      profile.cleanup()
    }
    process.env.SHRES_SHIELD_MODULE = 'not-a-real-shield-package'
    expect(await resolveShieldEngine({ repoRoot: neutralSiblingRoot() })).toBeUndefined()
  })

  it('returns undefined when a file-leg import fails with and without the bust query', async () => {
    const dir = resolve(tmpdir(), `shres-shield-bad-js-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'broken.js')
    writeFileSync(file, 'this is not valid javascript {{{')
    process.env.SHRES_SHIELD_MODULE = file
    try {
      expect(await resolveShieldEngine({ repoRoot: neutralSiblingRoot() })).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns a top-level snapshot when the payload has no stats reader', async () => {
    const profile = makeProfileDir(TOP_LEVEL_SNAPSHOT_MODULE)
    try {
      const engine = await resolveShieldEngine({ profileDir: profile.dir, repoRoot: neutralSiblingRoot() })
      expect(engine?.source).toBe('profile')
      expect(engine?.snapshot?.('/cwd')).toEqual({ cwd: '/cwd', screened: 2 })
    } finally {
      profile.cleanup()
    }
  })

  it('falls through past a malformed profile payload to the published package', async () => {
    const profile = makeProfileDir(INVALID_APPLY_MODULE)
    try {
      const engine = await resolveShieldEngine({ profileDir: profile.dir, repoRoot: neutralSiblingRoot() })
      expect(engine?.source).toBe('package')
    } finally {
      profile.cleanup()
    }
  })

  it('falls back to profile when the injected sibling exists but is malformed', async () => {
    const parent = resolve(tmpdir(), `shres-shield-bad-sibling-${Math.random().toString(36).slice(2)}`)
    const repo = join(parent, 'repo')
    const dist = join(parent, 'shres-shield', 'packages', 'plugin', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.js'), INVALID_APPLY_MODULE)
    writeFileSync(join(dist, 'package.json'), '{"type":"module"}\n')
    const profile = makeProfileDir()
    try {
      const engine = await resolveShieldEngine({ profileDir: profile.dir, repoRoot: repo })
      expect(engine?.source).toBe('profile')
    } finally {
      profile.cleanup()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('skips the profile leg when the profile does not carry the payload', async () => {
    const profile = makeProfileDir()
    try {
      rmSync(join(profile.dir, 'node_modules', '@shrestech'), { recursive: true, force: true })
      const engine = await resolveShieldEngine({ profileDir: profile.dir, repoRoot: neutralSiblingRoot() })
      expect(engine?.source).toBe('package')
    } finally {
      profile.cleanup()
    }
  })

  it('falls through past a malformed sibling to the published package', async () => {
    const parent = resolve(tmpdir(), `shres-shield-bad-sibling-only-${Math.random().toString(36).slice(2)}`)
    const repo = join(parent, 'repo')
    const dist = join(parent, 'shres-shield', 'packages', 'plugin', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.js'), INVALID_APPLY_MODULE)
    writeFileSync(join(dist, 'package.json'), '{"type":"module"}\n')
    try {
      const engine = await resolveShieldEngine({ repoRoot: repo })
      expect(engine?.source).toBe('package')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('resolves an ESM-only profile payload that publishes exports.import and no main', () => {
    const dir = resolve(tmpdir(), `shres-shield-esm-only-${Math.random().toString(36).slice(2)}`)
    const pkgDir = join(dir, 'node_modules', '@shrestech', 'shres-shield-plugin')
    mkdirSync(join(pkgDir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"profile-test","private":true,"dependencies":{}}\n')
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: PAYLOAD_SPECIFIER,
        version: '0.2.1',
        type: 'module',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      }) + '\n',
    )
    writeFileSync(join(pkgDir, 'dist', 'index.js'), APPLY_ONLY_MODULE)
    try {
      expect(resolveProfileSpecifier(dir)).toBe(join(pkgDir, 'dist', 'index.js'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a profile payload whose exports map is a string', () => {
    const dir = resolve(tmpdir(), `shres-shield-exports-string-${Math.random().toString(36).slice(2)}`)
    const pkgDir = join(dir, 'node_modules', '@shrestech', 'shres-shield-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"profile-test","private":true}\n')
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: PAYLOAD_SPECIFIER, type: 'module', exports: './index.js' }) + '\n',
    )
    writeFileSync(join(pkgDir, 'index.js'), APPLY_ONLY_MODULE)
    try {
      const resolved = resolveProfileSpecifier(dir)
      expect(resolved).toBeTruthy()
      expect(resolved).toMatch(/index\.js$/)
      expect(existsSync(resolved as string)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a profile payload whose exports["."] is a string', () => {
    const dir = resolve(tmpdir(), `shres-shield-exports-dot-${Math.random().toString(36).slice(2)}`)
    const pkgDir = join(dir, 'node_modules', '@shrestech', 'shres-shield-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"profile-test","private":true}\n')
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: PAYLOAD_SPECIFIER, type: 'module', exports: { '.': './index.js' } }) + '\n',
    )
    writeFileSync(join(pkgDir, 'index.js'), APPLY_ONLY_MODULE)
    try {
      const resolved = resolveProfileSpecifier(dir)
      expect(resolved).toBeTruthy()
      expect(resolved).toMatch(/index\.js$/)
      expect(existsSync(resolved as string)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls through to main when exports.import is not a string', () => {
    const dir = resolve(tmpdir(), `shres-shield-exports-main-${Math.random().toString(36).slice(2)}`)
    const pkgDir = join(dir, 'node_modules', '@shrestech', 'shres-shield-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"profile-test","private":true}\n')
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: PAYLOAD_SPECIFIER,
        type: 'module',
        exports: { '.': { types: './index.d.ts' } },
        main: './index.js',
      }) + '\n',
    )
    writeFileSync(join(pkgDir, 'index.js'), APPLY_ONLY_MODULE)
    try {
      expect(resolveProfileSpecifier(dir)).toBe(join(pkgDir, 'index.js'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips an ESM-only profile package whose name, JSON, or entry is unusable', () => {
    const dir = resolve(tmpdir(), `shres-shield-esm-miss-${Math.random().toString(36).slice(2)}`)
    const pkgDir = join(dir, 'node_modules', '@shrestech', 'shres-shield-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"profile-test","private":true}\n')
    try {
      writeFileSync(join(pkgDir, 'package.json'), '{')
      expect(resolveProfileSpecifier(dir)).toBeUndefined()
      writeFileSync(join(pkgDir, 'package.json'), 'null\n')
      expect(resolveProfileSpecifier(dir)).toBeUndefined()
      writeFileSync(join(pkgDir, 'package.json'), '1\n')
      expect(resolveProfileSpecifier(dir)).toBeUndefined()
      writeFileSync(join(pkgDir, 'package.json'), '{"name":"other","exports":"./index.js"}\n')
      expect(resolveProfileSpecifier(dir)).toBeUndefined()
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: PAYLOAD_SPECIFIER, type: 'module' }) + '\n',
      )
      expect(resolveProfileSpecifier(dir)).toBeUndefined()
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: PAYLOAD_SPECIFIER, type: 'module', exports: { '.': { import: './missing.js' } } }) + '\n',
      )
      expect(resolveProfileSpecifier(dir)).toBeUndefined()
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: PAYLOAD_SPECIFIER, type: 'module', exports: null }) + '\n',
      )
      expect(resolveProfileSpecifier(dir)).toBeUndefined()
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: PAYLOAD_SPECIFIER, type: 'module', exports: { '.': null } }) + '\n',
      )
      expect(resolveProfileSpecifier(dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads rewritten payload code at the same profile path in the same process', async () => {
    const oldSource = `
export async function apply() { return { dispose: async () => {} } }
export const stats = { snapshot: () => ({ marker: 'old' }) }
`
    const newSource = `
export async function apply() { return { dispose: async () => {} } }
export const stats = { snapshot: () => ({ marker: 'new' }) }
`
    const profile = makeProfileDir(oldSource)
    try {
      const first = await resolveShieldEngine({
        profileDir: profile.dir,
        repoRoot: neutralSiblingRoot(),
      })
      expect(first?.snapshot?.()).toEqual({ marker: 'old' })
      const entry = resolveProfileSpecifier(profile.dir) as string
      const beforeHref = fileImportHref(entry)
      writeFileSync(entry, newSource)
      // Token is mtime+size; bump mtime so a same-ms rewrite still busts.
      const later = Date.now() / 1000 + 5
      utimesSync(entry, later, later)
      expect(fileImportHref(entry)).not.toBe(beforeHref)
      const second = await resolveShieldEngine({
        profileDir: profile.dir,
        repoRoot: neutralSiblingRoot(),
      })
      expect(second?.snapshot?.()).toEqual({ marker: 'new' })
    } finally {
      profile.cleanup()
    }
  })

  it('reloads a child module when the same profile tree is overwritten', async () => {
    const dir = resolve(tmpdir(), `shres-shield-multifile-${Math.random().toString(36).slice(2)}`)
    const pkgDir = join(dir, 'node_modules', '@shrestech', 'shres-shield-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"profile-test","private":true,"dependencies":{}}\n')
    writeFileSync(
      join(pkgDir, 'package.json'),
      `{"name":"${PAYLOAD_SPECIFIER}","version":"0.2.0","type":"module","main":"index.js"}\n`,
    )
    const writeGraph = (marker: string, stamp: string): void => {
      writeFileSync(join(pkgDir, 'index.js'), `
import { marker } from './child.js'
export async function apply() { return { dispose: async () => {} } }
export const stats = { snapshot: () => ({ marker }) }
${stamp}
`)
      writeFileSync(join(pkgDir, 'child.js'), `export const marker = ${JSON.stringify(marker)}\n`)
    }
    writeGraph('old', '// gen-1')
    try {
      const first = await resolveShieldEngine({
        profileDir: dir,
        repoRoot: neutralSiblingRoot(),
      })
      expect(first?.snapshot?.()).toEqual({ marker: 'old' })
      writeGraph('new', '// gen-2')
      const entry = join(pkgDir, 'index.js')
      const later = Date.now() / 1000 + 5
      utimesSync(entry, later, later) // same-ms rewrite still changes the bust token
      const second = await resolveShieldEngine({
        profileDir: dir,
        repoRoot: neutralSiblingRoot(),
      })
      expect(second?.snapshot?.()).toEqual({ marker: 'new' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('fileImportHref', () => {
  it('leaves a bare specifier unchanged and omits the query when the file is missing', () => {
    expect(fileImportHref(PAYLOAD_SPECIFIER)).toBe(PAYLOAD_SPECIFIER)
    expect(fileImportHref('file://example.com/foo')).toBe('file://example.com/foo')
    expect(fileImportHref('./no-such-shield-file.js').startsWith('file:')).toBe(true)
    expect(fileImportHref('./no-such-shield-file.js')).not.toContain(PAYLOAD_IMPORT_BUST_PARAM)
    expect(fileImportHref(tmpdir())).not.toContain(PAYLOAD_IMPORT_BUST_PARAM)
    const missing = resolve(tmpdir(), `shres-shield-missing-${Math.random().toString(36).slice(2)}.js`)
    const href = fileImportHref(missing)
    expect(href.startsWith('file:')).toBe(true)
    expect(href).not.toContain(PAYLOAD_IMPORT_BUST_PARAM)
  })

  it('appends a bust query for an existing file path and a file: URL', () => {
    const profile = makeProfileDir()
    try {
      const entry = resolveProfileSpecifier(profile.dir) as string
      const fromPath = fileImportHref(entry)
      const fromUrl = fileImportHref(pathToFileURL(entry).href)
      expect(fromPath).toContain(`${PAYLOAD_IMPORT_BUST_PARAM}=`)
      expect(fromUrl).toContain(`${PAYLOAD_IMPORT_BUST_PARAM}=`)
    } finally {
      profile.cleanup()
    }
  })
})

describe('propagateShieldImportBust', () => {
  const emptyContext = { conditions: [] as string[], importAttributes: {} }

  it('copies the parent bust param onto child file URLs and ignores other parents', () => {
    const parent = `file:///pkg/index.js?${PAYLOAD_IMPORT_BUST_PARAM}=1.2`
    const copied = propagateShieldImportBust(
      './child.js',
      { ...emptyContext, parentURL: parent },
      () => ({ url: 'file:///pkg/child.js' }),
    )
    expect(copied.url).toBe(`file:///pkg/child.js?${PAYLOAD_IMPORT_BUST_PARAM}=1.2`)
    const already = propagateShieldImportBust(
      './child.js',
      { ...emptyContext, parentURL: parent },
      () => ({ url: `file:///pkg/child.js?${PAYLOAD_IMPORT_BUST_PARAM}=1.2` }),
    )
    expect(already.url).toBe(`file:///pkg/child.js?${PAYLOAD_IMPORT_BUST_PARAM}=1.2`)
    expect(propagateShieldImportBust(
      'node:path',
      { ...emptyContext, parentURL: parent },
      () => ({ url: 'node:path' }),
    ).url).toBe('node:path')
    expect(propagateShieldImportBust(
      './child.js',
      { ...emptyContext, parentURL: undefined },
      () => ({ url: 'file:///pkg/child.js' }),
    ).url).toBe('file:///pkg/child.js')
    expect(propagateShieldImportBust(
      './child.js',
      { ...emptyContext, parentURL: 'file:///pkg/index.js' },
      () => ({ url: 'file:///pkg/child.js' }),
    ).url).toBe('file:///pkg/child.js')
    expect(propagateShieldImportBust(
      './child.js',
      { ...emptyContext, parentURL: `file:///pkg/index.js?${PAYLOAD_IMPORT_BUST_PARAM}=` },
      () => ({ url: 'file:///pkg/child.js' }),
    ).url).toBe('file:///pkg/child.js')
    expect(propagateShieldImportBust(
      './child.js',
      { ...emptyContext, parentURL: 'not a url' },
      () => ({ url: 'file:///pkg/child.js' }),
    ).url).toBe('file:///pkg/child.js')
  })
})
