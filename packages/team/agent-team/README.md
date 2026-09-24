# @shres-code/shres-code-agent-team

Agent Teams runtime: one Lead session coordinates named peer teammates through a roster and a Lead-log mailbox. This package owns the log events, the fold, the `agentTeam` projection, `TeamJournal`, continuable provisioning, steer delivery, and the `team_send` / `team_list` tools. Task-board tools are not registered yet.

The [runtime note](../../../.agents/notes/implemented/feature/2026-09-11-agent-teams-runtime-and-seats.md) owns live delivery; the [vocabulary note](../../../.agents/notes/implemented/feature/2026-09-10-agent-teams-durable-vocabulary.md) owns identity and replay; the [subsystem page](../../../docs/subsystems/agent-team.md) records the durable forms.

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

## Roster model binding

A teammate's `active` `team/member` snapshot records `agentProvider` / `agentModel`, the LLM route returned by `ctx.subagents.startContinuable()` and persisted in the child's subagent descriptor; recovery of a leftover provisioning row copies the same fields from that descriptor. `provider` on the snapshot and on roster rows is the subagent spawn provider, such as `spawn`. `listMembers()` reports each row's own route as `agentProvider` / `model`: a loaded Lead reads its latest logged request header, else the live default-model selection, else its creation options; a loaded teammate reads its latest logged request header, else its creation options; an unloaded teammate reads its snapshot; an `unstarted` name reads the current template binding. A started teammate never adopts a later template change, and a row without a known route omits the model instead of showing the Lead's. A `/model` switch appears after that Agent's next request.

## Durability

`TeamJournal.appendAndFlush(session, type, data)` appends the ignorable event, then awaits `ctx.sessions.flush(session)` and requires at least one persistence listener. An acknowledged append is durable before any later delivery attempt. Persistence plugins subscribe to `session/flush`. `transact(rootId, operation)` serializes mutations per Lead.

## Replay

`foldTeam(rootId, events)` reconstructs roster, tasks, queued messages, and delivered ids for the Team whose `teamId` equals `rootId`. Inherited fork-seed events retain the ancestor id and never enter the new root's state. The `agentTeam` projection unit folds every Team present in a Session log, keyed by `teamId`; callers select the projected Session's own Team with `values.agentTeam?.[session.id]`. A replay fault freezes the fold at its last good snapshot and drops later events; `TeamJournal.state()` surfaces that as `TEAM_LOG_FAULT` instead of serving the frozen state silently. The separately published `./invariant` companion maintains an independent fold of each attached session and rejects illegal native transitions before commit.

## Model-visible attribution

A delivered peer message is an ordinary `user/message` in the TARGET session. Its source is:

`{ kind: 'team-message', form: 'relay', teamId, messageId, senderSessionId, senderName }`

Mailbox bookkeeping reconstructs from the Lead log; model-visible content reconstructs from the target's own `user/message`. This package declares the source; it does not write target messages.

## Model Experience

Indirectly, through the `team_list` and `team_send` tools this package registers on `ctx.tools`, and through the teammate-only `team:policy` and `deployment:environment` sections (`You are an Agent Team teammate named <name>, not the Team Lead.` and `Your working directory is {{cwd}}.`). A rostered teammate is the only agent with a second channel to its parent — `team_send` beside the optional `report` tool — so the policy ends with `Do not resend content you already delivered to the same recipient through another tool.`, which names no tool and therefore holds when that optional package is absent. Named seat tools are owned by `@shres-code/shres-code-agent-seats`.

#### KV Cache effect

Prefix-stable while the Team tool schemas are unchanged. Binding or unbinding a seat remounts that named tool and invalidates parent reuse from the first changed tool.

## Known Limitations and Deferred Work

- **No model-facing `spawn_teammate`** — the grant is Models bindings plus YAML `extras`. The service method exists for seats and `team_send` lazy provision.
- **No task-board tools** — `team/task` events fold, but create/claim/complete tools are not registered.
- **Trusted in-process producers** — a plugin with direct `Session` access can append counterfeit Team events. The fold and invariant detect inconsistency; they do not isolate plugins.
- **Roster reads are Lead-session reads** — the `agentTeams.view` wire surface in `@shres-code/shres-code-host-apiproxy` serves the chat panel and answers only for a live Lead.
- **Only the Lead provisions** — concurrent first-use of one name joins the in-flight creation. The Lead's first `aegis` or `team_send` starts that teammate with the assignment as the child's first user message and records that assignment as queued then delivered Team mail. A Lead-sent role (`persona` on `sendMessage` and `team_send`, the named-seat `prompt`) shadows `deployment:persona`; tool guidance, `team:policy`, and the working-directory line stay. A Lead-sent `cwd` becomes the child's session cwd and AGENTS.md root; omitted inherits the Lead workspace; a cwd after the teammate is active is rejected. Named seat tools are denied on the child, including after a later remount. Later mail steers. A teammate can mail an active or still-creating name; mailing an unstarted listed name fails until the Lead starts it.
