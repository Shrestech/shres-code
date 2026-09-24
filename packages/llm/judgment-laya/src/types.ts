/**
 * Composition and lifecycle types for the local Laya judgment provider.
 *
 * @module @shres-code/shres-code-judgment-laya/types
 */

/** The pinned checkpoint the local gateway serves. */
export interface LayaJudgmentModel {
  /** Hugging Face repository, `owner/name`. */
  repo: string
  /** 40-character commit sha of the pinned revision. */
  revision: string
  /**
   * SHA-256 of the exact bytes of the gateway project's
   * `manifests/<revision>.json`, which pins every checkpoint file's digest.
   */
  manifestSha256: string
}

/** Crash-restart budget for the supervised gateway. */
export interface LayaRestartPolicy {
  /** Restarts allowed inside one {@link windowMs}; one more leaves the gateway unavailable. */
  maxRestarts?: number
  /** Sliding window over which restarts are counted, in milliseconds. */
  windowMs?: number
  /** First restart delay; each consecutive failure doubles it. */
  backoffMs?: number
  /** Largest restart delay. */
  maxBackoffMs?: number
}

/** Configuration for the supervised local Laya judgment gateway. */
export interface LayaJudgmentConfig {
  /** The pinned checkpoint and its manifest digest. */
  model: LayaJudgmentModel
  /** Token window of the pinned checkpoint; the gateway must report the same limit. */
  checkpointContext: 512 | 1024
  /** Inference precision passed to laya-mlx. */
  dtype?: 'float16' | 'float32'
  /** Absolute directory holding the virtual environment, its uv-managed Python, the uv package cache, and the install marker. */
  runtimeDir?: string
  /** Absolute Hugging Face home holding downloaded checkpoints. */
  hfHome?: string
  /** Absolute path of the `python/laya-gateway` project. */
  gatewayProject?: string
  /** `uv` executable: an absolute path or a name on PATH. */
  uvPath?: string
  /** Version of the uv-managed CPython the virtual environment uses, `major.minor`. */
  python?: string
  /** Questions per gateway inference batch. */
  batchSize?: number
  /** Deadline for the first readiness line, health check, and smoke ask, in milliseconds. */
  startupTimeoutMs?: number
  /** Deadline for one judgment request, in milliseconds. */
  requestTimeoutMs?: number
  /** SIGTERM-to-SIGKILL grace when stopping the gateway, in milliseconds. */
  shutdownGraceMs?: number
  /** Deadline for each install step, in milliseconds. */
  installTimeoutMs?: number
  /** Maximum serialized UTF-8 request body, enforced by both the provider and the gateway. */
  maxRequestBytes?: number
  /** Maximum response body accepted from the gateway. */
  maxResponseBytes?: number
  /** Crash-restart budget. */
  restart?: LayaRestartPolicy
}

/** Lifecycle state of the supervised gateway. */
export type LayaGatewayState =
  | 'starting'
  | 'ready'
  | 'unavailable'
  | 'not-installed'
  | 'unsupported-host'
  | 'stopped'

/** One published gateway status; `detail` explains every state except `ready`. */
export interface LayaGatewayStatus {
  /** Current lifecycle state. */
  readonly state: LayaGatewayState
  /** Human-readable reason, naming the next action where there is one. */
  readonly detail?: string
}

/** Facts about the last gateway process exit, recorded independently of one another. */
export interface LayaGatewayExit {
  /** Exit code; null when a signal ended the process. */
  readonly exitCode: number | null
  /** Terminating signal; null on a normal exit. */
  readonly signal: string | null
  /** Whether the supervisor stopped the process for missing its startup deadline. */
  readonly timedOut: boolean
  /** Last bytes of stderr, bounded to 8 KiB. */
  readonly stderrTail: string
}

/** What one successful install produced. */
export interface LayaInstallResult {
  /** Directory holding the verified checkpoint files. */
  readonly modelDir: string
  /** SHA-256 of the manifest the files were verified against. */
  readonly manifestSha256: string
  /** SHA-256 of the gateway's `uv.lock` the environment was synced from. */
  readonly lockSha256: string
}
