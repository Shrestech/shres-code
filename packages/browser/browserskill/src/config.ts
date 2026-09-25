/**
 * Validated BrowserSkill deployment tunables. Every value that varies by
 * deployment is a field here, resolved once at plugin load; a bad value fails
 * loud instead of falling back. Fixed protocol constants (ports chosen by the
 * upstream daemon, storage keys, pinned hashes) live in
 * {@link ./runtime/manifest.ts} and stay out of config.
 *
 * @module @shres-code/shres-code-browserskill/config
 */

/** Caller-supplied spec; every field is optional and validated on resolve. */
export interface BrowserSkillConfigSpec {
  /**
   * Base URL that replaces the pinned release host for BOTH artifacts, so a
   * test or air-gapped deployment can serve byte-identical assets locally.
   * When unset the pinned absolute release URLs are used.
   */
  artifactBaseUrl?: string
  /**
   * Update-manifest URL passed to the daemon as `BSK_UPDATE_MANIFEST_URL`.
   * When unset the daemon uses its upstream default and still fetches update
   * metadata periodically; the pinned binary's default is recorded in the
   * manifest constants. Point this at a controlled endpoint in tests.
   */
  updateManifestUrl?: string
  /** Interval between owned-instance health probes while ready. */
  healthIntervalMs?: number
  /** Consecutive missed probes of our instance before the runtime closes. */
  healthMissLimit?: number
  /**
   * Deadline for one bounded bsk CLI invocation. Must cover a `status` call
   * with no connected browser, which waits five seconds for a browser plus a
   * two-second IPC slack before answering.
   */
  commandTimeoutMs?: number
  /** Deadline for the daemon to reach readiness after spawn. */
  daemonReadyTimeoutMs?: number
  /** Deadline for the owned Chrome launch, extension load, and instance pairing. */
  browserConnectTimeoutMs?: number
  /** Deadline for one artifact download. */
  downloadTimeoutMs?: number
  /** Upper bound on one downloaded artifact's bytes. */
  maxDownloadBytes?: number
}

/** Validated config the runtime consumes; construct through {@link resolveBrowserSkillConfig}. */
export interface ResolvedBrowserSkillConfig {
  /** Download base override; `undefined` uses the pinned release URLs. */
  artifactBaseUrl: URL | undefined
  /** Update-manifest override passed to the daemon; `undefined` uses the upstream default. */
  updateManifestUrl: URL | undefined
  healthIntervalMs: number
  healthMissLimit: number
  commandTimeoutMs: number
  daemonReadyTimeoutMs: number
  browserConnectTimeoutMs: number
  downloadTimeoutMs: number
  maxDownloadBytes: number
}

/**
 * Defaults backed by the measured bsk 0.3.1 release on macOS arm64: the
 * command timeout covers the measured seven-second status wait plus slack,
 * and the download bound sits far above the largest pinned asset
 * (5,244,474 bytes) while still bounding a hostile response.
 */
const DEFAULTS = {
  healthIntervalMs: 5_000,
  healthMissLimit: 2,
  commandTimeoutMs: 10_000,
  daemonReadyTimeoutMs: 30_000,
  browserConnectTimeoutMs: 30_000,
  downloadTimeoutMs: 60_000,
  maxDownloadBytes: 67_108_864,
} as const

/** Smallest command timeout that covers a status call's five-second browser wait plus IPC slack. */
const MIN_COMMAND_TIMEOUT_MS = 8_000

const MAX_TIMER_MS = 2_147_483_647

function requirePositiveInt(spec: number | undefined, name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const value = spec ?? fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`browserskill config: ${name} must be an integer from ${min} to ${max}, got ${String(value)}`)
  }
  return value
}

function requireHttpUrl(raw: string | undefined, name: string): URL | undefined {
  if (raw === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`browserskill config: ${name} must be an absolute http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`browserskill config: ${name} must be an absolute http(s) URL`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`browserskill config: ${name} must not contain credentials; URLs are disclosed in Settings`)
  }
  return parsed
}

/**
 * Resolve and validate the deployment spec. Throws at load for every invalid
 * field, naming the field without echoing URL values.
 * @param spec - cordis.yml-supplied values; omit fields to take the defaults.
 * @returns resolved deployment values for the runtime.
 */
export function resolveBrowserSkillConfig(spec: BrowserSkillConfigSpec = {}): ResolvedBrowserSkillConfig {
  return {
    artifactBaseUrl: requireHttpUrl(spec.artifactBaseUrl, 'artifactBaseUrl'),
    updateManifestUrl: requireHttpUrl(spec.updateManifestUrl, 'updateManifestUrl'),
    healthIntervalMs: requirePositiveInt(spec.healthIntervalMs, 'healthIntervalMs', DEFAULTS.healthIntervalMs, 1, MAX_TIMER_MS),
    healthMissLimit: requirePositiveInt(spec.healthMissLimit, 'healthMissLimit', DEFAULTS.healthMissLimit),
    commandTimeoutMs: requirePositiveInt(spec.commandTimeoutMs, 'commandTimeoutMs', DEFAULTS.commandTimeoutMs, MIN_COMMAND_TIMEOUT_MS, MAX_TIMER_MS),
    daemonReadyTimeoutMs: requirePositiveInt(spec.daemonReadyTimeoutMs, 'daemonReadyTimeoutMs', DEFAULTS.daemonReadyTimeoutMs, 1, MAX_TIMER_MS),
    browserConnectTimeoutMs: requirePositiveInt(spec.browserConnectTimeoutMs, 'browserConnectTimeoutMs', DEFAULTS.browserConnectTimeoutMs, 1, MAX_TIMER_MS),
    downloadTimeoutMs: requirePositiveInt(spec.downloadTimeoutMs, 'downloadTimeoutMs', DEFAULTS.downloadTimeoutMs, 1, MAX_TIMER_MS),
    maxDownloadBytes: requirePositiveInt(spec.maxDownloadBytes, 'maxDownloadBytes', DEFAULTS.maxDownloadBytes),
  }
}
