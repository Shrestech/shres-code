# Agent Teams

Types shared by the implicit-root Team domain. The [Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-09-10-agent-teams-durable-vocabulary.md) owns identity, mailbox, and replay decisions; this page records the literal durable forms from [`packages/team/agent-team/src/types.ts`](../../packages/team/agent-team/src/types.ts). The [package README](../../packages/team/agent-team/README.md) owns operation, recovery, and limit behavior.

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

## Replay

`foldTeam(rootId, events)` replays one root Session into the roster, task board, and queued-minus-delivered mailbox that later Team operations read. It selects records by `TeamId`, so events inherited by an ordinary fork retain the ancestor id and never enter the new root's state. Session event `seq` and `time` remain the ordering and timing record; Team snapshots do not duplicate them. The `agentTeam` projection unit folds every Team present in a Session log, keyed by `teamId`; callers select the projected Session's own Team with `values.agentTeam?.[session.id]`.
