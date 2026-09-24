# Agent Note: Busy-parent subagent report delivery

Status: implemented

## Problem

A continuable child's `report` under `reportDelivery: wakeup` called `parent.followup()` (`sendReport` in [continuation.ts](../../../../packages/subagent/subagent/src/continuation.ts)), so every report became its own next-turn item even while the parent was mid-turn. The other child-to-parent channels chose their lane by parent state: a settlement notice steers a busy parent and follows up an idle one, and Team mail to the Lead steers. A busy parent therefore read the settlement notice and any Team mail inside its current turn and finished, after which every report replayed as a separate turn carrying content the parent already had.

A live Lead log showed the cost: the Web queue listed 7 pending items, all next-turn `subagent-report` messages, none consumed, two with payloads identical to Team messages the Lead had already consumed. Rostered teammates add a second path to the same duplication, because their prompt names `team_send` to the Lead while `report` also reaches the Lead.

## Decision

`ContinuationManager` owns one private waking lane, `sendLane(parent, message)`: `parent.followup()` when `Agent.status` is `idle`, `parent.steer()` otherwise. The settlement notice and the `wakeup` report both deliver through it inside `sendWaking`, which keeps the nested continuable parent's `admitWaking` accounting.

- `notifySettlement` keeps its closing-teardown `inject` branch ahead of the lane, so a parent whose own lineage is draining still receives the notice without a wake.
- The report `wakeup` path calls the lane with its existing `PARENT_UNAVAILABLE` translation wrapped innermost around the agent call, so a rejection still reaches `admitWaking`'s rollback before it is reported.
- Reports have no teardown branch. `reportFrom` calls `assertAdmitting(child)` before delivery, and `closingTeardownFor` walks the child's durable lineage, which contains the parent, so a report aimed at a closing parent forest is already rejected with `DRAINING` and inserts nothing.
- `reportDelivery: quiet` still calls `parent.inject()`.

Rostered teammates are the only agents with a second channel to their parent, so `teammatePolicy` ([policy.ts](../../../../packages/team/agent-team/src/policy.ts)) ends with "Do not resend content you already delivered to the same recipient through another tool." The sentence names no tool, so it stays true when the optional `tool-subagent-report` plugin is absent. The `tool:report` guidance and the report obligation are unchanged.

Unchanged as well: full automatic settlement notices, `Inbox.claim()` ordering, user FIFO, and items already queued in live sessions. No text deduplication.

### Delivery matrix (report, `wakeup`)

| Parent state at send | `Agent.status` | Before | Now |
|---|---|---|---|
| idle | idle | `followup`: one turn | unchanged |
| maintenance (e.g. compaction) | idle | `followup`, wake latched; N reports -> N turns after maintenance | unchanged (explicit exception) |
| running, live | running | `followup`: queued next turn | `steer`: claimed at the next step of the current turn |
| running, cancelled, not exited | running | `Agent.send` redirects to next-turn and latches | same redirect; `send` decides by the wake flag, not the target |
| parent forest closing | any | `DRAINING` rejection before delivery | unchanged |
| disposed | — | `send` no-op | unchanged |
| nested continuable parent | any | `admitWaking` accounting | unchanged |
| `reportDelivery: quiet` | any | `inject` | unchanged |

### Scheduling facts

Sources: [agent.ts](../../../../packages/core/agent-loop/src/agent.ts), [inbox.ts](../../../../packages/core/agent/src/inbox.ts), [index.ts](../../../../packages/core/agent/src/index.ts).

- **Idle same-tick reports keep send order.** `withInitiator` runs its operation synchronously. `wakeDriver` sets the running phase, and `kick()` -> `turn()` -> `preStep()` calls `inbox.claim()` before its first `await`, so the first report is claimed inside its own `followup()`. A second same-tick report reads `running`, is steered, and is claimed at step 2 of the same turn through the `inbox.nextStep` check in `turn()`.
- **Claim order when both lists are pending at a turn start.** `Inbox.claim('next-turn')` takes every next-step item and then the single next-turn item. This matters only when both are pending as a turn opens, such as the rewake after the retirement gap below.
- **An open turn stays open while next-step input is pending**, so reports arriving mid-turn add steps, not turns.
- **Maintenance exception, applying to both the report and settlement lanes.** `Agent.status` folds the maintenance phase into `idle`, so reports and settlement notices arriving during compaction stay separate next-turn follow-ups, which preserves FIFO order with human prompts queued during compaction. Collapsing them would need a public idle/maintenance distinction on `Agent`, which this change does not add.

### What pins it

`packages/subagent/tool-subagent-report/tests/tool-subagent-report.spec.ts` covers the matrix through splice targets, claim steps, and `turn/start` counts, reading the durable parent log rather than the inbox so a claim is what the assertion observes: an idle report opening one later turn, a report steered into the turn a busy parent already has open, back-to-back reports claimed in one turn in send order, a report on a cancelled but still-running parent redirected to next-turn, two reports during maintenance costing two turns after it ends, a rejected steered send and a rejected idle followup each rolling the accepted report back without pinning the nested parent's Activation, a running nested parent staying resident until its steered report is claimed and then settling exactly once, a nested parent's `admitWaking` accounting, and `quiet`. `packages/subagent/subagent/tests/continuation.spec.ts` keeps its settlement cases and adds one — a busy parent claims a report and a settlement notice from one child in one turn, report first, with no second `turn/start` — and extends its `runMaintenance` case to pin that both notices wait as next-turn items while maintenance holds.

Two assembled scenarios pin the model-visible facts. `apps/web/tests/busy-parent-report.e2e.ts` boots the shipped Web composition with a scripted LLM and pins the parent's durable `turn`/`step`/inbox-splice sequence and the chat with its Queue dock in `snapshots/busy-parent-report/parent-sequence.expected.md` and `chat.expected.md`: two `subagent-report` messages and one `subagent-settled` notice claimed from next-step in one turn, with no next-turn insertion and no second parent turn. The headless case `team_send provisions a teammate whose assembled prompt carries the policy` in `examples/headless-agent/tests/team-tools.snapshot.ts` provisions a real teammate whose two-step script (`team_list`, then a text reply) settles while the Lead is held mid-turn by the fence, and pins the assembled `team:policy` paragraph — new sentence included — in `team-send-teammate/teammate-policy.expected.md`, keylessly.

### Documentation

The lane rule and the maintenance exception live on `SubagentReportDelivery` in [continuation.ts](../../../../packages/subagent/subagent/src/continuation.ts) and are restated where each consumer needs them: [tool-subagent-report README](../../../../packages/subagent/tool-subagent-report/README.md), its `Config.reportDelivery` JSDoc and the generated [config catalog](../../../../docs/config-catalog.md), [subagent README](../../../../packages/subagent/subagent/README.md), and the synchronized blocks on [Subagent subsystem](../../../../docs/subsystems/subagent.md). [agent-team README](../../../../packages/team/agent-team/README.md) states why the policy's no-resend sentence names no tool. The affected clauses of the older decisions carry supersession pointers to this note; the notes themselves stay active for their independent authority, durability, reporting-obligation, and settlement guarantees, and none is archived.

## Alternatives considered

**Always steer, even when idle.** This works — steering an idle agent wakes it, and step 1 claims next-step input — and it would also collapse reports arriving during maintenance. It lost because it splits reports from the settlement lane rule (or changes settlement too) and breaks FIFO with human prompts queued during compaction. A unified change belongs in its own proposal.

**Deduplicate text across report, settlement and Team mail.** Rejected. Payload equality is brittle and hides distinct partial findings, and it needs the per-Activation bookkeeping the settlement decision deliberately avoided.

**Make settlement conditional on the child not reporting, or strip its closing message.** Rejected. It reverses the settlement decision's unconditional promise, which `tool-subagent` states to the model.

**Default `reportDelivery: quiet`.** Rejected. A parked parent would miss reports until an unrelated wake, which is the gap the report-obligation decision closed.

**Change `Inbox.claim` or user FIFO, or migrate already-queued items.** Rejected as core-loop changes out of proportion to this defect.

**Put the no-duplicate guidance in `tool:report`.** Workable, and the guidance would appear exactly when `report` exists. It lost because it changes every continuable child's prompt with the token cost, the KV-cache change, the report unit pins, and the pinned ACP child prompts that follow. Only rostered teammates have the second channel, and each fact gets one home.

**Pin the teammate prompt inside the Web busy-report scenario.** It lost because the headless `team_send` case already provisions a real teammate keylessly through the Team composition; each scenario keeps one responsibility.

## Consequences

- **Reports overtake queued human follow-ups** on a busy parent, as settlement and Team mail already do. A queued human redirect is read after the report.
- **Mid-turn content can change the parent's course inside the current turn.** This is intended: turns get longer, not more numerous.
- **A report claimed from next-step follows the non-user next-step context path** in the Web presentation rather than the queued-turn path; the Web golden and a Queue dock review verify it.
- **The maintenance exception keeps the old cost**: N reports during compaction still cost N turns.
- **The accepted, pre-existing retirement microtask gap remains**, owned by `agent-loop` and recorded in the [tool-jobs Known Limitations](../../../../packages/jobs/tool-jobs/README.md): after `turn()` returns false at its last synchronous `hasPending` check, `kick()` resumes its `await` on a later microtask; `wakeDriver` latches only for maintenance or post-abort sends, so a `steer` or `followup` sent in between is neither claimed nor latched, and `kick()`'s `finally` goes idle without rewaking, leaving the message for the next wake, whose turn claims it together with at most one queued next-turn item. The guarantee is therefore "no additional turn per report", not "no new turns". This change neither creates nor closes that gap.
