# Agent Teams

Types shared by the implicit-root Team domain. The [runtime note](../../.agents/notes/implemented/feature/2026-09-11-agent-teams-runtime-and-seats.md) owns live provisioning and steer delivery; the [vocabulary note](../../.agents/notes/implemented/feature/2026-09-10-agent-teams-durable-vocabulary.md) owns identity and replay; this page records the literal durable forms from [`packages/team/agent-team/src/types.ts`](../../packages/team/agent-team/src/types.ts). The [package README](../../packages/team/agent-team/README.md) owns operation, recovery, and limit behavior.

## Identity and roster

`TeamId` is the root `SessionId` under a distinct [brand](core.md#branded-ids). `TeamTaskId` is Team-local and monotonically allocated as `task-<n>`; `TeamMessageId` is globally random. A teammate's Session id remains its persistent identity, while `name` is an immutable model/UI label.

```ts type-equiv
/** Whole durable value written on every teammate lifecycle change. */
interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}
```

Every member starts in `provisioning` and reaches exactly one terminal roster phase, `active` or `failed`. Runtime `running`/`idle`/`inactive` status is derived separately and never rewrites this record.

## Durable mailbox

The Lead Session first stores the complete queued message. A target receipt is acknowledged only after its pending inbox item or recorded user message is durable, leaving queued-minus-delivered as the recovery mailbox.

```ts type-equiv
/** One peer message retained until its target Session records it. */
interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}
```

The target Session keeps message identity and sender attribution on the eventual user message. Folding that source across inbox and history is the target-side de-duplication key.

```ts type-equiv
/**
 * Source retained by the target Session for durable mailbox de-duplication.
 * Delivery writes this on an ordinary `user/message` in the TARGET session;
 * the Lead log never reconstructs the model-visible content.
 */
interface TeamMessageSource {
  readonly kind: 'team-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderSessionId: SessionId
  readonly senderName: string
}
```

## Shared task DAG

Every task event stores a complete snapshot. `revision` is the compare-and-set value and increments by one per mutation. `blockedBy` edges must name non-deleted tasks and keep the graph acyclic. `writeScopes` are normalized advisory path prefixes rather than locks.

```ts type-equiv
/** Whole durable task snapshot; every mutation increments {@link revision}. */
interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}
```

`pending` is unstarted or released, `in_progress` carries an owner, `completed` satisfies blockers, and `deleted` is a retained tombstone.

## Runtime

`ctx.agentTeams` provisions continuable teammates, lists the roster, and steers peer mail. The [package README](../../packages/team/agent-team/README.md) owns operation and recovery.

```ts type-equiv
/** Caller identity inside one implicit Team. */
interface TeamMembership {
  readonly root: Agent
  readonly id: TeamId
  readonly role: 'lead' | 'teammate'
  readonly name: string
}
```

```ts type-equiv
/** Current runtime-enriched roster row. */
interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'idle' | 'inactive' | 'provisioning' | 'failed'
  readonly description?: string
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  readonly model?: string
  readonly diagnostics: string[]
}
```

```ts type-equiv
/** Input for creating one durable teammate. */
interface SpawnTeammateRequest {
  readonly name: string
  readonly description: string
  readonly prompt: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  readonly provider: string
  readonly signal: AbortSignal
  readonly persona?: string
  /**
   * Optional teammate workspace. Becomes the child's session cwd on first
   * provision. Whitespace is omitted; a non-empty value must be an enterable
   * absolute directory.
   */
  readonly cwd?: string
  /**
   * Durable source for the child's initial inbox message. Omitted is an
   * ordinary user prompt.
   */
  readonly source?: MessageSource
  readonly agentOptions?: { readonly provider?: string; readonly model?: string }
}
```

```ts type-equiv
/** Result after one teammate reaches a durable active or failed edge. */
interface SpawnTeammateResult {
  readonly member: TeamMemberView
}
```

```ts type-equiv
/** Input for one durable peer message. */
interface SendTeamMessageRequest {
  readonly target: string
  readonly content: ContentBlock[]
  readonly signal: AbortSignal
  /**
   * Lead-sent role for first provision. Shadows the child's `deployment:persona`.
   * Tool guidance, team policy, and the working-directory line stay. Ignored
   * after the teammate is active.
   */
  readonly persona?: string
  /**
   * Optional teammate workspace for first provision. Becomes the child's
   * session cwd and AGENTS.md root. Whitespace is omitted. A non-empty value
   * after the teammate is active is rejected.
   */
  readonly cwd?: string
}
```

```ts type-equiv
/** Result after a peer message enters the durable mailbox. */
interface SendTeamMessageResult {
  readonly messageId: TeamMessageId
  readonly status: 'accepted' | 'queued'
}
```

```ts type-equiv
/** Human-configured teammate that can be lazily provisioned. */
interface TeamRosterTemplateEntry {
  readonly name: string
  readonly description: string
  readonly persona?: string
  readonly provider: string
  readonly model?: string
  readonly context?: 'fresh' | 'fork'
}
```

## Replay

`foldTeam(rootId, events)` replays one root Session into the roster, task board, and queued-minus-delivered mailbox that later Team operations read. It selects records by `TeamId`, so events inherited by an ordinary fork retain the ancestor id and never enter the new root's state. Session event `seq` and `time` remain the ordering and timing record; Team snapshots do not duplicate them. The `agentTeam` projection unit folds every Team present in a Session log, keyed by `teamId`; callers select the projected Session's own Team with `values.agentTeam?.[session.id]`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams service backed by the exact live Lead Session log.

```ts cordis-catalog
/**
 * Resolve one exact live Agent's Team role.
 * @param agent - exact live Agent used as the authority credential.
 * @returns its root, Team identity, role, and model-facing name.
 */
membership(agent: Agent): TeamMembership

/**
 * Resolve a caller without throwing.
 * @param agent - candidate exact live Agent.
 * @returns Team membership, or undefined for non-Team subagents.
 */
tryMembership(agent: Agent): TeamMembership | undefined

/**
 * List the runtime-enriched roster visible to one Team member.
 * @param agent - exact live Team member.
 * @returns Lead and teammate rows in creation order.
 */
listMembers(agent: Agent): TeamMemberView[]

/**
 * Create one named, continuable direct child of the Team Lead.
 * @param caller - exact live Lead Agent.
 * @param request - immutable name, description, prompt, context mode, provider, optional persona and cwd, and cancellation.
 * @returns the active roster row.
 */
async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>

/**
 * Queue one durable peer message, then attempt immediate steer delivery.
 * The Lead's first address of a template name starts that teammate with
 * this content as the child's initial user message. A Lead-sent `persona`
 * shadows `deployment:persona`. A Lead-sent `cwd` becomes the child's
 * workspace. The assignment is recorded on the Lead log as queued then
 * delivered mail; this call does not steer a second copy.
 * @param caller - exact live sending Team member.
 * @param request - target name, content, optional first-provision persona and cwd, and pre-queue cancellation.
 * @returns durable message identity and immediate-delivery observation.
 */
async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>

/**
 * Replace the human-configured roster used for lazy provisioning.
 * @param source - bound seats and YAML extras for this process.
 */
setRosterTemplate(source: () => readonly TeamRosterTemplateEntry[]): void

/**
 * Provision a template teammate when the Lead first addresses that name.
 * Reads the Lead journal from the caller's membership root. Concurrent
 * first-use of the same name waits for the one in-flight creation. A
 * teammate may wait for an in-flight row or mail an active name; only the
 * Lead starts a missing template member.
 * @param caller - exact live Team member addressing the name.
 * @param rawName - teammate name from team_send or a named seat tool.
 * @param assignment - first user message when this call starts the teammate. Omitted or empty text keeps the role gloss.
 * @param persona - Lead-sent role. Non-empty text shadows the child's `deployment:persona`.
 * @param cwd - Lead-sent workspace. Non-empty text becomes the child's session cwd.
 * @param signal - caller cancellation; omitted uses the Team lifecycle signal.
 * @returns the recorded first-assignment mail when this call started the teammate.
 */
async ensureTemplateMember( caller: Agent, rawName: string, assignment?: readonly ContentBlock[], persona?: string, cwd?: string, signal?: AbortSignal, ): Promise<SendTeamMessageResult | undefined>
```

Types: [Agent](core.md) · [ContentBlock](llm-streaming.md)

Source: [`packages/team/agent-team/src/service.ts:56`](../../packages/team/agent-team/src/service.ts)
<!-- END GENERATED cordis-surface -->
