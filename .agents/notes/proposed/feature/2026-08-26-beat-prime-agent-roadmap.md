# Agent Note: Beat-Prime-Agent campaign roadmap

Status: proposed

## Problem

shres-code has built a lossless typed log, a session-query Consumer, compaction that archives and points at seqs, an executor-enforced charter, step/repeat/timeout guards, and a pre-registered paired bench — and **cannot claim any of that improved task pass rate** ([MAPPING honest improvement verdict](../../../../MAPPING-prime-agent-2026-08-26.md); [W0 eval note](../testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md)). Prime Agent and PRO-LONG publish external deltas (OOLONG-Pairs +31.8 pp on GLM-5.2; PRO-LONG +18.0 pp pass@1 on ARC-AGI-3) our bench cannot quote.

Five design notes close the remaining source gaps as default-off, measurable work: [persistent kernel](2026-08-26-beat-prime-agent-persistent-kernel.md), [agent bus](2026-08-26-beat-prime-agent-agent-bus.md), [refinement loop](2026-08-26-beat-prime-agent-refinement-loop.md), [autonomy and accounting](2026-08-26-beat-prime-agent-autonomy-accounting.md), [bench strategy](2026-08-26-beat-prime-agent-bench-strategy.md). Without a single sequencing spine, those notes can be implemented out of order, claimed early, or shipped undriven. This note is that spine.

The [MAPPING working file](../../../../MAPPING-prime-agent-2026-08-26.md) is the source-mapping record all five notes cite. It is not an Agent Note.

## Proposal

Execute fifteen work packages in four waves. Wave 0 is measurement first. Wave 1 is mechanical foundations. Wave 2 is default-off capability. Wave 3 is surfaces and claims. Waves 2–3 depend on wave-0 verdicts. Retire-if-tie applies per arm: an arm that ties or loses at powered n is retired, not shipped.

Owner notes, touch points, bench arms, retire rules, and gates are listed per WP below. Every WP inherits the [ground rules](#ground-rules-every-work-package-inherits).

## Ground rules every work package inherits

- **Model-visible iff logged:** every model-visible input must be reconstructable from the session log.
- **Capability seams are complete** (Service Definition + Provider + Consumer), never one role. The host-scheduler exception (no model-facing Consumer; Agents View and the dispatch loop consume scheduler-owned state) is recorded in the [autonomy note](2026-08-26-beat-prime-agent-autonomy-accounting.md).
- **Enforced gates:** `pnpm run test:coverage` (per-file 100% on `packages/*/*/src`), `pnpm run duplication`, `pnpm run doc-sync`; a new model-visible surface adds a keyless snapshot through a real example in the same PR; product-user-visible GUI changes add a GIF from the real server/model flow.
- **Default-off arms:** every new capability ships disabled and is measured by a pre-registered paired bench arm before any default flips.
- **Measurement constitution:** no external "beats Prime" claim before the internal gate passes; comparable means same model (verified by `tierPatches` sha256, not the `run.json` `model` string), same generator, same budget accounting, interleaved paired arms, intervals mandatory; "underpowered" is never reported as "no effect".
- **Retire-if-tie:** an arm that ties or loses at powered n is retired, not shipped.

## Wave 0 — measurement first

Owner: [bench-strategy note](2026-08-26-beat-prime-agent-bench-strategy.md) P0–P3. No product capability ships in this wave.

### WP0.1 Descendant-inclusive accounting + live `maxTotalTokens`

- **Touch points:** [`bench/runner/session-layout.js`](../../../../bench/runner/session-layout.js) (`encodeSegment` / `projectKey` already copied); [`bench/runner/metrics.js`](../../../../bench/runner/metrics.js) (today reads only `assistant/message` usage at lines 258–265); [`bench/schema/trial.js`](../../../../bench/schema/trial.js) (`BUDGET_EXCEEDED` exists; `tokensIncludingDescendants` is null; comment at line 31 calls the walk "fragile and untested in v1").
- **Work:** header-keyed BFS over `parentSession` on closed trial files; `foldUsage` uses token-meter `usageOf` for **root and descendants**; live cap terminates the trial as `BUDGET_EXCEEDED`; `success(B)` below the cap is post-hoc filtering.
- **Bench arm:** none (code only). Unblocks later subagent arms.
- **Retire rule:** n/a (instrument). A walker that disagrees with planted fixtures does not merge.
- **Gates:** runner unit tests with planted child logs; schema un-null'd.

### WP0.2 Run w9 as pre-registered

- **Touch points:** [W0 eval note](../testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md) w9 pre-registration; `bench/analysis/w9-power.js`.
- **Work:** `off` vs `on-charter`, n=62 pattern (31×2 pressure tasks), typo-guard canary. **Fresh experiment id:** do not reuse `w9-charter-2026-08-26` (aborted, 0 completed) or `w9-canary-2026-08-26` (4-trial pressure smoke; on-charter `AGENT_TIMEOUT` in 2/2). The canary is the pre-registered typo-guard task, not a pressure smoke.
- **Bench arm:** `off` vs `on-charter`. Decision rule already pre-registered in the W0 eval note (McNemar p<0.05, δ>0, token caps 1.15 short / 1.25 pressure, n_d ≥ 25).
- **Retire rule:** loss or tie at powered n **retires jspace**. Underpowered ⇒ "not yet."
- **Gates:** implemented results note; `tierPatches` sha256 recorded as the model pin.

### WP0.3 `outOfLoopExperiments` forensics

- **Touch points:** [`bench/runner/metrics.js`](../../../../bench/runner/metrics.js); stored runs `w6`–`w8`, `sq-adopt`.
- **Work:** recompute over stored runs; zero API spend.
- **Bench arm:** none (forensics).
- **Retire rule:** n/a.
- **Gates:** metric documented; table over stored runs committed.

### WP0.4 Commit the MAPPING working file and record w4–w9 outcomes

- **Touch points:** [`MAPPING-prime-agent-2026-08-26.md`](../../../../MAPPING-prime-agent-2026-08-26.md); [W0 eval note](../testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md).
- **Work:** the MAPPING file is added in the same change as these notes. w4–w8 outcomes already live in the W0 eval note; w9 outcome lands in an implemented results note after WP0.2.
- **Bench arm:** none.
- **Retire rule:** n/a.
- **Gates:** MAPPING links from the six notes resolve (`pnpm run verify-md-links` via `doc-sync`).

## Wave 1 — foundations (mechanical, independently shippable)

### WP1.1 Extract worker-shared plumbing

- **Owner:** [persistent-kernel note](2026-08-26-beat-prime-agent-persistent-kernel.md).
- **Touch points:** new `packages/code-runtime/code-runtime-worker-shared`; [`packages/code-runtime/code-runtime-worker-thread/src/index.ts`](../../../../packages/code-runtime/code-runtime-worker-thread/src/index.ts).
- **Work:** behavior-preserving extraction of worker bootstrap, protocol parse, output ledger, ELU/wall timers.
- **Bench arm:** none (refactor). Existing `-worker-thread` suite is the safety net.
- **Retire rule:** n/a; revert if the existing suite fails.
- **Gates:** existing suite untouched-pass; `pnpm run duplication`; `pnpm run test:coverage`.

### WP1.2 `scheduleNext` projection unit + `tokenUsage` cold-read helper

- **Owner:** [autonomy-accounting note](2026-08-26-beat-prime-agent-autonomy-accounting.md) "build first."
- **Touch points:** [`packages/schedule/schedule/src/index.ts`](../../../../packages/schedule/schedule/src/index.ts); [`packages/session/session-projection-cache/src/index.ts`](../../../../packages/session/session-projection-cache/src/index.ts) (`coldSnapshot()` at lines 166–197); export `runScheduleTransaction` from the same schedule `index.ts`.
- **Work:** register `scheduleNext`; cold reads go through `coldSnapshot()`, never `cachedSnapshot()`, because the units accumulate. Helper reused by WP2.3, WP3.1, WP3.5.
- **Bench arm:** none (read helper). Unit tests that a tail event after a checkpoint is visible in `coldSnapshot` and invisible in `cachedSnapshot`.
- **Retire rule:** n/a.
- **Gates:** `pnpm run test:coverage`; persistence-catalog regen for `scheduleNext`.

### WP1.3 Refinement store v0

- **Owner:** [refinement-loop note](2026-08-26-beat-prime-agent-refinement-loop.md).
- **Touch points:** new `packages/harness/harness` (`shres-harness` types, `harness_state` storage domain, append-only ledger, branded `HarnessEntryId`); miner + `/harness mine/list/show`; unowned-job session-end trigger.
- **Work:** read-only proposals only. Mining source compositions must opt in to `verifierTools` / `requireVerifiedEvidence` (`on-charter` is the natural source).
- **Bench arm:** none in v0 (contamination unit tests only). w10 is WP3.4.
- **Retire rule:** v0 does not activate; nothing to retire. Behind w9/w10 verdicts for any later activation.
- **Gates:** architecture test (miner has no write tools / fs / activator import); `pnpm run test:coverage`.

### WP1.4 Bus phase 0

- **Owner:** [agent-bus note](2026-08-26-beat-prime-agent-agent-bus.md).
- **Touch points:** family-membership resolver extracted from [`list-children.ts`](../../../../packages/subagent/subagent/src/list-children.ts); `subagent/mail` event declaration; catalog regen.
- **Work:** resolver + event type only; no delivery change.
- **Bench arm:** none.
- **Retire rule:** n/a.
- **Gates:** unit tests for envelope replay/fork gates; `pnpm run doc-sync` catalog freshness.

## Wave 2 — capability, default-off

Wave 2 does not start capability-default flips. w9 (WP0.2) may retire jspace; refinement activation stays unreachable until WP3.4's contamination probe passes.

### WP2.1 Persistent kernel minimal slice

- **Owner:** [persistent-kernel note](2026-08-26-beat-prime-agent-persistent-kernel.md). Depends on WP1.1.
- **Touch points:** new `ctx.codeKernel` seam on extracted plumbing; slot table; transactional commits; `run_code` kernel flavor; default-off.
- **Bench arm:** `off` vs `kern` vs `kern-driver` (conservative driver contrast; sq-adopt showed 16/16 on both query arms when the prompt named a prior-session recording). Powered verdict is WP3.4.
- **Retire rule:** if `kern-driver` ties or loses at powered n AND input-token ratio exceeds the cap, retire the kernel.
- **Gates:** `pnpm run test:coverage`; keyless snapshot (run #1 stores a slot, run #2 reads it); `pnpm run duplication`; `pnpm run doc-sync`.

### WP2.2 Bus phases 1–2

- **Owner:** [agent-bus note](2026-08-26-beat-prime-agent-agent-bus.md). Depends on WP1.4.
- **Touch points:** quiet durable mail under the child lock ([quiet-mode write design](2026-08-26-beat-prime-agent-agent-bus.md#quiet-mode-write-design)); then family addressing + `read_mailbox`; `NOT_CONTINUABLE` as a proposed new code.
- **Bench arm:** default-off; no powered arm in this WP. Snapshot: parent→child quiet send pending without a child turn; phase 2 sibling send framed relay.
- **Retire rule:** unused after a paired arm at powered n (a later WP) ⇒ do not default-on.
- **Gates:** `pnpm run test:coverage`; keyless snapshot; resolver-manifest `dependencies` for `read_mailbox`; `pnpm run doc-sync`.

### WP2.3 Autonomy part 3: `subagent-accounting`

- **Owner:** [autonomy-accounting note](2026-08-26-beat-prime-agent-autonomy-accounting.md). Depends on WP1.2.
- **Touch points:** new `packages/subagent/accounting`; `usageIncludingDescendants`; `costOf` with validated PriceTable Config (USD per million tokens; route-id keys); `SubagentTreeBudget` seam; bench walker.
- **Bench arm:** none (instrument). Enables honest pricing of WP3.4 subagent/kernel/refine arms.
- **Retire rule:** n/a (instrument).
- **Gates:** planted-descendant fixture; corrupt child → diagnostic + partial sum; `pnpm run test:coverage`.

### WP2.4 Refinement v0.5

- **Owner:** [refinement-loop note](2026-08-26-beat-prime-agent-refinement-loop.md). Depends on WP1.3.
- **Touch points:** `shres-harness-validate` (receipts, provenance re-verification, content screening); quarantine/rollback commands.
- **Bench arm:** contamination unit tests (seeded violations). Powered w10 is WP3.4.
- **Retire rule:** contamination-gate failure ⇒ do not build v1 activation (WP3.4).
- **Gates:** each check rejects a seeded violation; receipt-hash TOCTOU; `pnpm run test:coverage`.

## Wave 3 — surfaces and claims

### WP3.1 Autonomy part 2: Agents View

- **Owner:** [autonomy-accounting note](2026-08-26-beat-prime-agent-autonomy-accounting.md). Depends on WP1.2; pending-mail badge depends on WP2.2.
- **Touch points:** host `subagents.forest` RPC; new `packages/client/ui-agents-view`; read-only v1. Client snapshot join synthesizes ordinary roots and intermediate ordinary sessions (`listDescendants` returns only `origin === 'subagent'`).
- **Bench arm:** none (GUI). GIF from the real server/model flow.
- **Retire rule:** n/a for read-only v1. Attach/intervene is a later phase.
- **Gates:** keyless snapshot of the RPC response; GIF; `pnpm run test:coverage`; `pnpm run doc-sync`.

### WP3.2 Bus phase 3

- **Owner:** [agent-bus note](2026-08-26-beat-prime-agent-agent-bus.md). Depends on WP2.2.
- **Touch points:** apiproxy request schemas in [`packages/host/apiproxy/src/api/subagents.schema.ts`](../../../../packages/host/apiproxy/src/api/subagents.schema.ts) mapped at [`handler.ts:105`](../../../../packages/host/apiproxy/src/fetch/handler.ts); response value schemas at [`client.ts:185-188`](../../../../packages/host/apiproxy/src/fetch/client.ts); ui-subagent mail badge; [`docs/subsystems/subagent.md`](../../../../docs/subsystems/subagent.md).
- **Bench arm:** none (surface). GIF if the badge is product-user-visible.
- **Retire rule:** n/a.
- **Gates:** `pnpm run doc-sync`; GIF as required.

### WP3.3 OOLONG-lite powered external-referenced run + score-at-budget sweep

- **Owner:** [bench-strategy note](2026-08-26-beat-prime-agent-bench-strategy.md) P2+P4 and P5. Depends on WP0.1 (subagent arms unpriceable without it) and WP0.2 (honesty gate).
- **Touch points:** new `oolong-aggregate` / `oolong-pairs` tasks (pinned corpus/verifier/seed spec in the bench note); `maxTotalTokens` grid; report curve builder.
- **Bench arm:** pilot `stuffed` / `read` / `shipped`; powered `stuffed` / `shipped` / `shipped-minus`. Target delta **+31.8 pp = 0.874 − 0.556** on OOLONG-Pairs, GLM-5.2. Superiority: McNemar p<0.05, δ>0, CI lower bound ≥ 10 pp, token overhead ≤ 1.25×. Secondary TOST 31.8 ± 15 pp.
- **Retire rule:** tie/loss at powered n ⇒ do not claim; kernel/read priority follows the `read` vs stuffed result (bench note §4).
- **Gates:** intervals mandatory; `tierPatches` sha256 pin; stuffed arm refuses forced-compaction overlay.

### WP3.4 Verdict benches: kernel W-arm and refinement w10

- **Owner:** [persistent-kernel](2026-08-26-beat-prime-agent-persistent-kernel.md) and [refinement-loop](2026-08-26-beat-prime-agent-refinement-loop.md). Depends on WP1.3 → WP2.4; WP2.3 (w10 token accounting); WP2.1 (kernel arm).
- **Touch points:** kernel overlay arms `off` / `kern` / `kern-driver`; w10 two-hop tasks + **between-session-halves approval hook** (new bench runner code); contamination probe as executed vitest gate.
- **Bench arm:** kernel as above; w10 `w10-off` / `w10-propose` / `w10-gated`.
- **Retire rule:** kernel retire-if-tie at powered n; w10 lift ⇒ keep `gated` behind default-off; tie ⇒ `proposals` only; loss or contamination-gate failure ⇒ retire activation, keep the store as a manual notes UI at most.
- **Gates:** executed contamination probe; keyless snapshots already landed in WP2.1 / WP2.4.

### WP3.5 Autonomy part 1: host scheduler v1

- **Owner:** [autonomy-accounting note](2026-08-26-beat-prime-agent-autonomy-accounting.md). Depends on WP1.2. Goal rounds are a follow-up.
- **Touch points:** new `packages/schedule/host-scheduler`; delegated in-memory set; `maxTurnTokens` as `agent/pre-step` plugin (not a loop hook); `runScheduleTransaction` export (WP1.2).
- **Bench arm:** default-off, reminders only. Snapshot: cold dispatch framing text matches `renderReminderFraming` of the same record.
- **Retire rule:** unused or runaway-spend at a later paired arm ⇒ keep default-off. Goal rounds stay out of v1.
- **Gates:** enabling without persistence fails at load; `pnpm run test:coverage`; keyless snapshot of framing text.

## Dependency graph

```
WP0.1 → WP3.3, WP3.4     (subagent arms unpriceable without descendant accounting)
WP0.2 → WP3.3            (honesty gate)
WP1.1 → WP2.1
WP1.2 → WP2.3, WP3.1, WP3.5
WP1.3 → WP2.4 → WP3.4
WP1.4 → WP2.2 → WP3.2
WP2.2 → WP3.1            (pending-mail badge)
WP2.3 → WP3.4            (w10 token accounting)
```

WP1.3 / WP2.4 sit behind w9/w10 verdicts for any activation default. Wave 0 does not block Wave 1 mechanical PRs.

## Claim ledger

| After | What becomes defensible |
|---|---|
| W0 | Descendant-inclusive spend measured on stored runs; w9 charter verdict recorded (retire-or-graduate). |
| W1 | Shared worker plumbing extracted behind green gates; due-task and usage read helpers exist for every consumer. |
| W2 | Durable family mail and a persistent kernel exist behind default-off flags with pre-registered arms; refinement candidates are inert data until three components agree. |
| W3 | An externally-referenced claim with intervals on OOLONG-class tasks; Agents View forest; host scheduler wake authority; w10 refinement verdict. |

No external "beats Prime" sentence is defensible before W3's WP3.3 intervals exist, and not then if WP0.2 retired jspace and WP3.3's `read`/`shipped` arms lose.

## Effort and sequencing honesty

Totals from the five notes: **~14–17 engineer-weeks of build work** (kernel 16–20 d, bus ~2.5–3 wk, autonomy ~6–7 wk, refinement v0+v0.5 ~11–14 d) with the bench calendar (~30 days, **$32–$135**, ~415 trials; [bench-strategy](2026-08-26-beat-prime-agent-bench-strategy.md) corrected arithmetic) running in parallel. Waves 2–3 depend on wave-0 verdicts. Retire-if-tie applies per arm. The cheapest credible cut is Wave 0 + Wave 1 + WP2.4 contamination tests, which delivers honest measurement and an inert proposal store without activating anything.

## Alternatives considered

**One mega-implementation without wave 0.** Rejected — the measurement constitution forbids claims without internal gates, and the sq-adopt/w4–w8 record shows undriven or unpriced arms mislead.

**Adopting Prime's resident daemon process.** Rejected — host-scheduler-as-plugin achieves wake authority without a second long-lived binary ([autonomy note](2026-08-26-beat-prime-agent-autonomy-accounting.md)).

**Collapsing typed tools into one REPL tool.** Rejected — prior-session verdict stands ([MAPPING technique inventory item 11](../../../../MAPPING-prime-agent-2026-08-26.md)).

**Treating the refine loop as rejected.** Rejected as a reading of MAPPING: [adoption shortlist item 8](../../../../MAPPING-prime-agent-2026-08-26.md) is conditional on preconditions (a)(b)(c). The loop is deferred and designed in the [refinement-loop note](2026-08-26-beat-prime-agent-refinement-loop.md); this roadmap's WP1.3 / WP2.4 behind w9/w10 carries the deferral.

## Acceptance criteria

Every wave's WPs above have: owner note link, exact touch points, bench arm spec with pre-registered decision rule, retire rule, and gate list. `pnpm run verify-agent-note-format`, `pnpm run verify-doc-refs`, and `pnpm run doc-sync` all pass with the six notes in tree. The [MAPPING working file](../../../../MAPPING-prime-agent-2026-08-26.md) is tracked so citations resolve for other checkouts.

## Risks

1. **Adoption risk.** Undriven tools go unused — measured, not assumed (sq-adopt 16/16 when the prompt named a prior-session recording; kernel `kern-driver` is a conservative contrast).
2. **Token-cost regressions.** Caps pre-registered; retire-if-tie.
3. **100% coverage cost on lifecycle code.** Certain for kernel, scheduler, bus quiet-path, refinement store.
4. **Multi-process double dispatch for the scheduler.** Default-off, documented exclusivity, lock backstop follow-up ([autonomy note](2026-08-26-beat-prime-agent-autonomy-accounting.md)).
5. **Contamination of learned state.** Executed probe gate ([refinement-loop note](2026-08-26-beat-prime-agent-refinement-loop.md)); v1 activation unreachable until it passes.
6. **w9 on-charter timeouts.** w9-canary 2/2 on-charter `AGENT_TIMEOUT`; calendar and dollar upper bounds in the [bench note](2026-08-26-beat-prime-agent-bench-strategy.md). Fresh typo-guard canary before the powered pressure run.
