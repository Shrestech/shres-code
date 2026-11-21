/** The pin check compares source constants with the recorded measurement and reports drift. */
import { describe, expect, it } from 'vitest'
import { reportDrift, verifyPins } from './check-browserskill-pins.ts'

const evidence = {
  schemaVersion: 1 as const,
  entries: [{
    bskVersion: '0.5.0',
    extensionVersion: '0.5.0',
    platform: 'darwin-arm64',
    bsk: {
      assetName: 'bsk-v0.5.0-aarch64-apple-darwin.tar.gz',
      archiveSha256: 'a'.repeat(64),
      binarySha256: 'b'.repeat(64),
    },
    extension: {
      assetName: 'browser-skill-extension-v0.5.0-chrome.zip',
      archiveSha256: 'c'.repeat(64),
      treeSha256: 'd'.repeat(64),
      permissions: ['tabs', 'storage'],
    },
  }],
}

const manifest = [
  "export const BSK_VERSION = '0.5.0'",
  "export const EXTENSION_VERSION = '0.5.0'",
  "export const BSK_DARWIN_ARM64_ASSET = 'bsk-v0.5.0-aarch64-apple-darwin.tar.gz'",
  "export const BSK_ARCHIVE_URL = 'https://example.invalid/cli-v0.5.0/bsk-v0.5.0-aarch64-apple-darwin.tar.gz'",
  "export const EXTENSION_TREE_SHA256 = '" + 'd'.repeat(64) + "'",
  "export const EXTENSION_PERMISSIONS: readonly string[] = ['tabs', 'storage']",
  'export const BSK_PLATFORM_PIN: BskPlatformPin = {',
  "  platform: 'darwin-arm64',",
  "  assetName: 'bsk-v0.5.0-aarch64-apple-darwin.tar.gz',",
  "  archiveSha256: '" + 'a'.repeat(64) + "',",
  "  binarySha256: '" + 'b'.repeat(64) + "',",
  '}',
  'export const EXTENSION_ASSET: PinnedArtifact = {',
  "  url: 'https://example.invalid/ext-v0.5.0/browser-skill-extension-v0.5.0-chrome.zip',",
  "  sha256: '" + 'c'.repeat(64) + "',",
  '}',
].join('\n')

describe('verifyPins', () => {
  it('accepts pins that match the recorded measurement', () => {
    expect(verifyPins(manifest, evidence)).toEqual([])
  })

  it('rejects a hash that disagrees with the evidence', () => {
    const drifted = manifest.replace('binarySha256: ' + "'" + 'b'.repeat(64) + "'", "binarySha256: '" + 'e'.repeat(64) + "'")
    expect(verifyPins(drifted, evidence)).toEqual([
      'bsk binary: manifest ' + 'e'.repeat(64) + ' != evidence ' + 'b'.repeat(64),
    ])
  })

  it('rejects a release pair with no evidence entry', () => {
    expect(verifyPins(manifest.replace("BSK_VERSION = '0.5.0'", "BSK_VERSION = '0.6.0'"), evidence))
      .toEqual(['no evidence entry for bsk 0.6.0 / extension 0.5.0'])
  })
})

describe('reportDrift', () => {
  const fetchWith = (tags: string[]) => (async () => ({
    ok: true,
    json: async () => tags.map(tag_name => ({ tag_name })),
  })) as unknown as typeof fetch

  it('reports current when the pins name the newest pair', async () => {
    const { lines } = await reportDrift(fetchWith(['cli-v0.5.0', 'ext-v0.5.0']), evidence)
    expect(lines).toContain('current: the pins name the newest upstream release pair')
  })

  it('names each family that trails upstream', async () => {
    const { lines } = await reportDrift(fetchWith(['cli-v0.6.0', 'ext-v0.5.0']), evidence)
    expect(lines.some(line => line.includes('the CLI pin trails cli-v0.6.0'))).toBe(true)
    expect(lines.some(line => line.includes('current:'))).toBe(false)
  })
})
