/**
 * Pinned BrowserSkill release facts, recorded in source from measured
 * evidence. Every hash here was computed from the exact release bytes: the
 * extension zip and the darwin-arm64 CLI archive were hashed locally and the
 * archive hash independently matches the upstream `version.json` entry; the
 * extracted binary hash comes from the verified pilot probe. Platform support
 * is initially darwin-arm64 only — the only platform with measured evidence —
 * and every other platform refuses before any download.
 *
 * @module @shres-code/shres-code-browserskill/runtime/manifest
 */

import type { ResolvedBrowserSkillConfig } from '../config.ts'
import type { BrowserSkillConsentDownload } from '../types.ts'

/** Pinned bsk CLI version. */
export const BSK_VERSION = '0.3.1'

/** Pinned Chrome extension version. */
export const EXTENSION_VERSION = '0.3.1'

/** Upstream release tag carrying the CLI archives. */
export const BSK_RELEASE_TAG = `cli-v${BSK_VERSION}`

/** Upstream release tag carrying the extension zip. */
export const EXTENSION_RELEASE_TAG = `ext-v${EXTENSION_VERSION}`

/**
 * The extension's fallback and the daemon's default port. It is never probed
 * and never contacted: during startup the runtime holds it atomically so no
 * extension instance can reach a foreign daemon on it, and releases it once
 * the owned instance is ready.
 */
export const DEFAULT_DAEMON_PORT = 52_800

/** Label written into extension storage and required on the daemon's browser listing. */
export const BSK_OWNED_LABEL = 'shres-managed'

/** Extension storage keys, as read from the pinned extension's source. */
export const EXTENSION_STORAGE_KEYS = {
  daemonPort: 'bsk_daemon_port',
  label: 'bh_label',
  instanceId: 'bsk_instance_id',
} as const

/** Shape of a bsk browser instance id, as the daemon and extension mint them. */
export const BSK_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}$/

/** Shape of an observe/snapshot ref the tools pass; enforced by the runtime. */
export const BSK_REF_PATTERN = /^@e[0-9]+$/

/** The only keys `press` accepts; anything else is refused before spawning. */
export const PRESS_KEYS: ReadonlySet<string> = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
])

/** Longest `fill` value the runtime passes through. */
export const FILL_VALUE_MAX_LENGTH = 10_000

/** Chrome release required by the pinned extension's manifest. */
export const CHROME_MINIMUM_MAJOR = 125

/** The pinned extension's `permissions`, recorded from the verified zip's manifest. */
export const EXTENSION_PERMISSIONS: readonly string[] = [
  'alarms', 'activeTab', 'debugger', 'downloads', 'idle',
  'notifications', 'scripting', 'tabs', 'storage', 'webNavigation', 'windows',
]

/** The pinned extension's `host_permissions`. */
export const EXTENSION_HOST_PERMISSIONS: readonly string[] = ['<all_urls>']

/**
 * Upstream endpoint the daemon fetches update metadata from, measured in the
 * pinned binary. This is NOT an artifact URL: the daemon consults it even
 * with `BSK_AUTO_UPDATE=off` (which only stops binary self-replacement).
 */
export const DEFAULT_UPDATE_MANIFEST_URL = 'https://github.com/Tencent/BrowserSkill/releases/latest/download/version.json'

/**
 * The exact pinned CLI archive URL for darwin-arm64. The pinned version never
 * resolves through `releases/latest`; an artifact mirror replaces it only via
 * the config's `artifactBaseUrl`.
 */
export const BSK_ARCHIVE_URL = 'https://github.com/Tencent/BrowserSkill/releases/download/cli-v0.3.1/bsk-v0.3.1-aarch64-apple-darwin.tar.gz'

/** One pinned release asset: exact URL and the SHA-256 the bytes must match. */
export interface PinnedArtifact {
  url: string
  sha256: string
}

/**
 * The pinned CLI archive for darwin-arm64. The archive hash matches both the
 * local hash of the verified asset and upstream's `version.json`; the binary
 * hash is the extracted executable the probe verified, rechecked before every
 * spawn.
 */
export const BSK_DARWIN_ARM64_ASSET = 'bsk-v0.3.1-aarch64-apple-darwin.tar.gz'

/** Platform pin for the only measured platform. */
export interface BskPlatformPin {
  /** Platform gate key: `process.platform`-`process.arch`. */
  platform: 'darwin-arm64'
  /** Release asset file name under the CLI release tag. */
  assetName: string
  /** SHA-256 of the archive bytes. */
  archiveSha256: string
  /** SHA-256 of the extracted executable, rechecked before every spawn. */
  binarySha256: string
}

/** The only platform with measured evidence; everything else refuses before download. */
export const BSK_PLATFORM_PIN: BskPlatformPin = {
  platform: 'darwin-arm64',
  assetName: BSK_DARWIN_ARM64_ASSET,
  archiveSha256: '78f1651215b1ce95e40fb886985d1476e2cd2fb089beb146e6ecc6fa4a4aab89',
  binarySha256: 'bba24de58d403625268ffd6bbef31cdedb2d06eb031e9d0d1773120f4c0578bc',
}

/**
 * The exact pinned extension release zip URL, with the locally measured
 * SHA-256 of that asset, verified byte-identical to the release download.
 */
export const EXTENSION_ASSET: PinnedArtifact = {
  url: 'https://github.com/Tencent/BrowserSkill/releases/download/ext-v0.3.1/browser-skill-extension-v0.3.1-chrome.zip',
  sha256: '9d41a8450653dbdcea365b611a163d9ddbbf0c0078bff42dbe8e2cf5910cbb8e',
}

/**
 * SHA-256 over the pinned extension's unpacked file tree, the pin every
 * launch verifies the loaded directory against. The digest covers exactly
 * the tree's regular files: each record is the POSIX-relative path, a NUL,
 * the file's SHA-256, and a newline; records sorted by the UTF-8 bytes of
 * the POSIX-relative paths (Unicode code-point order; no locale).
 * It is computed from the same verified archive bytes as
 * {@link EXTENSION_ASSET}; a symlink or special file in the tree is a
 * verification failure, never a digest input. The state record stores this
 * digest only as a receipt — the manifest pin is the trust anchor.
 */
export const EXTENSION_TREE_SHA256 = '5219928bf1f28edafff4082e6d2cde93bfaad2e54e96c10e22906bed83684662'

/**
 * Resolve the platform pin for the running process.
 * @returns the pin when the platform is the measured one, else `undefined`.
 */
export function platformPin(): BskPlatformPin | undefined {
  if (`${process.platform}-${process.arch}` === BSK_PLATFORM_PIN.platform) return BSK_PLATFORM_PIN
  return undefined
}

/**
 * Compose the download URL for a pinned asset. The default is the pinned
 * absolute URL; an artifact mirror replaces it only when the config sets
 * `artifactBaseUrl`, appending the same pinned file name.
 * @param pinned - the pinned artifact whose URL is the default.
 * @param config - resolved config; its `artifactBaseUrl` may replace the host.
 * @param assetName - release asset file name to append on override.
 * @returns the absolute URL the download fetches.
 */
export function artifactUrl(pinned: PinnedArtifact, config: ResolvedBrowserSkillConfig, assetName: string): URL {
  if (config.artifactBaseUrl !== undefined) {
    const base = config.artifactBaseUrl.href.endsWith('/') ? config.artifactBaseUrl.href : `${config.artifactBaseUrl.href}/`
    return new URL(assetName, base)
  }
  return new URL(pinned.url)
}

/**
 * The CLI archive download URL for the running platform: the exact pinned
 * URL, or the mirror's copy of the same file name.
 * @param config - resolved config.
 * @returns the URL, or `undefined` when the platform has no pin.
 */
export function bskArchiveUrl(config: ResolvedBrowserSkillConfig): URL | undefined {
  const pin = platformPin()
  if (pin === undefined) return undefined
  return artifactUrl({ url: BSK_ARCHIVE_URL, sha256: pin.archiveSha256 }, config, pin.assetName)
}

/**
 * The extension zip download URL.
 * @param config - resolved config.
 * @returns the URL.
 */
export function extensionArchiveUrl(config: ResolvedBrowserSkillConfig): URL {
  // The pinned URL always ends in the asset file name; substring is total.
  const assetName = EXTENSION_ASSET.url.substring(EXTENSION_ASSET.url.lastIndexOf('/') + 1)
  return artifactUrl(EXTENSION_ASSET, config, assetName)
}

/**
 * Effective update-manifest URL the daemon is told to fetch.
 * @param config - resolved config.
 * @returns the config override, else the upstream default.
 */
export function effectiveUpdateManifestUrl(config: ResolvedBrowserSkillConfig): string {
  return config.updateManifestUrl?.href ?? DEFAULT_UPDATE_MANIFEST_URL
}

/**
 * Consent download rows for the running platform, in disclosure order.
 * @param config - resolved config, for the artifact-base override.
 * @returns both rows on the measured platform; empty elsewhere.
 */
export function consentDownloads(config: ResolvedBrowserSkillConfig): readonly BrowserSkillConsentDownload[] {
  const archive = bskArchiveUrl(config)
  if (archive === undefined) return []
  return [
    { artifact: 'bsk', version: BSK_VERSION, url: archive.href, sha256: BSK_PLATFORM_PIN.archiveSha256 },
    { artifact: 'extension', version: EXTENSION_VERSION, url: extensionArchiveUrl(config).href, sha256: EXTENSION_ASSET.sha256 },
  ]
}
