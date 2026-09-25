# Browser automation

Reference for the lifecycle and tool data declared by [shres-browserskill](../../packages/browser/browserskill/README.md). The host plugin contributes native tools and a guide; [ui-browserskill](../../packages/client/ui-browserskill/README.md) consumes its loopback-pinned browserSkill RPC namespace. The runtime is supplied directly to the gateway, not exposed as a Context service.

Source: [shared types](../../packages/browser/browserskill/src/types.ts). Provisioning, supported platforms, process ownership, configuration, and failure recovery belong to the [package reference](../../packages/browser/browserskill/README.md).

## Identities

```ts type-equiv
/** One paired BrowserSkill browser instance, from bsk daemon status. */
type BrowserInstanceId = Branded<'BrowserInstanceId'>
```

```ts type-equiv
/** One bsk session this host started, from the bsk session start reply. */
type BskSessionId = Branded<'BskSessionId'>
```

```ts type-equiv
/** The loaded unpacked extension, from the CDP `Extensions.loadUnpacked` reply. */
type ExtensionId = Branded<'ExtensionId'>
```

```ts type-equiv
/** One-shot consent token binding one gateway verb; minted by the gateway's ledger. */
type BrowserSkillToken = Branded<'BrowserSkillToken'>
```

```ts type-equiv
/** One accepted lifecycle operation, observable through BrowserSkillStatus.operation. */
type BrowserSkillOperationId = Branded<'BrowserSkillOperationId'>
```

```ts type-equiv
/** The agent session that owns a bsk session; ownership is checked per call. */
type SessionOwner = SessionId
```

## Readiness, consent, and operation records

```ts type-equiv
/**
 * Lifecycle state of the managed browser stack. `ready` requires the evidence
 * chain: our daemon answers on the persisted port, our extension instance is
 * listed by it, and the id matches the one read from extension storage.
 */
type BrowserSkillState = {
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
```

```ts type-equiv
/** Why a lifecycle operation refused to proceed. Every member is user-displayable. */
type BrowserSkillRefusal = {
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
```

```ts type-equiv
/** The pinned release assets whose download consent must disclose. */
interface BrowserSkillConsentDownload {
  /** Which provisioned artifact this row installs. */
  artifact: 'bsk' | 'extension'
  /** Pinned upstream version. */
  version: string
  /** Exact release asset URL the download fetches. */
  url: string
  /** SHA-256 the bytes must match before anything is extracted. */
  sha256: string
}
```

```ts type-equiv
/** The facts the Web UI consent flow displays, derived without network access. */
interface BrowserSkillConsent {
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
```

```ts type-equiv
/** The lifecycle verbs a start accepts; `uninstall` alone carries the keep-profile choice. */
type BrowserSkillVerb = 'provision' | 'open' | 'close' | 'reset' | 'uninstall'
```

```ts type-equiv
/** One lifecycle operation as the UI observes it through status polling. */
interface BrowserSkillOperation {
  /** Id minted by the runtime when it accepted the operation. */
  id: BrowserSkillOperationId
  /** Which lifecycle verb is running or has settled. */
  verb: BrowserSkillVerb
  /** Running until the operation settles; a previous operation's terminal state is never reused. */
  phase: 'running' | 'succeeded' | 'failed'
  /** Set only when `phase` is `'failed'`. */
  refusal?: BrowserSkillRefusal
}
```

```ts type-equiv
/** What the gateway and UI read to render readiness, consent, and progress. */
interface BrowserSkillStatus {
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
```

## In-process lifecycle control

Acceptance reserves an operation synchronously. The gateway serializes the verdict and operation id, never the settlement promise; clients match the id against the terminal status record.

```ts type-equiv
/** The keep-profile choice only the uninstall start takes. */
interface BrowserSkillStartOptions {
  /** Whether the owned profile and its sign-ins survive the uninstall. */
  keepProfile: boolean
}
```

```ts type-equiv
/**
 * The synchronous verdict of one lifecycle start. On acceptance the operation
 * id is already reserved and published through status before the call
 * returns, and settled resolves the same terminal operation record status
 * reports (succeeded, or failed with its refusal) and never rejects. On
 * refusal no operation started: one is already in progress, including an
 * identical request, or the runtime is disposed.
 */
type BrowserSkillStartResult =
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
```

```ts type-equiv
/** The in-process control seam the gateway drives; the runtime implements it. */
interface BrowserSkillControl {
  /** The fresh-page picture; never mutates anything. */
  status(): BrowserSkillStatus
  /** Start provision, open, close, or reset; provision runs provision-and-open. */
  start(verb: 'provision' | 'open' | 'close' | 'reset'): BrowserSkillStartResult
  /** Start the uninstall; the keep-profile choice is bound at acceptance. */
  start(verb: 'uninstall', options: BrowserSkillStartOptions): BrowserSkillStartResult
}
```

## Owner-scoped tool commands

```ts type-equiv
/** Why a session command did not produce its value. */
type BrowserSkillCommandFailure =
  | 'not-ready'
  | 'unknown-session'
  | 'invalid-argument'
  | 'instance-mismatch'
  | 'aborted'
  | 'command-failed'
```

```ts type-equiv
/** Result of one owner-scoped session command, returned to the tool layer. */
type BrowserSkillCommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BrowserSkillCommandFailure; detail: string }
```

```ts type-equiv
/** Parsed `--json` output of one bsk command, passed through to the tool result. */
interface BskOutput {
  json: JsonValue
}
```

```ts type-equiv
/** One bounded browser interaction the runtime re-validates before spawning. */
type BrowserAction =
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; value: string }
  | { kind: 'press'; key: string }
```

## Management gateway vocabulary

```ts type-equiv
/** The mutations a browserSkill user gesture can authorize. */
type BrowserSkillGestureVerb = BrowserSkillVerb
```

```ts type-equiv
/** Wire grant from browserSkill/begin: spendable on exactly one matching mutation. */
interface BrowserSkillGestureGrant {
  /** Single-use token bound to the requested verb and keepProfile choice. */
  token: BrowserSkillToken
  /** ISO 8601 deadline after which the grant is dead. */
  expiresAt: string
}
```

```ts type-equiv
/** Wire request for browserSkill/begin: the gesture to authorize. */
interface BrowserSkillBeginRequest {
  /** The mutation verb to authorize. */
  verb: BrowserSkillGestureVerb
  /**
   * Profile retention bound to this token; omission means false. Only
   * uninstall permits true. Reset always deletes the owned profile and
   * its sign-ins, and the UI warns before minting the token.
   */
  keepProfile?: boolean
}
```

```ts type-equiv
/** Wire request for browserSkill/provision, open, close, and reset. */
interface BrowserSkillFlowRequest {
  /** Grant from begin with the matching verb. */
  token: BrowserSkillToken
}
```

```ts type-equiv
/** Wire request for browserSkill/uninstall. */
interface BrowserSkillUninstallRequest {
  /** Grant from begin('uninstall') bound to the same keepProfile choice. */
  token: BrowserSkillToken
  /** Whether the owned profile and its sign-ins survive the uninstall. */
  keepProfile: boolean
}
```

```ts type-equiv
/**
 * Wire verdict of one spending method: the accepted operation's id, or the
 * refusal. The settled promise never crosses the wire; completion is
 * observed by polling status and matching the operation id.
 */
type BrowserSkillStartOutcome =
  | { accepted: true; operationId: BrowserSkillOperationId }
  | { accepted: false; refusal: BrowserSkillRefusal }
```

```ts type-equiv
/** Error codes thrown by the browserSkill gateway for caller misuse. */
type BrowserSkillErrorCode =
  | 'gesture-refused'
  | 'invalid-verb-profile'
```
