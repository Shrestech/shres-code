# Agent Note: Agent Teams durable vocabulary and replay substrate

Status: implemented

## Problem

One Lead session needs to coordinate named peer teammates through a roster, a mailbox, and a compare-and-set task board that survive restart. Putting that state only in memory loses it on process restart. Putting it only in UI state makes model-visible peer messages impossible to reconstruct. Folding the coordination into the existing `subagent/` family would mix a named-peer roster with one-shot and continuable delegation, which are different products.

Anything that later reaches a model request must be reconstructable from a session log. A peer message delivered into a teammate must therefore land as an ordinary `user/message` in the TARGET session, while mailbox bookkeeping stays on the Lead log.

## Decision

`@shres-code/shres-code-agent-team` in `packages/team/agent-team/` owns the durable vocabulary and replay substrate. Agent Teams is a coordination capability that consumes the existing `subagent/` delegation seam; it is not folded into that family. This package does not spawn teammates, deliver or retry messages, expose a task-board service API, or register model tools.

### Durable record

Four log-only events merge into `SessionEventMap`. Writers pass `{ ignorable: true }`, so a build without this plugin may skip them and conversation reconstruction stays intact. There is no per-event version field; only a structural log-format change bumps `SESSION_FORMAT_VERSION`.

- `team/member` — `{ teamId, member }`, whole snapshot, latest wins per member id. A name is reserved permanently and a failed provisioning keeps its row.
- `team/task` — `{ teamId, task }`, whole snapshot, latest wins per task id. `revision` increments by one per mutation.
- `team/message/queued` — `{ teamId, message }`, appended and made durable before delivery is attempted.
- `team/message/delivered` — `{ teamId, messageId, targetId }`, the acknowledgement that the target session durably recorded the message.

`TeamId` is the Lead `SessionId` under a distinct brand. `TeamTaskId` is team-local `task-<n>`. `TeamMessageId` is globally random.

### Model-visible attribution

A delivered peer message is an ordinary surface `user/message` in the TARGET session carrying:

`{ kind: 'team-message', form: 'relay', teamId, messageId, senderSessionId, senderName }`

Mailbox bookkeeping reconstructs from the Lead log; model-visible content reconstructs from the target's own `user/message`. This package declares the source; a later delivery package writes the target message.

### Durability and replay

`TeamJournal` serializes mutations per Lead, appends the ignorable event, then awaits `ctx.sessions.flush(session)` and requires at least one persistence listener. An acknowledged append is durable before any later delivery attempt.

`foldTeam(rootId, events)` reconstructs roster, tasks, and queued-minus-delivered mail for the Team whose `teamId` equals `rootId`. Inherited fork-seed events retain the ancestor id and never enter the new root's state. The `agentTeam` projection unit folds every Team present in a Session log, keyed by `teamId`, because `ProjectionDefinition.init`/`apply`/`view` do not receive the Session identity; callers select `values.agentTeam?.[session.id]`. The `./invariant` companion maintains an independent fold and rejects illegal native transitions before commit.

Deployment limits `maxMembers` 8, `maxTasks` 256, `maxPendingMessagesPerMember` 64, `maxMessageBytes` 65536, and `disposalTimeoutMs` 5000 are validated schemastery Config fields, not module constants.

## Alternatives considered

- **Fold Agent Teams into `packages/subagent/`** — rejected because named-peer coordination consumes delegation; it is not itself a subagent provider or tool. Mixing the roster with one-shot and continuable children would couple two products.
- **Per-event `version` fields** — rejected because this repo versions the session log as a whole. `ignorable: true` covers vocabulary growth; only a structural envelope change bumps `SESSION_FORMAT_VERSION`.
- **A public `TeamService` in this slice** — rejected because a public method with no caller is against package conventions. The journal, fold, and projection are the tested building blocks later Team operations consume.
- **Store Team state outside the session log** — rejected because the log already supplies ordering, persistence, fork prefixes, and reconstructability; a second store introduces atomicity and lineage questions.
- **Init the projection with the Session header so view can be one Team** — rejected by the current `ProjectionDefinition` contract, whose `init` takes no header. A `teamId`-keyed map keeps inherited ancestor records from becoming the fork's Team.

## Consequences

- Roster, mailbox, and task snapshots survive persistence, resume, and session fork as ordinary session data.
- A later delivery package can wait on `appendAndFlush` before attempting Steer delivery.
- Model-visible peer content stays on the target session; Lead-log bookkeeping stays off the conversation surface.
- Deployment limits are changeable from cordis.yml without code edits.

## Known limitations and deferred work

- This package does not spawn teammates, route messages, expose task mutations, or register tools.
- Config limits are validated at load; later operations enforce them.
- Direct session writers can counterfeit Team records; the fold and invariant detect inconsistency and fail the stream at the offending record, but do not isolate plugins or repair the log.
