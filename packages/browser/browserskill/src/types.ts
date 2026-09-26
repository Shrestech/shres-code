/**
 * Shared BrowserSkill vocabulary: branded cross-boundary ids, the lifecycle
 * state machine and its refusals, the operation records status exposes, the
 * synchronous start seam the gateway drives, and the owner-scoped command
 * results the tools consume. This module is types only; brands are applied
 * at their parse points (bsk JSON in the runner, the CDP extension id in the
 * Chrome session, token minting in the gateway, operation ids in the
 * supervisor).
 *
 * @module @shres-code/shres-code-browserskill/types
 */

import type { Branded } from '@shres-code/shres-code-brand'
import type { JsonValue, SessionId } from '@shres-code/shres-code-session/types'

/** One paired BrowserSkill browser instance, from bsk daemon status. */
export type BrowserInstanceId = Branded<'BrowserInstanceId'>

/** One bsk session this host started, from the bsk session start reply. */
export type BskSessionId = Branded<'BskSessionId'>

/** The loaded unpacked extension, from the CDP `Extensions.loadUnpacked` reply. */
export type ExtensionId = Branded<'ExtensionId'>

/** One-shot consent token binding one gateway verb; minted by the gateway's ledger. */
export type BrowserSkillToken = Branded<'BrowserSkillToken'>

/** One accepted lifecycle operation, observable through BrowserSkillStatus.operation. */
export type BrowserSkillOperationId = Branded<'BrowserSkillOperationId'>

/** The agent session that owns a bsk session; ownership is checked per call. */
export type SessionOwner = SessionId

/**
 * Lifecycle state of the managed browser stack. `ready` requires the evidence
 * chain: our daemon answers on the persisted port, our extension instance is
 * listed by it, and the id matches the one read from extension storage.
 */
export type BrowserSkillState = {
  kind: 'absent'
} | {
  kind: 'unsupported'
  reason: 'platform' | 'chrome-missing' | 'chrome-too-old'
  detail: string
} | {
  kind: 'provisioning'
  step: 'download' | 'verify' | 'extract'
} | {
  kind: 'provisioned'
} | {
  kind: 'starting'
} | {
  kind: 'ready'
  instanceId: BrowserInstanceId
} | {
  kind: 'disconnected'
} | {
  kind: 'failed'
  refusal: BrowserSkillRefusal
}

/** Why a lifecycle operation refused to proceed. Every member is user-displayable. */
export type BrowserSkillRefusal = {
  kind: 'endpoint-in-use'
  port: number
} | {
  kind: 'hash-mismatch'
  artifact: 'bsk' | 'extension' | 'executable'
  expected: string
  actual: string
} | {
  kind: 'download-failed'
  detail: string
} | {
  kind: 'extension-load-failed'
  detail: string
} | {
  kind: 'daemon-start-failed'
  detail: string
} | {
  kind: 'instance-mismatch'
} | {
  kind: 'unsupported-platform'
  detail: string
} | {
  kind: 'chrome-missing'
  detail: string
} | {
  kind: 'chrome-too-old'
  detail: string
} | {
  kind: 'command-lost'
  detail: string
} | {
  kind: 'owned-by-peer'
  pid: number
  /** Present when the refusal carries a manual recovery step beyond the pid. */
  detail?: string
} | {
  kind: 'operation-in-progress'
} | {
  kind: 'disposed'
  detail: string
} | {
  kind: 'shutdown-incomplete'
  detail: string
}

/** The pinned release assets whose download consent must disclose. */
export interface BrowserSkillConsentDownload {
  /** Which provisioned artifact this row installs. */
  artifact: 'bsk' | 'extension'
  /** Pinned upstream version. */
  version: string
  /** Exact release asset URL the download fetches. */
  url: string
  /** SHA-256 the bytes must match before anything is extracted. */
  sha256: string
}

/** The facts the Web UI consent flow displays, derived without network access. */
export interface BrowserSkillConsent {
  /** Pinned downloads for this platform; empty when the platform is unsupported. */
  downloads: readonly BrowserSkillConsentDownload[]
  /** The pinned extension's manifest `permissions`, recorded from the verified zip. */
  extensionPermissions: readonly string[]
  /** The pinned extension's manifest `host_permissions`. */
  extensionHostPermissions: readonly string[]
  /** Absolute owned root under the harness home. */
  installDir: string
  /** Absolute owned Chrome profile directory. */
  profileDir: string
  /** Effective update-manifest URL the daemon fetches metadata from. */
  updateManifestUrl: string
}

/** The lifecycle verbs a start accepts; `uninstall` alone carries the keep-profile choice. */
export type BrowserSkillVerb = 'provision' | 'open' | 'close' | 'reset' | 'uninstall'

/** One lifecycle operation as the UI observes it through status polling. */
export interface BrowserSkillOperation {
  /** Id minted by the runtime when it accepted the operation. */
  id: BrowserSkillOperationId
  /** Which lifecycle verb is running or has settled. */
  verb: BrowserSkillVerb
  /** Running until the operation settles; a previous operation's terminal state is never reused. */
  phase: 'running' | 'succeeded' | 'failed'
  /** Set only when `phase` is `'failed'`. */
  refusal?: BrowserSkillRefusal
}

/** What the gateway and UI read to render readiness, consent, and progress. */
export interface BrowserSkillStatus {
  /** Current lifecycle state. */
  state: BrowserSkillState
  /** The installed Chrome the owned profile runs, when detected. */
  chrome?: {
    version: string
  }
  /** Provisioned artifacts, when present on disk with verified hashes. */
  artifacts?: {
    bsk: {
      version: string
      sha256: string
    }
    extension: {
      version: string
      sha256: string
    }
  }
  /** Consent facts; derived from pins and config, never from the network. */
  consent: BrowserSkillConsent
  /** The most recent lifecycle operation; a fresh id is minted per accepted operation. */
  operation?: BrowserSkillOperation
}

/** The keep-profile choice only the uninstall start takes. */
export interface BrowserSkillStartOptions {
  /** Whether the owned profile and its sign-ins survive the uninstall. */
  keepProfile: boolean
}

/**
 * The synchronous verdict of one lifecycle start. On acceptance the operation
 * id is already reserved and published through status before the call
 * returns, and settled resolves the same terminal operation record status
 * reports (succeeded, or failed with its refusal) and never rejects. On
 * refusal no operation started: one is already in progress, including an
 * identical request, or the runtime is disposed.
 */
export type BrowserSkillStartResult =
  | {
    accepted: true
    /** Id of the accepted operation, already visible through status. */
    operationId: BrowserSkillOperationId
    /** Resolves the terminal operation; never rejects. */
    settled: Promise<BrowserSkillOperation>
  }
  | {
    accepted: false
    /** Why no operation started. */
    refusal: BrowserSkillRefusal
  }

/** The in-process control seam the gateway drives; the runtime implements it. */
export interface BrowserSkillControl {
  /** The fresh-page picture; never mutates anything. */
  status(): BrowserSkillStatus
  /** Start provision, open, close, or reset; provision runs provision-and-open. */
  start(verb: 'provision' | 'open' | 'close' | 'reset'): BrowserSkillStartResult
  /** Start the uninstall; the keep-profile choice is bound at acceptance. */
  start(verb: 'uninstall', options: BrowserSkillStartOptions): BrowserSkillStartResult
}

// ---- browserSkill wire namespace (the gesture-gated Remote surface) ----

/** The mutations a browserSkill user gesture can authorize. */
export type BrowserSkillGestureVerb = BrowserSkillVerb

/** Wire grant from browserSkill/begin: spendable on exactly one matching mutation. */
export interface BrowserSkillGestureGrant {
  /** Single-use token bound to the requested verb and keepProfile choice. */
  token: BrowserSkillToken
  /** ISO 8601 deadline after which the grant is dead. */
  expiresAt: string
}

/** Wire request for browserSkill/begin: the gesture to authorize. */
export interface BrowserSkillBeginRequest {
  /** The mutation verb to authorize. */
  verb: BrowserSkillGestureVerb
  /**
   * Profile retention bound to this token; omission means false. Only
   * uninstall permits true. Reset always deletes the owned profile and
   * its sign-ins, and the UI warns before minting the token.
   */
  keepProfile?: boolean
}

/** Wire request for browserSkill/provision, open, close, and reset. */
export interface BrowserSkillFlowRequest {
  /** Grant from begin with the matching verb. */
  token: BrowserSkillToken
}

/** Wire request for browserSkill/uninstall. */
export interface BrowserSkillUninstallRequest {
  /** Grant from begin('uninstall') bound to the same keepProfile choice. */
  token: BrowserSkillToken
  /** Whether the owned profile and its sign-ins survive the uninstall. */
  keepProfile: boolean
}

/**
 * Wire verdict of one spending method: the accepted operation's id, or the
 * refusal. The settled promise never crosses the wire; completion is
 * observed by polling status and matching the operation id.
 */
export type BrowserSkillStartOutcome =
  | { accepted: true; operationId: BrowserSkillOperationId }
  | { accepted: false; refusal: BrowserSkillRefusal }

/** Error codes thrown by the browserSkill gateway for caller misuse. */
export type BrowserSkillErrorCode =
  | 'gesture-refused'
  | 'invalid-verb-profile'

// ---- Owner-scoped command vocabulary (the tools seam) ----

/** Why a session command did not produce its value. */
export type BrowserSkillCommandFailure =
  | 'not-ready'
  | 'unknown-session'
  | 'invalid-argument'
  | 'instance-mismatch'
  | 'aborted'
  | 'command-failed'

/** Result of one owner-scoped session command, returned to the tool layer. */
export type BrowserSkillCommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BrowserSkillCommandFailure; detail: string }

/** Parsed `--json` output of one bsk command, passed through to the tool result. */
export interface BskOutput {
  json: JsonValue
}

/** One bounded browser interaction the runtime re-validates before spawning. */
export type BrowserAction =
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; value: string }
  | { kind: 'press'; key: string }
