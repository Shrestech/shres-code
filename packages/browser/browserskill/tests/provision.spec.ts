import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureLaunchArtifacts,
  artifactPaths,
  detectInstalledChrome,
  downloadVerified,
  evaluateInstalledChrome,
  manifestArtifactPins,
  preflight,
  provisionArtifacts,
  ProvisionRefusedError,
  readProvisionedState,
  type ArtifactPins,
  type DownloadFetch,
} from '../src/runtime/provision.ts'
import { computeTreeDigest, extractZipArchive, sha256Bytes, sha256File } from '../src/runtime/extract.ts'
import { BSK_VERSION, EXTENSION_ASSET, EXTENSION_TREE_SHA256, EXTENSION_VERSION, BSK_PLATFORM_PIN, bskArchiveUrl, extensionArchiveUrl, platformPin } from '../src/runtime/manifest.ts'
import { resolveBrowserSkillConfig } from '../src/config.ts'
import type { ResolvedBrowserSkillConfig } from '../src/config.ts'
import type { BrowserSkillRefusal } from '../src/types.ts'

// The launch-repair rollback tests need specific renames to fail mid-swap;
// the pass-through wrapper counts calls so a test can fail exactly the calls
// it names and every other test keeps the real rename.
const renameControl = vi.hoisted(() => ({ calls: 0, failOn: [] as number[] }))
const platformControl = vi.hoisted(() => ({ noPin: false }))
const readControl = vi.hoisted(() => ({ failPlist: false, plistBody: '' }))
// Fault-injection seams: a one-shot lstat failure code and a staged-zip read
// that is swapped for tampered bytes on its Nth read.
const lstatControl = vi.hoisted(() => ({ failCode: '' }))
const swapControl = vi.hoisted(() => ({ active: false, reads: 0, threshold: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (lstatControl.failCode !== '') {
        throw Object.assign(new Error('injected lstat failure'), { code: lstatControl.failCode })
      }
      return actual.lstat(...args)
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const target = args[0]
      if (typeof target === 'string' && target.endsWith('extension.zip') && swapControl.active) {
        swapControl.reads += 1
        if (swapControl.reads >= swapControl.threshold) {
          // Swap the extraction read; earlier reads (the retained-path probe,
          // downloadVerified's own hash) stay faithful.
          return Buffer.from('tampered staged bytes')
        }
      }
      if (typeof target === 'string' && target.endsWith('Info.plist')) {
        if (readControl.failPlist) {
          throw Object.assign(new Error('no bundle'), { code: 'ENOENT' })
        }
        if (readControl.plistBody !== '') return readControl.plistBody
      }
      return actual.readFile(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      renameControl.calls += 1
      const index = renameControl.failOn.indexOf(renameControl.calls)
      if (index !== -1) {
        renameControl.failOn.splice(index, 1)
        throw new Error('forced rename failure')
      }
      return actual.rename(...args)
    },
  }
})
vi.mock('../src/runtime/manifest.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtime/manifest.ts')>()
  return {
    ...actual,
    platformPin: () => (platformControl.noPin ? undefined : actual.platformPin()),
    bskArchiveUrl: (config: ResolvedBrowserSkillConfig) => (platformControl.noPin ? undefined : actual.bskArchiveUrl(config)),
  }
})

const cleanup: string[] = []
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})
beforeEach(() => {
  renameControl.calls = 0
  renameControl.failOn = []
  platformControl.noPin = false
  readControl.failPlist = false
  readControl.plistBody = ''
  lstatControl.failCode = ''
  swapControl.active = false
  swapControl.reads = 0
  swapControl.threshold = 0
})

async function ownedRoot(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `shres-bsk-provision-${label}-`))
  cleanup.push(dir)
  return dir
}

/** A throwaway directory for building fixture archives and their pins. */
async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shres-bsk-provision-fix-'))
  cleanup.push(dir)
  return dir
}

async function stagingEntries(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, 'artifacts'))).filter(name => name.startsWith('staging-'))
  } catch {
    return []
  }
}

/** Capture the user-displayable refusal a run ends with. */
async function refusalOf(run: () => Promise<unknown>): Promise<BrowserSkillRefusal> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ProvisionRefusedError) return error.refusal
    throw error
  }
  throw new Error('expected the run to be refused')
}

/** Capture a refusal of one expected kind, narrowed so its fields typecheck. */
async function refusalOfKind<K extends BrowserSkillRefusal['kind']>(run: () => Promise<unknown>, kind: K): Promise<Extract<BrowserSkillRefusal, { kind: K }>> {
  const refusal = await refusalOf(run)
  expect(refusal.kind).toBe(kind)
  return refusal as Extract<BrowserSkillRefusal, { kind: K }>
}

// ---- synthetic fixtures: every pin is computed from bytes built in-source,
// so the full flows run without network access or committed binaries ----

const EXECUTABLE_BYTES = new TextEncoder().encode('#!/bin/sh\necho fixture-bsk\n')

const FIXTURE_ZIP = zipSync({
  'manifest.json': strToU8('{"name":"fixture-extension","version":"0.3.1"}'),
  'icons/': new Uint8Array(0),
  'icons/icon.png': strToU8('png-bytes'),
  'lib/': new Uint8Array(0),
  'lib/content.js': strToU8('export const marker = "fixture"'),
})

async function fixtureBskArchive(dir: string): Promise<string> {
  const { create } = await import('tar')
  await writeFile(join(dir, 'bsk'), EXECUTABLE_BYTES)
  const archive = join(dir, 'bsk.tar.gz')
  await create({ gzip: true, file: archive, cwd: dir }, ['bsk'])
  return archive
}

/** Pins computed from the fixture bytes. */
async function fixturePins(dir: string): Promise<ArtifactPins> {
  const archive = await fixtureBskArchive(dir)
  const treeRef = join(dir, 'tree-ref')
  await mkdir(treeRef, { mode: 0o700 })
  await extractZipArchive(FIXTURE_ZIP, treeRef, 1 << 20)
  return {
    bskArchiveSha256: await sha256File(archive),
    bskBinarySha256: sha256Bytes(EXECUTABLE_BYTES),
    extensionArchiveSha256: sha256Bytes(FIXTURE_ZIP),
    extensionTreeDigest: await computeTreeDigest(treeRef),
  }
}

const MIRROR = resolveBrowserSkillConfig({ artifactBaseUrl: 'http://127.0.0.1:9/assets' })
const BSK_URL = 'http://127.0.0.1:9/assets/bsk-v0.3.1-aarch64-apple-darwin.tar.gz'
const EXTENSION_URL = 'http://127.0.0.1:9/assets/browser-skill-extension-v0.3.1-chrome.zip'

/** BodyInit requires an ArrayBuffer-backed view; copy so the type is exact. */
const abBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

/** A fetch that serves the fixture bytes from memory and records every call. */
async function fixtureFetch(
  bskArchivePath: string,
  overrides: Partial<Record<string, () => Response>> = {},
): Promise<{ fetchImpl: DownloadFetch; calls: URL[] }> {
  const bskBytes = await readFile(bskArchivePath)
  const bodies: Record<string, Uint8Array> = {
    [BSK_URL]: new Uint8Array(bskBytes),
    [EXTENSION_URL]: FIXTURE_ZIP,
  }
  const calls: URL[] = []
  const fetchImpl: DownloadFetch = async (url) => {
    calls.push(url)
    const override = overrides[url.href]
    if (override !== undefined) return override()
    const body = bodies[url.href]
    if (body === undefined) return new Response('no fixture', { status: 404 })
    return new Response(abBytes(body), { status: 200, headers: { 'content-length': String(body.byteLength) } })
  }
  return { fetchImpl, calls }
}

async function seedProvisionedRoot(root: string, pins: ArtifactPins): Promise<void> {
  const paths = artifactPaths(root)
  await mkdir(paths.extensionDir, { recursive: true, mode: 0o700 })
  await extractZipArchive(FIXTURE_ZIP, paths.extensionDir, 1 << 20)
  await mkdir(dirname(paths.bskExecutable), { recursive: true, mode: 0o700 })
  await writeFile(paths.bskExecutable, EXECUTABLE_BYTES, { mode: 0o500 })
  await writeFile(paths.extensionArchive, FIXTURE_ZIP, { mode: 0o600 })
  const state = {
    version: 1 as const,
    bsk: {
      version: BSK_VERSION,
      executablePath: paths.bskExecutable,
      binarySha256: pins.bskBinarySha256,
      archiveSha256: pins.bskArchiveSha256,
    },
    extension: {
      version: EXTENSION_VERSION,
      dir: paths.extensionDir,
      archiveSha256: pins.extensionArchiveSha256,
      treeDigest: pins.extensionTreeDigest,
    },
  }
  await writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

async function writeState(root: string, state: unknown): Promise<void> {
  await writeFile(artifactPaths(root).stateFile, JSON.stringify(state))
}

describe('provisioned state parsing', () => {
  it('accepts a complete record with integrity receipts', async () => {
    const root = await ownedRoot('parse-ok')
    await seedProvisionedRoot(root, {
      bskArchiveSha256: 'a'.repeat(64),
      bskBinarySha256: sha256Bytes(EXECUTABLE_BYTES),
      extensionArchiveSha256: 'b'.repeat(64),
      extensionTreeDigest: 'c'.repeat(64),
    })
    const state = await readProvisionedState(root)
    expect(state?.extension.treeDigest).toBe('c'.repeat(64))
    expect(state?.extension.dir).toBe(artifactPaths(root).extensionDir)
  })

  it('rejects an old draft missing the tree-digest receipt', async () => {
    const root = await ownedRoot('parse-draft')
    const paths = artifactPaths(root)
    await mkdir(dirname(paths.stateFile), { recursive: true })
    await writeState(root, {
      version: 1,
      bsk: { version: BSK_VERSION, executablePath: paths.bskExecutable, binarySha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64) },
      extension: { version: EXTENSION_VERSION, dir: paths.extensionDir, archiveSha256: 'c'.repeat(64) },
    })
    expect(await readProvisionedState(root)).toBeUndefined()
  })

  it('rejects an absent record', async () => {
    const root = await ownedRoot('parse-absent')
    expect(await readProvisionedState(root)).toBeUndefined()
  })

  it('rejects garbage records', async () => {
    const root = await ownedRoot('parse-garbage')
    const paths = artifactPaths(root)
    await mkdir(dirname(paths.stateFile), { recursive: true })
    await writeState(root, { version: 1 })
    expect(await readProvisionedState(root)).toBeUndefined()
    await writeState(root, 'not-a-record')
    expect(await readProvisionedState(root)).toBeUndefined()
    await writeState(root, {
      version: 1,
      bsk: { version: BSK_VERSION, executablePath: 7, binarySha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64) },
      extension: { version: EXTENSION_VERSION, dir: paths.extensionDir, archiveSha256: 'c'.repeat(64), treeDigest: 'd'.repeat(64) },
    })
    expect(await readProvisionedState(root)).toBeUndefined()
  })
})

describe('downloadVerified', () => {
  const smallConfig = (): ResolvedBrowserSkillConfig => resolveBrowserSkillConfig({ maxDownloadBytes: 1000, downloadTimeoutMs: 5_000 })

  function hangingStream(): { stream: ReadableStream<Uint8Array>; fail: (reason: unknown) => void } {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(caught) {
        controller = caught
      },
    })
    return { stream, fail: reason => controller?.error(reason) }
  }

  it('stages pin-matching bytes and reports the pin', async () => {
    const root = await ownedRoot('dl-ok')
    const dest = join(root, 'staged.bin')
    const bytes = new TextEncoder().encode('deterministic download bytes')
    const fetchImpl: DownloadFetch = async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
    const expected = sha256Bytes(bytes)
    expect(await downloadVerified(new URL('http://127.0.0.1:9/asset'), dest, expected, 'extension', { config: smallConfig(), fetchImpl })).toBe(expected)
  })

  it('refuses a declared Content-Length over the bound before reading the body', async () => {
    const root = await ownedRoot('dl-declared')
    const dest = join(root, 'staged.bin')
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      // The Response constructor buffers one chunk; any further pull means
      // the transfer itself is reading the body it refused to trust.
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(1))
      },
    })
    const fetchImpl: DownloadFetch = async () => new Response(stream, { status: 200, headers: { 'content-length': '2000' } })
    const refusal = await refusalOfKind(() => downloadVerified(new URL('http://127.0.0.1:9/asset'), dest, 'x'.repeat(64), 'extension', { config: smallConfig(), fetchImpl }), 'download-failed')
    // The refusal names the declared bound, not the streamed count.
    expect(refusal.detail).toMatch(/declares 2000 bytes/)
    expect(pulls).toBeLessThanOrEqual(1)
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('tears down an unbounded body with no Content-Length once the streamed count passes the bound', async () => {
    const root = await ownedRoot('dl-stream')
    const dest = join(root, 'staged.bin')
    let cancelled = false
    const chunk = new Uint8Array(400).fill(0x61)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    const fetchImpl: DownloadFetch = async () => new Response(stream, { status: 200 })
    const refusal = await refusalOfKind(() => downloadVerified(new URL('http://127.0.0.1:9/asset'), dest, 'x'.repeat(64), 'extension', { config: smallConfig(), fetchImpl }), 'download-failed')
    expect(refusal.detail).toMatch(/bound/)
    expect(cancelled).toBe(true)
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('catches a lying Content-Length with the streaming bound', async () => {
    const root = await ownedRoot('dl-lying')
    const dest = join(root, 'staged.bin')
    const chunk = new Uint8Array(400).fill(0x61)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
    })
    const fetchImpl: DownloadFetch = async () => new Response(stream, { status: 200, headers: { 'content-length': '10' } })
    const refusal = await refusalOf(() => downloadVerified(new URL('http://127.0.0.1:9/asset'), dest, 'x'.repeat(64), 'extension', { config: smallConfig(), fetchImpl }))
    expect(refusal.kind).toBe('download-failed')
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('honors the caller abort mid-transfer', async () => {
    const root = await ownedRoot('dl-abort')
    const dest = join(root, 'staged.bin')
    const caller = new AbortController()
    const { stream, fail } = hangingStream()
    const fetchImpl: DownloadFetch = async (_url, init) => {
      init?.signal?.addEventListener('abort', () => {
        fail(new Error('aborted by caller'))
      }, { once: true })
      return new Response(stream, { status: 200 })
    }
    setTimeout(() => {
      caller.abort(new Error('stop'))
    }, 30)
    const refusal = await refusalOf(() => downloadVerified(new URL('http://127.0.0.1:9/asset'), dest, 'x'.repeat(64), 'extension', { config: smallConfig(), fetchImpl, signal: caller.signal }))
    expect(refusal.kind).toBe('download-failed')
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces the download deadline on a stalled transfer', async () => {
    const root = await ownedRoot('dl-deadline')
    const dest = join(root, 'staged.bin')
    const { stream, fail } = hangingStream()
    const fetchImpl: DownloadFetch = async (_url, init) => {
      init?.signal?.addEventListener('abort', () => {
        fail(new Error('download timed out'))
      }, { once: true })
      return new Response(stream, { status: 200 })
    }
    const config = resolveBrowserSkillConfig({ maxDownloadBytes: 1000, downloadTimeoutMs: 50 })
    const refusal = await refusalOf(() => downloadVerified(new URL('http://127.0.0.1:9/asset'), dest, 'x'.repeat(64), 'extension', { config, fetchImpl }))
    expect(refusal.kind).toBe('download-failed')
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses bytes that do not hash to the pin', async () => {
    const root = await ownedRoot('dl-hash')
    const dest = join(root, 'staged.bin')
    const bytes = new TextEncoder().encode('bytes with the wrong hash')
    const fetchImpl: DownloadFetch = async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
    const refusal = await refusalOf(() => downloadVerified(new URL('http://127.0.0.1:9/asset'), dest, 'x'.repeat(64), 'extension', { config: smallConfig(), fetchImpl }))
    expect(refusal.kind).toBe('hash-mismatch')
    expect(refusal).toMatchObject({ artifact: 'extension', expected: 'x'.repeat(64) })
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe.skipIf(platformPin() === undefined)('provisioning flows', () => {
  const setup = async (): Promise<{ root: string; pins: ArtifactPins; dir: string }> => {
    const root = await ownedRoot('flow')
    const dir = await fixtureDir()
    return { root, pins: await fixturePins(dir), dir }
  }

  it('provisions both artifacts at the fixed paths, retains the archive, and records receipts', async () => {
    const { root, pins, dir } = await setup()
    const { fetchImpl, calls } = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    const state = await provisionArtifacts({ root, config: MIRROR, fetchImpl, pins })
    const paths = artifactPaths(root)
    expect(paths.extensionDir).toBe(join(root, 'artifacts', 'extension'))
    expect(state.extension.dir).toBe(paths.extensionDir)
    expect(state.extension.treeDigest).toBe(pins.extensionTreeDigest)
    expect(await computeTreeDigest(paths.extensionDir)).toBe(pins.extensionTreeDigest)
    expect(await readFile(join(paths.extensionDir, 'manifest.json'), 'utf8')).toBe('{"name":"fixture-extension","version":"0.3.1"}')
    expect(await sha256File(paths.extensionArchive)).toBe(pins.extensionArchiveSha256)
    expect((await stat(paths.bskExecutable)).mode & 0o777).toBe(0o500)
    expect(await readFile(paths.bskExecutable, 'utf8')).toBe(new TextDecoder().decode(EXECUTABLE_BYTES))
    expect(calls.map(url => url.href).sort()).toEqual([BSK_URL, EXTENSION_URL].sort())
    expect(await stagingEntries(root)).toEqual([])
  })

  it('re-provisions a verified root with no fetch at all', async () => {
    const { root, pins, dir } = await setup()
    const first = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: first.fetchImpl, pins })
    const second = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: second.fetchImpl, pins })
    expect(second.calls).toEqual([])
  })

  it('repairs a corrupted extension tree from the retained archive without fetching', async () => {
    const { root, pins, dir } = await setup()
    const first = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: first.fetchImpl, pins })
    await writeFile(join(artifactPaths(root).extensionDir, 'lib/content.js'), 'mutated in place')
    const second = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: second.fetchImpl, pins })
    expect(second.calls).toEqual([])
    expect(await computeTreeDigest(artifactPaths(root).extensionDir)).toBe(pins.extensionTreeDigest)
    expect(await readFile(join(artifactPaths(root).extensionDir, 'lib/content.js'), 'utf8')).toBe('export const marker = "fixture"')
  })

  it('repairs a missing extension directory — the crash gap — from the retained archive', async () => {
    const { root, pins, dir } = await setup()
    const first = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: first.fetchImpl, pins })
    await rm(artifactPaths(root).extensionDir, { recursive: true })
    const second = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: second.fetchImpl, pins })
    expect(second.calls).toEqual([])
    expect(await computeTreeDigest(artifactPaths(root).extensionDir)).toBe(pins.extensionTreeDigest)
  })

  it('re-fetches the extension only when both the tree and the retained archive are bad', async () => {
    const { root, pins, dir } = await setup()
    const first = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: first.fetchImpl, pins })
    await writeFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'mutated')
    await writeFile(artifactPaths(root).extensionArchive, 'not a zip')
    const second = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: second.fetchImpl, pins })
    expect(second.calls.map(url => url.href)).toEqual([EXTENSION_URL])
    expect(await computeTreeDigest(artifactPaths(root).extensionDir)).toBe(pins.extensionTreeDigest)
    expect(await sha256File(artifactPaths(root).extensionArchive)).toBe(pins.extensionArchiveSha256)
  })

  it('re-downloads a corrupted executable and republishes it read-only-executable', async () => {
    const { root, pins, dir } = await setup()
    const first = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: first.fetchImpl, pins })
    await chmod(artifactPaths(root).bskExecutable, 0o700)
    await writeFile(artifactPaths(root).bskExecutable, 'tampered bytes')
    const second = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: second.fetchImpl, pins })
    expect(second.calls.map(url => url.href)).toEqual([BSK_URL])
    expect((await stat(artifactPaths(root).bskExecutable)).mode & 0o777).toBe(0o500)
    expect(await readFile(artifactPaths(root).bskExecutable, 'utf8')).toBe(new TextDecoder().decode(EXECUTABLE_BYTES))
  })

  it('refreshes a stale retained archive without touching a verified tree', async () => {
    const { root, pins, dir } = await setup()
    const first = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: first.fetchImpl, pins })
    await rm(artifactPaths(root).extensionArchive)
    const second = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: second.fetchImpl, pins })
    expect(second.calls.map(url => url.href)).toEqual([EXTENSION_URL])
    expect(await computeTreeDigest(artifactPaths(root).extensionDir)).toBe(pins.extensionTreeDigest)
    expect(await sha256File(artifactPaths(root).extensionArchive)).toBe(pins.extensionArchiveSha256)
  })

  it('refuses fetched bytes that miss the pin and leaves no staging behind', async () => {
    const { root, pins, dir } = await setup()
    const { fetchImpl } = await fixtureFetch(join(dir, 'bsk.tar.gz'), {
      [BSK_URL]: () => new Response('hostile bytes', { status: 200, headers: { 'content-length': '13' } }),
    })
    const refusal = await refusalOf(() => provisionArtifacts({ root, config: MIRROR, fetchImpl, pins }))
    expect(refusal.kind).toBe('hash-mismatch')
    expect(refusal).toMatchObject({ artifact: 'bsk' })
    expect(await stagingEntries(root)).toEqual([])
  })

  it('refuses a failed download', async () => {
    const { root, pins, dir } = await setup()
    const { fetchImpl } = await fixtureFetch(join(dir, 'bsk.tar.gz'), {
      [BSK_URL]: () => new Response('server exploded', { status: 500 }),
    })
    const refusal = await refusalOf(() => provisionArtifacts({ root, config: MIRROR, fetchImpl, pins }))
    expect(refusal.kind).toBe('download-failed')
  })
})

describe('launch verification', () => {
  const config = resolveBrowserSkillConfig()
  const freshPins = async (): Promise<ArtifactPins> => fixturePins(await fixtureDir())

  it('accepts a fully verified root, cleans staging residue, and never descends through a symlink escape', async () => {
    const root = await ownedRoot('launch-ok')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    const canaryDir = await mkdtemp(join(tmpdir(), 'shres-bsk-canary-'))
    cleanup.push(canaryDir)
    const canaryFile = join(canaryDir, 'target.txt')
    await writeFile(canaryFile, 'untouched')
    await mkdir(join(root, 'artifacts', 'staging-junk'), { recursive: true })
    await writeFile(join(root, 'artifacts', 'staging-junk', 'leftover.bin'), 'junk')
    await symlink(canaryFile, join(root, 'artifacts', 'staging-link'))
    const state = await ensureLaunchArtifacts(root, config, undefined, fixture)
    expect(state.extension.treeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(await stagingEntries(root)).toEqual([])
    await expect(lstat(join(root, 'artifacts', 'staging-link'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(canaryFile, 'utf8')).toBe('untouched')
  })

  it('fails closed when the executable is missing, even with a valid record', async () => {
    const root = await ownedRoot('launch-no-exe')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await rm(artifactPaths(root).bskExecutable)
    const refusal = await refusalOf(() => ensureLaunchArtifacts(root, config, undefined, fixture))
    expect(refusal).toMatchObject({ kind: 'hash-mismatch', artifact: 'executable', expected: fixture.bskBinarySha256, actual: 'missing' })
  })

  it('fails closed when the executable is corrupted, even with a valid record', async () => {
    const root = await ownedRoot('launch-exe-bad')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await chmod(artifactPaths(root).bskExecutable, 0o700)
    await writeFile(artifactPaths(root).bskExecutable, 'replaced by something else')
    const refusal = await refusalOf(() => ensureLaunchArtifacts(root, config, undefined, fixture))
    expect(refusal.kind).toBe('hash-mismatch')
    expect(refusal).toMatchObject({ artifact: 'executable' })
  })

  it('fails closed on a record whose receipts do not name the pinned release, without repairing', async () => {
    const root = await ownedRoot('launch-stale')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await writeFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'corrupted before the stale record')
    const paths = artifactPaths(root)
    const stale = JSON.parse(await readFile(paths.stateFile, 'utf8')) as { extension: { archiveSha256: string } }
    stale.extension.archiveSha256 = 'd'.repeat(64)
    await writeState(root, stale)
    const refusal = await refusalOfKind(() => ensureLaunchArtifacts(root, config, undefined, fixture), 'download-failed')
    expect(refusal.detail).toMatch(/run provision/)
    expect(await readFile(join(paths.extensionDir, 'manifest.json'), 'utf8')).toBe('corrupted before the stale record')
  })

  it('fails closed on a record pointing the load path outside the owned root', async () => {
    const root = await ownedRoot('launch-escape')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    const paths = artifactPaths(root)
    const escaped = JSON.parse(await readFile(paths.stateFile, 'utf8')) as { extension: { dir: string } }
    escaped.extension.dir = '/tmp/foreign-extension'
    await writeState(root, escaped)
    const refusal = await refusalOf(() => ensureLaunchArtifacts(root, config, undefined, fixture))
    expect(refusal.kind).toBe('download-failed')
  })

  it('refuses an old draft record missing the tree-digest receipt', async () => {
    const root = await ownedRoot('launch-draft')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    const paths = artifactPaths(root)
    const draft = JSON.parse(await readFile(paths.stateFile, 'utf8')) as { extension: Record<string, unknown> }
    delete draft.extension.treeDigest
    await writeState(root, draft)
    expect(await readProvisionedState(root)).toBeUndefined()
    const refusal = await refusalOfKind(() => ensureLaunchArtifacts(root, config, undefined, fixture), 'download-failed')
    expect(refusal.detail).toMatch(/no verified provisioning record/)
  })

  it('repairs a corrupted tree from the re-hashed retained archive and refreshes the receipt', async () => {
    const root = await ownedRoot('launch-repair')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await writeFile(join(artifactPaths(root).extensionDir, 'icons/icon.png'), 'tampered')
    const state = await ensureLaunchArtifacts(root, config, undefined, fixture)
    expect(await computeTreeDigest(artifactPaths(root).extensionDir)).toBe(fixture.extensionTreeDigest)
    expect(state.extension.treeDigest).toBe(fixture.extensionTreeDigest)
  })

  it('repairs a tree holding a planted symlink by replacing the whole tree', async () => {
    const root = await ownedRoot('launch-symlink')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await rm(join(artifactPaths(root).extensionDir, 'icons/icon.png'))
    await symlink('/etc/passwd', join(artifactPaths(root).extensionDir, 'icons/icon.png'))
    await ensureLaunchArtifacts(root, config, undefined, fixture)
    const planted = await stat(join(artifactPaths(root).extensionDir, 'icons/icon.png'))
    expect(planted.isFile()).toBe(true)
    expect(await computeTreeDigest(artifactPaths(root).extensionDir)).toBe(fixture.extensionTreeDigest)
  })

  it('repairs after the crash gap: fixed path gone entirely', async () => {
    const root = await ownedRoot('launch-gap')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await rm(artifactPaths(root).extensionDir, { recursive: true })
    await ensureLaunchArtifacts(root, config, undefined, fixture)
    expect(await computeTreeDigest(artifactPaths(root).extensionDir)).toBe(fixture.extensionTreeDigest)
    expect(await stagingEntries(root)).toEqual([])
  })

  it('replaces a symlink planted at the load path itself', async () => {
    const root = await ownedRoot('launch-path-link')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    const canary = join(root, 'outside')
    await mkdir(canary)
    await writeFile(join(canary, 'private.txt'), 'not extension data')
    await rm(artifactPaths(root).extensionDir, { recursive: true })
    await symlink(canary, artifactPaths(root).extensionDir)
    await ensureLaunchArtifacts(root, config, undefined, fixture)
    const loadPath = await lstat(artifactPaths(root).extensionDir)
    expect(loadPath.isSymbolicLink()).toBe(false)
    expect(await computeTreeDigest(artifactPaths(root).extensionDir)).toBe(fixture.extensionTreeDigest)
    expect(await readFile(join(canary, 'private.txt'), 'utf8')).toBe('not extension data')
  })

  it('fails closed when the tree is bad and the retained archive is missing', async () => {
    const root = await ownedRoot('launch-no-zip')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await writeFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'corrupted')
    await rm(artifactPaths(root).extensionArchive)
    const refusal = await refusalOfKind(() => ensureLaunchArtifacts(root, config, undefined, fixture), 'download-failed')
    expect(refusal.detail).toMatch(/retained archive is missing/)
    expect(await readFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'utf8')).toBe('corrupted')
  })

  it('fails closed when the tree is bad and the retained archive no longer matches the pin', async () => {
    const root = await ownedRoot('launch-bad-zip')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await writeFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'corrupted')
    await writeFile(artifactPaths(root).extensionArchive, 'stale or tampered archive bytes')
    const refusal = await refusalOfKind(() => ensureLaunchArtifacts(root, config, undefined, fixture), 'download-failed')
    expect(refusal.detail).toMatch(/no longer matches the pin/)
  })

  it('restores the retired tree when the publication rename fails mid-swap', async () => {
    const root = await ownedRoot('launch-rollback')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await writeFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'corrupted')
    renameControl.failOn = [2]
    await expect(ensureLaunchArtifacts(root, config, undefined, fixture)).rejects.toThrow('forced rename failure')
    expect(await readFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'utf8')).toBe('corrupted')
    expect(await stagingEntries(root)).toEqual([])
  })
})

describe.skipIf(platformPin() === undefined || process.env.SHRES_BSK_ASSET_DIR === undefined)('real pinned release end-to-end', () => {
  it('provisions and launch-verifies the real pinned bytes against the manifest pins', async () => {
    const assetDir = process.env.SHRES_BSK_ASSET_DIR!
    const root = await ownedRoot('real')
    const config = resolveBrowserSkillConfig()
    const bodies: Record<string, () => Promise<Uint8Array>> = {
      [extensionArchiveUrl(config).href]: async () => new Uint8Array(await readFile(join(assetDir, 'extension.zip'))),
      ...(bskArchiveUrl(config) === undefined ? {} : { [bskArchiveUrl(config)!.href]: async () => new Uint8Array(await readFile(join(assetDir, 'bsk.tar.gz'))) }),
    }
    const fetchImpl: DownloadFetch = async (url) => {
      const body = bodies[url.href]
      if (body === undefined) return new Response('no fixture', { status: 404 })
      const bytes = await body()
      return new Response(abBytes(bytes), { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
    }
    const state = await provisionArtifacts({ root, config, fetchImpl })
    expect(state.extension.treeDigest).toBe(EXTENSION_TREE_SHA256)
    expect(await computeTreeDigest(artifactPaths(root).extensionDir)).toBe(EXTENSION_TREE_SHA256)
    expect(await sha256File(artifactPaths(root).extensionArchive)).toBe(EXTENSION_ASSET.sha256)
    const verified = await ensureLaunchArtifacts(root, config)
    expect(verified.bsk.binarySha256).toBe(BSK_PLATFORM_PIN.binarySha256)
    expect(verified.extension.dir).toBe(join(root, 'artifacts', 'extension'))
  }, 60_000)
})

describe('extraction defects and error propagation', () => {
  const config = resolveBrowserSkillConfig()
  const setupWith = async (): Promise<{ root: string; pins: ArtifactPins; dir: string }> => {
    const root = await ownedRoot('defect')
    const dir = await fixtureDir()
    return { root, pins: await fixturePins(dir), dir }
  }
  const freshPins = async (): Promise<ArtifactPins> => fixturePins(await fixtureDir())

  it('resolves the manifest pins', () => {
    const pins = manifestArtifactPins()
    expect(pins.bskArchiveSha256).toBe(BSK_PLATFORM_PIN.archiveSha256)
    expect(pins.bskBinarySha256).toBe(BSK_PLATFORM_PIN.binarySha256)
    expect(pins.extensionArchiveSha256).toBe(EXTENSION_ASSET.sha256)
    expect(pins.extensionTreeDigest).toBe(EXTENSION_TREE_SHA256)
  })

  it('refuses a record pinned by another pin set when verification runs with the manifest pins', async () => {
    const root = await ownedRoot('defect-manifest-pins')
    await seedProvisionedRoot(root, await freshPins())
    const refusal = await refusalOfKind(() => ensureLaunchArtifacts(root, config), 'download-failed')
    expect(refusal.detail).toMatch(/run provision/)
  })

  it('refuses when the archive pin matches but the extracted binary does not', async () => {
    // A missing executable enters the download path; the served archive
    // hashes to its own pin but unpacks to bytes the binary pin refuses.
    const { root, pins, dir } = await setupWith()
    const { create } = await import('tar')
    await writeFile(join(dir, 'bsk'), 'not the pinned executable bytes')
    const tamperedArchive = join(dir, 'tampered.tar.gz')
    await create({ gzip: true, file: tamperedArchive, cwd: dir }, ['bsk'])
    const tamperedPins: ArtifactPins = { ...pins, bskArchiveSha256: await sha256File(tamperedArchive) }
    const { fetchImpl } = await fixtureFetch(tamperedArchive)
    const refusal = await refusalOf(() => provisionArtifacts({ root, config: MIRROR, fetchImpl, pins: tamperedPins }))
    expect(refusal).toMatchObject({ kind: 'hash-mismatch', artifact: 'executable', expected: tamperedPins.bskBinarySha256 })
  })

  it('refuses when the retained archive matches its pin but unpacks to a foreign tree', async () => {
    const { root, pins, dir } = await setupWith()
    const tamperedZip = zipSync({ 'manifest.json': strToU8('{"name":"hostile"}') })
    const mixedPins: ArtifactPins = {
      ...pins,
      extensionArchiveSha256: sha256Bytes(tamperedZip),
      extensionTreeDigest: pins.extensionTreeDigest,
    }
    await seedProvisionedRoot(root, mixedPins)
    await writeFile(artifactPaths(root).extensionArchive, tamperedZip)
    await writeFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'corrupted so the repair path runs')
    const { fetchImpl } = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    const refusal = await refusalOf(() => provisionArtifacts({ root, config: MIRROR, fetchImpl, pins: mixedPins }))
    expect(refusal).toMatchObject({ kind: 'hash-mismatch', artifact: 'extension', expected: mixedPins.extensionTreeDigest })
  })

  it('refuses the launch when the retained archive unpacks to a foreign tree', async () => {
    const { root, pins } = await setupWith()
    const tamperedZip = zipSync({ 'manifest.json': strToU8('{"name":"hostile"}') })
    const mixedPins: ArtifactPins = {
      ...pins,
      extensionArchiveSha256: sha256Bytes(tamperedZip),
      extensionTreeDigest: pins.extensionTreeDigest,
    }
    await seedProvisionedRoot(root, mixedPins)
    await writeFile(artifactPaths(root).extensionArchive, tamperedZip)
    await writeFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'corrupted so the repair path runs')
    const refusal = await refusalOf(() => ensureLaunchArtifacts(root, config, undefined, mixedPins))
    expect(refusal).toMatchObject({ kind: 'hash-mismatch', artifact: 'extension', expected: mixedPins.extensionTreeDigest })
  })

  it('refuses when the fixed load path holds a plain file and no repair source', async () => {
    const root = await ownedRoot('defect-file-path')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await rm(artifactPaths(root).extensionDir, { recursive: true })
    await writeFile(artifactPaths(root).extensionDir, 'a file where the tree belongs')
    await rm(artifactPaths(root).extensionArchive)
    const refusal = await refusalOfKind(() => ensureLaunchArtifacts(root, config, undefined, fixture), 'download-failed')
    expect(refusal.detail).toMatch(/the load path is not a directory/)
  })

  it('propagates a read failure on the executable instead of misreporting it', async () => {
    const root = await ownedRoot('defect-exe-eacces')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await chmod(artifactPaths(root).bskExecutable, 0o000)
    try {
      await expect(ensureLaunchArtifacts(root, config, undefined, fixture)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(artifactPaths(root).bskExecutable, 0o700)
    }
  })

  it('propagates a read failure inside the tree instead of misreporting it', async () => {
    const root = await ownedRoot('defect-tree-eacces')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    const victim = join(artifactPaths(root).extensionDir, 'lib/content.js')
    await writeFile(victim, 'rewritten so its bytes differ from the pin')
    await chmod(victim, 0o000)
    try {
      await expect(ensureLaunchArtifacts(root, config, undefined, fixture)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(victim, 0o700)
    }
  })

  it('refuses chrome-missing when the pinned bundle path has no bundle', async () => {
    readControl.failPlist = true
    try {
      const refusal = await refusalOf(() => detectInstalledChrome())
      expect(refusal).toMatchObject({ kind: 'chrome-missing', detail: 'Google Chrome is not installed at /Applications' })
      await expect(preflight()).rejects.toMatchObject({ refusal: { kind: 'chrome-missing' } })
    } finally {
      readControl.failPlist = false
    }
  })

  it('refuses chrome-missing when the bundle metadata carries no version', async () => {
    readControl.plistBody = '<key>Other</key><string>x</string>'
    try {
      const refusal = await refusalOf(() => detectInstalledChrome())
      expect(refusal).toMatchObject({ kind: 'chrome-missing', detail: /could not be read/ })
    } finally {
      readControl.plistBody = ''
    }
  })

  it('propagates a read failure on the retained archive instead of misreporting it', async () => {
    const root = await ownedRoot('defect-zip-eacces')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await writeFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'corrupted so the repair path runs')
    await chmod(artifactPaths(root).extensionArchive, 0o000)
    try {
      await expect(ensureLaunchArtifacts(root, config, undefined, fixture)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(artifactPaths(root).extensionArchive, 0o700)
    }
  })

  it('refuses a download whose fetch throws a non-Error reason', async () => {
    const root = await ownedRoot('dl-nonerror')
    const dest = join(root, 'staged.bin')
    const fetchImpl: DownloadFetch = async () => {
      throw 'plain-string-reason'
    }
    const refusal = await refusalOfKind(() => downloadVerified(new URL('http://127.0.0.1:9/asset'), dest, 'x'.repeat(64), 'extension', { config: resolveBrowserSkillConfig({ maxDownloadBytes: 1000, downloadTimeoutMs: 5_000 }), fetchImpl }), 'download-failed')
    expect(refusal.detail).toContain('plain-string-reason')
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves the crash gap unrepaired when the publish rename also fails from a crashed root', async () => {
    const root = await ownedRoot('defect-gap-publish')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await rm(artifactPaths(root).extensionDir, { recursive: true })
    // The retire fails naturally with ENOENT (no old tree exists) and the
    // publish is forced to fail: nothing was retired, so there is no
    // rollback and the load path stays missing for the next launch.
    renameControl.failOn = [2]
    await expect(ensureLaunchArtifacts(root, config, undefined, fixture)).rejects.toThrow('forced rename failure')
    await expect(stat(artifactPaths(root).extensionDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('propagates a failure to retire the old tree without touching it', async () => {
    const root = await ownedRoot('defect-retire')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await writeFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'corrupted')
    renameControl.failOn = [1]
    await expect(ensureLaunchArtifacts(root, config, undefined, fixture)).rejects.toThrow('forced rename failure')
    expect(await readFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'utf8')).toBe('corrupted')
    expect(await stagingEntries(root)).toEqual([])
  })

  it('leaves the crash-gap state when the restore rename also fails', async () => {
    const root = await ownedRoot('defect-restore')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    await writeFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'corrupted')
    // Publish and its rollback both fail: the load path is left missing,
    // exactly the state the next launch repairs.
    renameControl.failOn = [2, 3]
    await expect(ensureLaunchArtifacts(root, config, undefined, fixture)).rejects.toThrow('forced rename failure')
    // Retire and publish both failed and the restore was swallowed: the load
    // path is missing, exactly the state the next launch repairs.
    await expect(stat(artifactPaths(root).extensionDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await stagingEntries(root)).toEqual([])
  })

  it('fails closed on an injected lstat failure under the extension path (EACCES)', async () => {
    const { root, pins, dir } = await setupWith()
    const { fetchImpl } = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    lstatControl.failCode = 'EACCES'
    await expect(provisionArtifacts({ root, config: MIRROR, fetchImpl, pins })).rejects.toMatchObject({ code: 'EACCES' })
    // Nothing was published: no state record, no extension tree.
    await expect(stat(artifactPaths(root).stateFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(artifactPaths(root).extensionDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await stagingEntries(root)).toEqual([])
  })

  it('fails closed on an injected lstat failure during launch verification (EIO)', async () => {
    const root = await ownedRoot('defect-lstat-eio')
    const fixture = await freshPins()
    await seedProvisionedRoot(root, fixture)
    lstatControl.failCode = 'EIO'
    await expect(ensureLaunchArtifacts(root, config, undefined, fixture)).rejects.toMatchObject({ code: 'EIO' })
    // The verified tree and the retained archive were not touched.
    expect(await computeTreeDigest(artifactPaths(root).extensionDir)).toBe(fixture.extensionTreeDigest)
    expect(await sha256File(artifactPaths(root).extensionArchive)).toBe(fixture.extensionArchiveSha256)
  })

  it('re-hashes the freshly downloaded bytes and refuses a post-read swap', async () => {
    const { root, pins, dir } = await setupWith()
    const first = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    await provisionArtifacts({ root, config: MIRROR, fetchImpl: first.fetchImpl, pins })
    await writeFile(join(artifactPaths(root).extensionDir, 'manifest.json'), 'corrupted so the repair path runs')
    await rm(artifactPaths(root).extensionArchive)
    // The staged zip's third read (the extraction read; the first is the
    // retained-path probe, the second is downloadVerified's own hash) is
    // swapped for tampered bytes: the re-hash must catch what the download
    // hash could not have seen.
    swapControl.active = true
    swapControl.threshold = 3
    const second = await fixtureFetch(join(dir, 'bsk.tar.gz'))
    const refusal = await refusalOfKind(() => provisionArtifacts({ root, config: MIRROR, fetchImpl: second.fetchImpl, pins }), 'hash-mismatch')
    expect(refusal.artifact).toBe('extension')
    await expect(stat(artifactPaths(root).extensionArchive)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await stagingEntries(root)).toEqual([])
  })

  it('uses the real fetch and refuses when it cannot connect', async () => {
    const root = await ownedRoot('defect-real-fetch')
    const dir = await mkdtemp(join(tmpdir(), 'shres-bsk-provision-fix-'))
    cleanup.push(dir)
    const pins = await fixturePins(dir)
    const unreachable = resolveBrowserSkillConfig({ artifactBaseUrl: 'http://127.0.0.1:1/assets' })
    const refusal = await refusalOf(() => provisionArtifacts({ root, config: unreachable, pins }))
    expect(refusal.kind).toBe('download-failed')
  })

  it('refuses provisioning and preflight when the platform has no pin', async () => {
    const root = await ownedRoot('defect-platform')
    const pins = await freshPins()
    platformControl.noPin = true
    const refusal = await refusalOf(() => provisionArtifacts({ root, config: resolveBrowserSkillConfig(), pins }))
    expect(refusal.kind).toBe('unsupported-platform')
    await expect(preflight()).rejects.toMatchObject({ refusal: { kind: 'unsupported-platform' } })
  })

  it('evaluates a Chrome Info.plist against the pinned minimum', () => {
    const plistWith = (version: string): string =>
      `<key>CFBundleShortVersionString</key>\n  <string>${version}</string>`
    expect(evaluateInstalledChrome(plistWith('153.0.8010.53'))).toEqual({ kind: 'ok', version: '153.0.8010.53' })
    expect(evaluateInstalledChrome(plistWith('125.0.0.0'))).toEqual({ kind: 'ok', version: '125.0.0.0' })
    expect(evaluateInstalledChrome('<key>Other</key><string>1</string>')).toMatchObject({
      kind: 'refusal',
      refusal: { kind: 'chrome-missing' },
    })
    expect(evaluateInstalledChrome(plistWith('124.9.9.9'))).toMatchObject({
      kind: 'refusal',
      refusal: { kind: 'chrome-too-old', detail: 'Chrome 124.9.9.9 is older than the 125 the extension requires' },
    })
    expect(evaluateInstalledChrome(plistWith('not-a-version'))).toMatchObject({ kind: 'refusal', refusal: { kind: 'chrome-too-old' } })
  })

  it('detects the installed Chrome where the pinned bundle exists and refuses where it does not', async () => {
    // Environment-tolerant: wherever the pinned bundle path exists, the
    // detection must produce a dotted version and preflight must name the
    // same executable; elsewhere it must refuse as missing.
    try {
      const chrome = await detectInstalledChrome()
      expect(chrome.version).toMatch(/^\d+\./)
      expect(chrome.executablePath).toContain('Google Chrome')
      const checks = await preflight()
      expect(checks.executablePath).toBe(chrome.executablePath)
      expect(checks.chromeVersion).toBe(chrome.version)
    } catch (error) {
      expect(error).toBeInstanceOf(ProvisionRefusedError)
      expect((error as ProvisionRefusedError).refusal.kind).toBe('chrome-missing')
    }
  })
})
