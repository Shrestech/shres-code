# @shres-code/shres-code-agent-team

Durable Agent Teams vocabulary and replay substrate. One Lead session coordinates named peer teammates through a roster, a mailbox, and a compare-and-set task board, all reconstructed from the Lead session log. This package owns the log events, the pure fold, the `agentTeam` projection unit, and `TeamJournal`. It does not spawn teammates, deliver or retry messages, expose a task-board service API, or register model tools; later packages consume these building blocks.

The [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-09-10-agent-teams-durable-vocabulary.md) owns identity, mailbox, and replay decisions; the [subsystem page](../../../docs/subsystems/agent-team.md) records the literal durable forms.

## Config

```yaml
- id: agent-team
  name: '@shres-code/shres-code-agent-team'
  config:
    maxMembers: 8
    maxTasks: 256
    maxPendingMessagesPerMember: 64
    maxMessageBytes: 65536
    disposalTimeoutMs: 5000
```

Every field is a positive safe integer. `resolveConfig()` fails loud on a non-integer or non-positive value after schemastery defaulting. The plugin injects `sessionProjections`; assemblies without the registry leave the fiber pending.

## Durable record

Writers pass `{ ignorable: true }`. A build without this plugin may skip the events; losing them cannot corrupt conversation reconstruction. `SESSION_FORMAT_VERSION` stays `0`.

| Event | Payload | Replay |
|---|---|---|
| `team/member` | `{ teamId, member }` | whole snapshot; latest wins per member id |
| `team/task` | `{ teamId, task }` | whole snapshot; latest wins per task id |
| `team/message/queued` | `{ teamId, message }` | append-only enqueue |
| `team/message/delivered` | `{ teamId, messageId, targetId }` | acknowledgement that the target session recorded the message |

`TeamId` is the Lead `SessionId` under a distinct brand. `TeamTaskId` is team-local `task-<n>`. `TeamMessageId` is globally random. A teammate name is reserved permanently; a failed provisioning keeps its row.

## Durability

`TeamJournal.appendAndFlush(session, type, data)` appends the ignorable event, then awaits `ctx.sessions.flush(session)` and requires at least one persistence listener. An acknowledged append is durable before any later delivery attempt. Persistence plugins subscribe to `session/flush`. `transact(rootId, operation)` serializes mutations per Lead.

## Replay

`foldTeam(rootId, events)` reconstructs roster, tasks, queued messages, and delivered ids for the Team whose `teamId` equals `rootId`. Inherited fork-seed events retain the ancestor id and never enter the new root's state. The `agentTeam` projection unit folds every Team present in a Session log, keyed by `teamId`; callers select the projected Session's own Team with `values.agentTeam?.[session.id]`. The separately published `./invariant` companion maintains an independent fold of each attached session and rejects illegal native transitions before commit.

## Model-visible attribution

A delivered peer message is an ordinary `user/message` in the TARGET session. Its source is:

`{ kind: 'team-message', form: 'relay', teamId, messageId, senderSessionId, senderName }`

Mailbox bookkeeping reconstructs from the Lead log; model-visible content reconstructs from the target's own `user/message`. This package declares the source; it does not write target messages.

## Model Experience

None, as this package stores log-only coordination records and a client-facing projection of them; later tool consumers own every model-visible byte.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No spawning, delivery, task service, or tools** — this slice is the durable substrate. Teammate creation, mailbox dispatch, the task-board service API, and model-facing tools belong to later packages.
- **Limits are validated, not enforced** — `maxMembers`, `maxTasks`, `maxPendingMessagesPerMember`, `maxMessageBytes`, and `disposalTimeoutMs` fail loud at plugin load when invalid; later operations apply them.
- **Trusted in-process producers** — a plugin with direct `Session` access can append counterfeit Team events. The fold and invariant detect inconsistency; they do not isolate plugins.
