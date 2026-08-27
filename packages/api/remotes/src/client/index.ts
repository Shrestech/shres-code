/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from '@shres-code/cordis'
import commandsRemote from '@shres-code/shres-code-commands/remote'
import goalsRemote from '@shres-code/shres-code-goal/remote'
import dynamicRemote from '@shres-code/shres-code-cordis-host-runner/remote'
import pluginInventoryRemote from '@shres-code/shres-code-host-plugin-inventory/remote'
import messageFeedbackRemote from '@shres-code/shres-code-message-feedback/remote'
import speechRemote from '@shres-code/shres-code-speech/remote'
import shieldRemote from '@shres-code/shres-code-shield/remote'
import type { TypertClientRemote } from '@shres-code/shres-code-typert-protocol'

export type { TypertClientRemote as ClientRemote } from '@shres-code/shres-code-typert-protocol'
export type { PluginInventorySnapshot } from '@shres-code/shres-code-host-plugin-inventory/types'
export type {
  ShieldCounterSplit, ShieldDefinitions, ShieldFindingSummary, ShieldPayloadInfo,
  ShieldPayloadUpdate, ShieldReason, ShieldRepoStats, ShieldRuleHistogram,
  ShieldSnapshot, ShieldStatus, ShieldUpdateBlocked,
} from '@shres-code/shres-code-shield/types'
export type {} from '@shres-code/shres-code-commands/remote'
export type {} from '@shres-code/shres-code-goal/remote'
export type {} from '@shres-code/shres-code-host-plugin-inventory/remote'
export type {} from '@shres-code/shres-code-message-feedback/remote'
export type {} from '@shres-code/shres-code-speech/remote'
export type {} from '@shres-code/shres-code-shield/remote'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypertRemoteEvent` is `never` and every `$on` call fails.
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
export type {} from '@shres-code/shres-code-commands/types'
export type {} from '@shres-code/shres-code-cordis-host-runner/types'
export type {} from '@shres-code/shres-code-credentials/types'
export type {} from '@shres-code/shres-code-llm/types'
export type {} from '@shres-code/shres-code-agent-presets/types'
export type {} from '@shres-code/shres-code-settings/types'

/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ClientResponse, ConfigurableProviderView, ConnectionHandle, ConnectionSinks, ContentBlock,
  CredentialView, DirectoryListing, DiscoveredModelView, HistoryEntry, HostFrame, IApiClient,
  MessageId, ModelCatalogFailure, ModelProviderGroup, ModelReasoningEffort, ModelSelection,
  MuxFrame, PromptContentPart, QuestionResponsePayload, QueueAction, RpcError, RpcId, RpcReceipt,
  RpcRequest, RpcResponse, RpcResult, SessionId, SessionModels, SessionSearchItem,
  SessionSummary, SettingsNamespaceView, SettingsPathOpView, SkillEntry, StreamChunk,
  SubagentAddress, SubagentCatalog, JobView, ToolCallView, ToolEventView, ToolResultView,
  WorkspaceId, WorkspaceView,
} from '@shres-code/shres-code-client-connection/client'
export type {} from '@shres-code/shres-code-api-gateway/client'
export type {} from '@shres-code/shres-code-cordis-host-runner/remote'

// The payload vocabulary of the selected namespaces, re-exported so a Client
// contribution can name what it sends and receives without importing a Host
// package: this assembly is the one place both planes legitimately meet.
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@shres-code/shres-code-cordis-host-runner/types'
// The JSON vocabulary those payloads are built from, re-exported for the same
// reason: a Client contribution names what it sends without importing a Host
// package, and this assembly is where both planes legitimately meet.
export type { JsonValue } from '@shres-code/shres-code-session/types'

declare module '@shres-code/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: TypertClientRemote
  }
}

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      commandsRemote, goalsRemote, dynamicRemote, pluginInventoryRemote, messageFeedbackRemote,
      speechRemote, shieldRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // Unwound in reverse mount order, so a namespace never outlives one mounted
  // after it.
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
