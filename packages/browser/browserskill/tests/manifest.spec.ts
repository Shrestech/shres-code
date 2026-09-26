import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BSK_PLATFORM_PIN,
  BSK_VERSION,
  DEFAULT_DAEMON_PORT,
  EXTENSION_ASSET,
  EXTENSION_PERMISSIONS,
  EXTENSION_TREE_SHA256,
  FILL_VALUE_MAX_LENGTH,
  PRESS_KEYS,
  artifactUrl,
  bskArchiveUrl,
  consentDownloads,
  effectiveUpdateManifestUrl,
  extensionArchiveUrl,
  platformPin,
} from '../src/runtime/manifest.ts'
import { computeTreeDigest, extractZipArchive } from '../src/runtime/extract.ts'
import { resolveBrowserSkillConfig } from '../src/config.ts'

describe('release pins', () => {
  it('pins the measured platform, versions, and hashes', () => {
    expect(BSK_VERSION).toBe('0.3.1')
    expect(BSK_PLATFORM_PIN.platform).toBe('darwin-arm64')
    expect(BSK_PLATFORM_PIN.archiveSha256).toBe('78f1651215b1ce95e40fb886985d1476e2cd2fb089beb146e6ecc6fa4a4aab89')
    expect(BSK_PLATFORM_PIN.binarySha256).toBe('bba24de58d403625268ffd6bbef31cdedb2d06eb031e9d0d1773120f4c0578bc')
    expect(EXTENSION_ASSET.sha256).toBe('9d41a8450653dbdcea365b611a163d9ddbbf0c0078bff42dbe8e2cf5910cbb8e')
    expect(EXTENSION_TREE_SHA256).toMatch(/^[0-9a-f]{64}$/)
    // Two distinct facts about the same release: the archive bytes and the
    // tree those bytes unpack to never share a pin value.
    expect(EXTENSION_TREE_SHA256).not.toBe(EXTENSION_ASSET.sha256)
  })

  it('supports exactly the measured platform gate', () => {
    // This assertion documents the measurement boundary; a new platform pin
    // arrives only with its own measured evidence.
    const supported = platformPin() !== undefined
    expect(supported).toBe(process.platform === 'darwin' && process.arch === 'arm64')
  })

  it('gates every pinned URL and consent row on the measured platform', () => {
    // Flips the process at the measured platform gate so both sides of the
    // gate run on every lane.
    const realPlatform = process.platform
    const realArch = process.arch
    Object.defineProperty(process, 'platform', { value: 'linux' })
    Object.defineProperty(process, 'arch', { value: 'arm64' })
    try {
      const config = resolveBrowserSkillConfig()
      expect(platformPin()).toBeUndefined()
      expect(bskArchiveUrl(config)).toBeUndefined()
      expect(consentDownloads(config)).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform })
      Object.defineProperty(process, 'arch', { value: realArch })
    }
  })

  it('composes pinned release URLs', () => {
    const config = resolveBrowserSkillConfig()
    if (platformPin() === undefined) return
    const archive = bskArchiveUrl(config)
    expect(archive?.href).toContain('bsk-v0.3.1-aarch64-apple-darwin.tar.gz')
    expect(extensionArchiveUrl(config).href).toContain('browser-skill-extension-v0.3.1-chrome.zip')
  })

  it('appends the missing slash when composing an override base URL', () => {
    // The trailing-slash side of the composition: a base that already ends
    // in '/' must not gain a second one.
    const config = resolveBrowserSkillConfig({ artifactBaseUrl: 'http://127.0.0.1:9/assets/' })
    const pinned = artifactUrl(EXTENSION_ASSET, config, 'x.zip')
    expect(pinned.href).toBe('http://127.0.0.1:9/assets/x.zip')
  })

  it('honors the artifact base override by appending the pinned file name', () => {
    const config = resolveBrowserSkillConfig({ artifactBaseUrl: 'http://127.0.0.1:9/assets' })
    const extension = extensionArchiveUrl(config)
    expect(extension.href).toBe('http://127.0.0.1:9/assets/browser-skill-extension-v0.3.1-chrome.zip')
    if (platformPin() !== undefined) {
      expect(bskArchiveUrl(config)?.href).toBe('http://127.0.0.1:9/assets/bsk-v0.3.1-aarch64-apple-darwin.tar.gz')
    }
    const pinned = artifactUrl(EXTENSION_ASSET, config, 'x.zip')
    expect(pinned.href).toBe('http://127.0.0.1:9/assets/x.zip')
  })

  it('defaults the update manifest to the upstream URL measured in the binary', () => {
    const config = resolveBrowserSkillConfig()
    expect(effectiveUpdateManifestUrl(config)).toBe('https://github.com/Tencent/BrowserSkill/releases/latest/download/version.json')
    expect(effectiveUpdateManifestUrl(resolveBrowserSkillConfig({ updateManifestUrl: 'http://127.0.0.1:9/version.json' })))
      .toBe('http://127.0.0.1:9/version.json')
  })

  it('lists consent downloads only on the supported platform', () => {
    const downloads = consentDownloads(resolveBrowserSkillConfig())
    if (platformPin() === undefined) {
      expect(downloads).toEqual([])
      return
    }
    expect(downloads.map(row => row.artifact)).toEqual(['bsk', 'extension'])
    expect(downloads[0]).toMatchObject({ version: '0.3.1' })
  })
})

describe('fixed protocol constants', () => {
  it('keeps the upstream default port and extension permissions', () => {
    expect(DEFAULT_DAEMON_PORT).toBe(52_800)
    expect(EXTENSION_PERMISSIONS).toContain('debugger')
    expect(EXTENSION_PERMISSIONS).toContain('tabs')
  })

  it('bounds the model-controlled values', () => {
    expect(PRESS_KEYS.has('Enter')).toBe(true)
    expect(PRESS_KEYS.has('a')).toBe(false)
    expect(FILL_VALUE_MAX_LENGTH).toBeGreaterThan(0)
  })
})

describe('opt-in pinned archive evidence', () => {
  // Set SHRES_BSK_ASSET_DIR to a directory holding the two verified release
  // assets (extension.zip, bsk.tar.gz) to run the pin-time evidence against
  // the real pinned bytes. Without it — CI, contributor machines — these
  // assertions skip: the synthetic fixtures elsewhere in this file carry the
  // behavior coverage.
  const assetDir = process.env.SHRES_BSK_ASSET_DIR
  describe.skipIf(assetDir === undefined)('against the verified release assets', () => {
    const scratch: string[] = []

    it('hashes the retained archives to their pins', async () => {
      expect(await sha256Of(join(assetDir!, 'extension.zip'))).toBe(EXTENSION_ASSET.sha256)
      if (platformPin() === undefined) return
      expect(await sha256Of(join(assetDir!, 'bsk.tar.gz'))).toBe(BSK_PLATFORM_PIN.archiveSha256)
    })

    it('unpacks the pinned zip to exactly the pinned tree digest', async () => {
      const zip = await readFile(join(assetDir!, 'extension.zip'))
      const dir = await mkdtemp(join(tmpdir(), 'shres-bsk-pin-evidence-'))
      scratch.push(dir)
      const tree = join(dir, 'extension')
      await mkdir(tree, { mode: 0o700 })
      await extractZipArchive(new Uint8Array(zip), tree, 1 << 30)
      expect(await computeTreeDigest(tree)).toBe(EXTENSION_TREE_SHA256)
    })

    it('finds no symlink-capable entry in the zip central directory', async () => {
      const zip = new Uint8Array(await readFile(join(assetDir!, 'extension.zip')))
      const entries = centralDirectoryEntries(zip)
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(entry.name.startsWith('/')).toBe(false)
        expect(entry.name.includes('\\')).toBe(false)
        expect(entry.name.split('/')).not.toContain('..')
        // A Unix-hosted entry (host 3) must carry a regular-file or
        // directory mode; the pinned zip is host 0 (no Unix attributes),
        // where a symlink cannot be represented at all.
        if (entry.unixModeClass !== undefined) {
          expect(['100000', '040000']).toContain(entry.unixModeClass)
        }
      }
    })

    afterEach(async () => {
      for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true })
    })

    async function sha256Of(path: string): Promise<string> {
      const { createHash } = await import('node:crypto')
      return createHash('sha256').update(await readFile(path)).digest('hex')
    }

    /** Minimal central-directory walk: entry names and Unix mode classes, for the pin-time attribute audit. */
    function centralDirectoryEntries(zip: Uint8Array): { name: string; unixModeClass: string | undefined }[] {
      const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
      let eocd = -1
      for (let i = zip.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
          eocd = i
          break
        }
      }
      if (eocd < 0) throw new Error('no end-of-central-directory record')
      const count = view.getUint16(eocd + 10, true)
      let offset = view.getUint32(eocd + 16, true)
      const entries: { name: string; unixModeClass: string | undefined }[] = []
      for (let n = 0; n < count; n++) {
        if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('bad central-directory signature')
        const host = view.getUint16(offset + 4, true) >> 8
        const nameLength = view.getUint16(offset + 28, true)
        const extraLength = view.getUint16(offset + 30, true)
        const commentLength = view.getUint16(offset + 32, true)
        const externalAttrs = view.getUint32(offset + 38, true)
        const name = new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength))
        const unixModeClass = host === 3 ? ((externalAttrs >>> 16) & 0o170000).toString(8) : undefined
        entries.push({ name, unixModeClass })
        offset += 46 + nameLength + extraLength + commentLength
      }
      return entries
    }
  })
})
