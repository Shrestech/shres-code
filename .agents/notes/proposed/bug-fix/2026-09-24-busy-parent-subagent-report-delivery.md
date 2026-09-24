# Agent Note: Busy-parent subagent report delivery

Status: proposed

## Problem

A continuable child's `report` under the default `reportDelivery: wakeup` calls `parent.followup()` ([`continuation.ts`](../../../../packages/subagent/subagent/src/continuation.ts), `sendReport`). That queues each report as its own next-turn item even while the parent is mid-turn. The other child-to-parent channels choose their lane by parent state. A settlement notice, which carries the child's closing message, steers a busy parent and follows up an idle one (`notifySettlement` in the same file). Team mail to the Lead steers ([`mailbox.ts`](../../../../packages/team/agent-team/src/mailbox.ts), `dispatchOnce`). A busy parent therefore reads the settlement notice and any Team mail inside its current turn and finishes. Every report then replays afterwards as a separate turn containing content the parent already had.

A live Lead log showed this. The Web queue listed 7 pending items, all next-turn `subagent-report` messages, none of them consumed. Two had payloads identical to Team messages the Lead had already consumed. Each pending report is admitted as its own parent turn; this does not prove that every report duplicates earlier content. Rostered teammates add a second path to the same duplication: their prompt names `team_send` to the Lead while `report` also reaches the Lead.

The report behavior is a recorded decision. The [report tool decision](../../implemented/feature/2026-07-30-continuable-subagent-report-tool.md) and the [report obligation](../../implemented/feature/2026-08-06-continuable-child-report-obligation.md) state that waking delivery "never steers an open turn". The [settlement delivery decision](../../implemented/feature/2026-08-06-manager-owned-subagent-settlement-delivery.md) treats "an idle parent gets a turn, a busy parent is steered" as a correctness rule, so that children settling together cost one step rather than one turn each.

## Proposal

1. **One waking lane for child-to-parent delivery.** `ContinuationManager` factors the lane that `notifySettlement` already uses into one private helper. Inside `sendWaking`, which keeps the nested-parent `admitWaking` accounting, the helper calls `parent.followup()` when `parent.status === 'idle'` and `parent.steer()` otherwise.
   - `notifySettlement` keeps its closing-teardown `inject` branch ahead of the helper, so settlement behavior is unchanged.
   - The report `wakeup` path calls the helper, with the existing `PARENT_UNAVAILABLE` translation wrapped innermost around the agent call so a throw still reaches `admitWaking`'s rollback.
   - Reports get no teardown branch. `reportFrom` calls `assertAdmitting(child)` before delivery, and `closingTeardownFor` walks the child's durable lineage, which contains the parent. A report aimed at a closing parent forest is therefore already rejected with `DRAINING`, and that rejection stays.
   - `reportDelivery: quiet` still calls `inject`.
2. **Teammate no-resend guidance.** `teammatePolicy` ([`policy.ts`](../../../../packages/team/agent-team/src/policy.ts)) keeps its existing text and appends: "Do not resend content you already delivered to the same recipient through another tool." Rostered teammates are the only agents with a second channel to their parent. The sentence names no tool, so it stays true when the optional `tool-subagent-report` plugin is absent. The `tool:report` section and the report obligation are unchanged.
3. **Unchanged:** full automatic settlement notices, `Inbox.claim()` ordering, user FIFO, and items already queued in live sessions. No text deduplication.

### Delivery matrix (report, `wakeup`)

| Parent state at send | `Agent.status` | Today | Proposed |
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

Sources: [`agent.ts`](../../../../packages/core/agent-loop/src/agent.ts), [`inbox.ts`](../../../../packages/core/agent/src/inbox.ts), [`index.ts`](../../../../packages/core/agent/src/index.ts).

- **Idle same-tick reports keep send order.** `withInitiator` runs its operation synchronously. `wakeDriver` sets the running phase, and `kick()` → `turn()` → `preStep()` calls `inbox.claim()` before its first `await`. The first report is therefore claimed inside its own `followup()`. A second same-tick report reads `running`, is steered, and is claimed at step 2 of the same turn through the `inbox.nextStep` check in `turn()`.
- **Claim order when both lists are pending at a turn start.** `Inbox.claim('next-turn')` takes every next-step item and then the single next-turn item. This matters only when both are pending as a turn opens, such as the rewake after the retirement gap under Risks.
- **An open turn stays open while next-step input is pending**, so reports arriving mid-turn add steps, not turns.
- **Maintenance exception, applying to both the report and settlement lanes.** `Agent.status` folds the maintenance phase into `idle`, so reports and settlement notices arriving during compaction stay separate next-turn follow-ups. This preserves FIFO order with human prompts queued during compaction. Collapsing them would need a public idle/maintenance distinction on `Agent`, which is out of scope.

### Contract amendments

The implemented notes below stay unchanged until the runtime change lands. The implementing change marks the affected clauses as superseded with a link to this decision; it does not rewrite the older notes into a different decision. The scoped supersession check retains all three notes for their independent authority, durability, reporting-obligation, and settlement guarantees. Nothing is archived.

- [Report tool decision](../../implemented/feature/2026-07-30-continuable-subagent-report-tool.md): mark the Waking delivery and Consequences clauses promising a separate turn and "never steers an open turn" as superseded, linking here. Authority, acceptance, `PARENT_UNAVAILABLE`, `DRAINING` and durability decisions remain active.
- [Report obligation](../../implemented/feature/2026-08-06-continuable-child-report-obligation.md): mark the separate-turn scheduling clauses as superseded with a link here. Keep the `wakeup` default, reporting obligation, and their rationale. The new scheduling rule has one decision record: this note.
- [Settlement delivery decision](../../implemented/feature/2026-08-06-manager-owned-subagent-settlement-delivery.md): the lane rule, unconditional delivery, notice form and teardown rule stay. Add a cross-link stating that reports share its lane.
- Package owners:
  - [tool-subagent-report README](../../../../packages/subagent/tool-subagent-report/README.md): the `reportDelivery` paragraph, the Model Experience token and KV effects (a busy parent pays one step, not one turn), and the rate-limit Known Limitations bullet.
  - `Config.reportDelivery` JSDoc in [tool-subagent-report/src/index.ts](../../../../packages/subagent/tool-subagent-report/src/index.ts).
  - `SubagentReportDelivery` and the report options JSDoc in [`continuation.ts`](../../../../packages/subagent/subagent/src/continuation.ts).
  - [subagent README](../../../../packages/subagent/subagent/README.md): the report and settlement delivery paragraphs.
  - [agent-team README](../../../../packages/team/agent-team/README.md): Model Experience, the teammate policy sentence.
  - [Agent Teams subsystem page](../../../../docs/subsystems/agent-team.md), if it quotes the policy.
  - [Subagent subsystem page](../../../../docs/subsystems/subagent.md): synchronize the `SubagentReportDelivery` and options type-equiv blocks with their owning JSDoc.
  - Regenerate the [config catalog](../../../../docs/config-catalog.md) from `Config.reportDelivery` JSDoc; its current separate-turn description changes. Do not hand-edit the generated entry.
  - The generated [tool catalog](../../../../docs/tool-catalog.md) is not expected to change because the report tool description and parameters stay unchanged; verify freshness.
  - Before the PR, run `rg -n "never steers|parent.followup\(\)|Mail the Lead" packages/subagent packages/team docs .agents/notes/implemented` and repair every report-delivery or policy hit. Schedule's "never steers" has a separate owner and stays.

### Keyless real-composition coverage

Two assembled scenarios each pin one model-visible fact. Package tests cover the remaining lifecycle rows.

1. **Busy-parent delivery sequence (Web, shipped composition).** Add `apps/web/tests/busy-parent-report.e2e.ts`, modelled on [`sidebar-subagent-activity.e2e.ts`](../../../../apps/web/tests/sidebar-subagent-activity.e2e.ts). It boots the shipped composition with `launchWebScaffold` ([`scaffold.ts`](../../../../apps/web/tests/scaffold.ts)), registers a scripted `LlmAdapter` through `scaffold.ctx.llm.registerAdapter`, creates the parent with `scaffold.ctx.agents.create`, and uses `connectFreshWorkspace` / `openSessionActivity` from [`support.ts`](../../../../apps/web/tests/support.ts).
   - The adapter keeps one call counter per `GenerateOptions.sessionId`. It classifies a session as parent or child by comparing that id with the parent handle's session id, which is known before the parent's first call. It never relies on global call order.
   - The test registers the parent `agent/inbox/inserted` listener that resolves the hold promise before the parent prompt is sent, so the settlement insertion cannot be missed.
   - Parent call 1 starts a continuable background subagent.
   - Parent call 2 is held on that promise, which resolves when the parent's inbox receives the child's `subagent-settled` message; there is no timer. The held stream honors `options.signal` and rejects on abort, following the `StagedAdapter` in the reference test.
   - Child call 1 makes two `report` calls; child call 2 closes and settles.
   - The parent's final call answers.
   - It adds two goldens under `apps/web/tests/snapshots/busy-parent-report/`:
     - `parent-sequence.expected.md`: a normalized excerpt of the parent's durable `turn/start`, `step/start`, `agent/inbox/spliced` (target), and `user/message` (source kind and text) sequence. It shows two `subagent-report` messages and one `subagent-settled` message claimed from next-step in one turn, with no next-turn insertion and no second parent turn.
     - `chat.expected.md`: a `captureStableAria` capture of the chat and Queue dock after the claim, showing the messages in one turn and no queued items.
   - Both are listed in `assertFixtureInventory` and written with `compareOrRefreshGolden`, created under `SHRES_SNAPSHOT=refresh` and replayed without a key.
2. **Assembled teammate prompt (headless, Team composition).** Add a separate case, `team_send provisions a teammate whose assembled prompt carries the policy`, beside the existing `team_send` case in [`team-tools.snapshot.ts`](../../../../examples/headless-agent/tests/team-tools.snapshot.ts). The existing case stays unchanged: it drives only the Lead from a bare [`replay.override.json`](../../../../examples/headless-agent/tests/team-tools-snapshots/team-send/replay.override.json), so its teammate has no script, and the Lead can finish before the teammate logs a request.
   - Config: new `examples/headless-agent/team-send-teammate.cordis.snapshot.yml`, with the same plugin list as [`team-send.cordis.snapshot.yml`](../../../../examples/headless-agent/team-send.cordis.snapshot.yml) plus the fence plugin below.
   - Replay: an authored two-session corpus in new `examples/headless-agent/tests/team-tools-snapshots/team-send-teammate/`, with no override sidecar. It is passed as `SHRES_SNAPSHOT_FILE=session.jsonl` and `SHRES_SNAPSHOT_CHILD_FILES=session.1.jsonl`, the multi-session form documented in the [llm-replay README](../../../../packages/test-support/llm-replay/README.md#nested-agents-per-session-keying) and used by [`headless.snapshot.ts`](../../../../examples/headless-agent/tests/headless.snapshot.ts).
     - `session.jsonl` is the Lead, with three steps in turn 1: step 1 calls `team_send` to `aegis`; step 2 is text; step 3 is the final text after claiming the teammate's settlement notice.
     - `session.1.jsonl` is the teammate: one text reply that ends its turn.
     - Header `createdAt` orders the Lead first. Replay binds scripts by first-call order, and the Lead streams before it can provision, so the binding is deterministic.
   - Fence: new `examples/headless-agent/tests/fixtures/team-teammate-fence.ts`, following [`subagent-settlement-fence.ts`](../../../../examples/headless-agent/tests/fixtures/subagent-settlement-fence.ts) exactly.
     - Teammates settle at idle in this composition. Provisioning goes through `startContinuable`, which marks the Activation announced, so when the teammate's turn ends its Activation settles and `notifySettlement` sends the Lead a `subagent-settled` notice. The live Lead log also shows teammate settlement notices.
     - An `agent/inbox/inserted` listener on the Lead resolves a promise when `source.kind === 'subagent-settled'` arrives.
     - An `agent/pre-step` listener holds the Lead's turn-1 step-2 pre-step until that promise resolves.
     - This pins content order, not step placement. The held pre-step has already run its own `Inbox.claim()`, so the notice is inserted after step 2's claim. Step 2's model call runs next. `turn()` then sees pending next-step input and runs step 3, which claims the notice. The Lead's script therefore has three steps, and no second Lead turn opens.
     - The teammate's `request/header` is necessarily logged before it settles, so it is persisted, and every script is consumed before the Lead finishes; replay's `assertConsumed` holds.
   - Seat settings: `prepare` writes the same `.shres/settings.yaml` Aegis binding as the existing case.
   - `inspect` asserts that the Lead log contains exactly one `subagent-settled` `user/message`, claimed in turn 1 step 3, and exactly one `turn/start`. It then selects the teammate log by header `parentSession` and reads its first `request/header` system content before `scrubRequestHeaders`. It extracts the `team:policy` paragraph, the text starting `You are an Agent Team teammate named`, normalizes the cwd through `NormalizeContext`, and compares it with new `team-send-teammate/teammate-policy.expected.md`.
   - The golden is created with `SHRES_SNAPSHOT=refresh`; no key is needed. It pins the assembled teammate wording, new sentence included, through real Team provisioning.

The generic continuable-child prompt goldens in [`acp.snapshot.ts`](../../../../examples/acp-agent/tests/acp.snapshot.ts) do not change, because `tool:report` is unchanged.

## Alternatives considered

**Always steer, even when idle.** This works: steering an idle agent wakes it, and step 1 claims next-step input. It would also collapse reports arriving during maintenance. It lost because it splits reports from the settlement lane rule (or changes settlement too), and because it breaks FIFO with human prompts queued during compaction. A unified change belongs in its own proposal.

**Deduplicate text across report, settlement and Team mail.** Rejected. Payload equality is brittle and hides distinct partial findings, and it needs the per-Activation bookkeeping the settlement decision deliberately avoided.

**Make settlement conditional on the child not reporting, or strip its closing message.** Rejected for this fix. It reverses the settlement decision's unconditional promise, which `tool-subagent` states to the model.

**Default `reportDelivery: quiet`.** Rejected. A parked parent would miss reports until an unrelated wake, which is the gap the report-obligation decision closed.

**Change `Inbox.claim` or user FIFO, or migrate already-queued items.** Rejected as core-loop changes out of proportion to this defect.

**Put the no-duplicate guidance in `tool:report`.** This is workable, and the guidance would appear exactly when `report` exists. It lost because it changes every continuable child's prompt, with the token cost, the KV-cache change, the report unit pins and the pinned ACP child prompts that follow. Only rostered teammates have the second channel, and each fact gets one home.

**Pin the teammate prompt inside the Web busy-report scenario.** This would need a Team-provisioned child in the Web scaffold and extraction of the request system text there. It lost because the headless `team_send` case already provisions a real teammate keylessly through the Team composition. Each scenario keeps one responsibility.

## Acceptance criteria

- Parent running and not cancelled, before the retirement window: a `wakeup` report is a next-step `agent/inbox/spliced` insertion claimed within that turn, and it causes no further `turn/start`.
- Parent idle: an isolated report opens one turn from one next-turn insertion. A same-tick second report reads `running`, is steered, and is claimed at step 2 of that turn, preserving send order.
- Parent cancelled but still running: the report is redirected to next-turn and replayed after convergence.
- During `runMaintenance`: one next-turn insertion and one turn per report after maintenance, with settlement pinned the same way.
- Closing parent forest: `reportFrom` rejects with `DRAINING` and inserts nothing.
- Nested continuable parent: it cannot settle between the send and admission.
- `quiet` is unchanged, and existing settlement tests pass unchanged. Retirement-window sends remain an accepted pre-existing risk and are excluded from the same-turn guarantee.
- The assembled teammate prompt golden contains the new `teammatePolicy` sentence verbatim. The `tool:report` text and the ACP child prompt goldens are unchanged.
- The Web `parent-sequence` golden shows two reports and a settlement notice claimed in one parent turn, with no trailing report turn.
- READMEs, JSDoc and notes state the lane rule and the maintenance exception, and `doc-sync` passes.

## Risks

- **Reports overtake queued human follow-ups** on a busy parent, as settlement and Team mail already do. A queued human redirect is read after the report.
- **Mid-turn content** can change the parent's course inside the current turn. This is intended: turns get longer, not more numerous.
- **Web presentation:** a report claimed from next-step follows the non-user next-step context path, not the queued-turn path. The Web golden and a Queue dock review verify it.
- **Maintenance exception:** N reports during compaction still cost N turns, as today.
- **Accepted, pre-existing retirement microtask gap**, owned by `agent-loop` and recorded in the [tool-jobs Known Limitations](../../../../packages/jobs/tool-jobs/README.md):
  - After `turn()` returns false at its last synchronous `hasPending` check, `kick()` resumes its `await` on a later microtask.
  - `wakeDriver` latches only for maintenance or post-abort sends, so a `steer` or `followup` sent in between is neither claimed nor latched.
  - `kick()`'s `finally` then goes idle without rewaking.
  - The message waits for the next wake, whose turn claims it together with at most one queued next-turn item.

  The guarantee is therefore "no additional turn per report", not "no new turns". This change neither creates nor closes the gap.

## Implementation steps

1. [`continuation.ts`](../../../../packages/subagent/subagent/src/continuation.ts): add the lane helper, route `notifySettlement` (behavior unchanged) and the report `wakeup` path through it, and update the JSDoc.
2. [`policy.ts`](../../../../packages/team/agent-team/src/policy.ts): append the sentence, and update any pin in [`team-runtime.spec.ts`](../../../../packages/team/agent-team/tests/team-runtime.spec.ts).
3. Unit tests:
   - [`tool-subagent-report.spec.ts`](../../../../packages/subagent/tool-subagent-report/tests/tool-subagent-report.spec.ts) covers the matrix rows (running, idle single, idle same-tick pair, cancelled-running, maintenance, draining, nested, quiet) through splice targets, claim steps and `turn/start` counts.
   - [`continuation.spec.ts`](../../../../packages/subagent/subagent/tests/continuation.spec.ts) keeps its settlement cases unchanged and adds two cases: a busy parent receiving a report and a settlement from one child in one turn (report first), and settlement during maintenance.
4. Keyless coverage as specified above: the Web sequence and chat goldens, and the headless teammate-policy golden.
5. Apply the contract amendments and package docs, then move this note to `implemented/bug-fix/` as a Decision.

## Verification

```sh
export PATH=/opt/homebrew/bin:$PATH
pnpm vitest run packages/subagent/subagent packages/subagent/tool-subagent-report packages/team/agent-team
pnpm vitest run --coverage \
  --coverage.include=packages/subagent/subagent/src/continuation.ts \
  --coverage.include=packages/team/agent-team/src/policy.ts \
  packages/subagent/subagent packages/subagent/tool-subagent-report packages/team/agent-team
pnpm run test:snapshot -t team_send
pnpm run build && SHRES_SNAPSHOT=replay pnpm vitest run --config vitest.web.config.ts apps/web/tests/busy-parent-report.e2e.ts
pnpm run typecheck && pnpm run lint && pnpm run doc-sync
```

If `packages/subagent/tool-subagent-report/src/index.ts` changes beyond JSDoc, add it to the coverage include list.
