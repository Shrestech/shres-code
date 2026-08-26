# Agent Note: Host scheduler, Agents View, and descendant accounting

Status: proposed

## Problem

Three gaps versus Prime Agent, recorded in [MAPPING](../../../../MAPPING-prime-agent-2026-08-26.md): [technique inventory item 14](../../../../MAPPING-prime-agent-2026-08-26.md) (descendant accounting, NOT STARTED), [item 16](../../../../MAPPING-prime-agent-2026-08-26.md) (heartbeats / detach-resume, NOT STARTED), [item 12](../../../../MAPPING-prime-agent-2026-08-26.md) PARTIAL (family visibility), plus the Agents View UI Prime ships as its family roster.

Verified in-tree:

| Fact | Source |
|---|---|
| Schedule is **session-local by declared boundary**: `deliveryMode: 'session-local'`, "Cold Sessions do no work", timers live in a per-root-agent process-local `ScheduleRuntime` installed on later `agent/created` events only | [schedule.md](../../../../docs/subsystems/schedule.md); [`packages/schedule/schedule/src/runtime.ts`](../../../../packages/schedule/schedule/src/runtime.ts) |
| Reminder durability is already correct: strict `schedule/change` v1 union, catch-up collapses missed `every` occurrences to latest-due, at-least-once delivery with a narrow post-admission crash window | schedule.md |
| Goal continuation authority is split: durable `goal/change` phase vs process-local *activation* (armed/disarmed); a continuation consumer attributes admitted rounds via `GoalMessageSource`; `disarm()` exists precisely so lifecycle owners unload drivers | [goal.md](../../../../docs/subsystems/goal.md) |
| Continuable children already cold-resume: activation manager owns admission, `followup()` cold-resumes from persisted Session via `ctx.agents.resume()` through an activation-owner scope; `drainContinuableDescendants` disposes forests | [subagent.md](../../../../docs/subsystems/subagent.md) |
| `listDescendants(rootSessionId)` walks the complete descendant tree pre-order from a live-preferred corpus (live store + optional persistence), no Agent load, with a three-rung **identity** ladder (watermark cache → projection-checkpoint cache → one `persistence.inspect()` fold) | subagent.md; [`list-children.ts`](../../../../packages/subagent/subagent/src/list-children.ts) |
| Per-session provider-reported usage already projects: `tokenUsage` (`uncachedInputTokens/outputTokens/cacheReadTokens/cacheWriteTokens`, disjoint buckets) is a registered `SessionProjectionMap` unit folded over the whole durable log | [`packages/llm/token-meter/src/projection.ts`](../../../../packages/llm/token-meter/src/projection.ts) |
| Admission enforcement point exists: `SubagentRuntime` occupies a spawn slot synchronously before `provider.start()` and refuses at `CONCURRENCY_CAP`; follow-ups and cold resumes do not occupy | [`packages/subagent/subagent/src/index.ts`](../../../../packages/subagent/subagent/src/index.ts) (`Config.maxConcurrentSubagents`) |
| Approval is fail-closed: `'ask'` with no answerer resolves `'unavailable'` and callers deny; `'never'` deterministically rejects without dispatching any answerer; policy is a durable per-session `approval/policy` event | [approval.md](../../../../docs/subsystems/approval.md) |
| Sandbox policy resolves per call from the session cwd; nothing about it assumes an attended client | [sandbox.md](../../../../docs/subsystems/sandbox.md) |
| Web client session-list snapshot already carries `parentId`, `origin`, `running`, `pendingInteraction`, `displayTitle`; a per-parent catalog (`subagents.list` RPC over `ctx.subagents.listChildren`) with expand/collapse tree UI ships in `ui-subagent` | `packages/client/runtime/src/client/sessions/{service,manager}.ts`; `packages/client/ui-subagent` |
| Bench ships `tokensIncludingDescendants`/`costIncludingDescendants` as hard `null` with an explicit comment: descendant sessions are "not guaranteed discoverable without a recursive walk … fragile and untested in v1" | [`bench/schema/trial.js`](../../../../bench/schema/trial.js); [`bench/runner/metrics.js`](../../../../bench/runner/metrics.js) |
| Runner already copies the JSONL backend's `encodeSegment`/`projectKey` path encoding into [`bench/runner/session-layout.js`](../../../../bench/runner/session-layout.js) and filters seeded fixtures | session-layout.js |

Prime Agent contrast (from [MAPPING §1.1](../../../../MAPPING-prime-agent-2026-08-26.md) and items 12/14/16): a resident daemon whose workers survive client detach; heartbeats/cron turns; lifecycle admitted/running/idle/inactive; family mailboxes; accounting aggregates root **and descendants** (paper §2.6, METR [8]).

shres-code does not need a second daemon process to get the two capabilities that matter — **wake authority that survives process death** and **tree-honest spend**. Both decompose into (durable state we already keep) + (a host-side driver we do not yet have) + (read projections we mostly have). The genuinely new durable artifact in all three parts is zero-to-one small.

**Cold-read constraint this design must not get wrong.** The identity ladder's rung 2 (`cachedSnapshot` + own-suffix seq gate) is final for **subagent descriptors** only because those values are immutable: a stale row is still the last committed descriptor and will not accumulate. Projection rows for accumulating units are "possibly stale, never wrong" ([`session-projection-cache/src/index.ts:5-8,108-129`](../../../../packages/session/session-projection-cache/src/index.ts)). `scheduleNext` and `tokenUsage` accumulate. Using `cachedSnapshot` as the last word would under-count due work and tokens. The correct cold-read API is `SessionProjectionCache.coldSnapshot()` — checkpoint + persistence tail refold + registry restore + write-back ([`index.ts:166-197`](../../../../packages/session/session-projection-cache/src/index.ts)).

## Proposal

Three parts, independently shippable, default-off where they start work. Recommended sequence: accounting → Agents View → host scheduler (risk order). **Build first:** the `scheduleNext` projection unit + `tokenUsage` cold-read helper via `coldSnapshot()` ([roadmap WP1.2](2026-08-26-beat-prime-agent-roadmap.md)). They de-risk the ladders Parts 1 and 3 lean on and commit the repo to nothing.

The Continual Harness refine loop is **deferred** pending [MAPPING adoption-shortlist item 8](../../../../MAPPING-prime-agent-2026-08-26.md) preconditions (a)(b)(c), and is designed in the [refinement-loop note](2026-08-26-beat-prime-agent-refinement-loop.md). The [roadmap](2026-08-26-beat-prime-agent-roadmap.md) carries that deferral as WP1.3 / WP2.4 behind w9/w10 verdicts. It is not a rejected alternative.

A resident daemon *process* is rejected: the host scheduler achieves wake authority as a composition-optional plugin of the existing single process.

## Part 1 — Host scheduler (unattended wake authority)

### Problem statement

A `schedule_create` reminder or an armed goal round today dies with the client that owned the session: `ScheduleRuntime` exists only while the root Agent is live in-process, and "cold sessions do no work." Prime Agent's daemon instead keeps workers resident across detach and fires cron turns with no client attached. We want the same observable capability — a session's scheduled turn happens even if nobody is watching — without standing up a supervisor daemon in v1.

### Design

**New package `packages/schedule/host-scheduler`** (`@shres-code/shres-code-host-scheduler`), a function plugin + Service Definition `ctx.hostScheduler` with a single local provider, composed after `sessions`, `agents`, `sessionPersistence`, `sessionProjections`, and `schedule`.

The seam names Definition + Provider. It has no model-facing Consumer: model-visible output is the existing reminder framing owned by the schedule Consumer. **Non-model consumers** of scheduler-owned state: the Agents View forest assembler (reads `effectiveApproval` from the `scheduleNext` projection and delegated/cold/due status) and the dispatch loop itself. The bench walker consumes accounting, not this seam.

**(a) Promote wake authority out of the process-local schedule.**

Keep `ScheduleRuntime` exactly as-is for live agents — it is correct, tested, and its idle-phase/maintenance discipline is subtle. The scheduler claims only the cases `ScheduleRuntime` cannot see:

1. A **cold session** (persisted header present, no live root Agent) whose durable fold says work is due.
2. A **live session whose runtime faulted** (`faulted` flag) or whose host composition lacks the schedule plugin but has persisted reminders — the scheduler treats these identically via the fold, not via runtime internals.

**Delegated-set mechanism (decision).** The scheduler holds an in-memory `Set<SessionId>` of sessions whose live `ScheduleRuntime` is authoritative. Rebuilt at boot by enumerating `ctx.agents` for roots that have a runtime installed. Mark on `agent/created` when the schedule plugin installs a runtime; unmark on agent disposal and on fault (`faulted` flag) so the scheduler reclaims authority. The set is not durable: after a crash it is empty until `agent/created` fires again, which is the correct "cold until live" default.

Authority handoff rule (prevents double dispatch): for a live root Agent in the delegated set, the existing runtime stays authoritative; the scheduler does not dispatch. For a cold session (id not in the set), the scheduler is authoritative until its own resume makes the agent live, at which point `agent/created` marks it delegated. Because both authorities act only through the same serialized transaction (`runScheduleTransaction`) and dispatch is durably recorded (at-least-once, below), the worst race is a repeated reminder, which is already the documented boundary.

**`runScheduleTransaction` export.** The function exists at [`packages/schedule/schedule/src/transaction.ts:13`](../../../../packages/schedule/schedule/src/transaction.ts) and is used internally by runtime and tools. It is **not** re-exported from [`packages/schedule/schedule/src/index.ts`](../../../../packages/schedule/schedule/src/index.ts). The single-writer claim requires adding it to that package's public exports. Touch point listed in the appendix.

**(b) The durable due-tasks table is derived, not stored.**

Do not introduce a second durable format. The session log is already the durable authority; the scheduler maintains an **in-memory due-index rebuilt from scratch at boot**:

- Enumerate candidates once: merge `ctx.sessionPersistence.list()` (headers only — includes `id`, `createdAt`, `cwd`) with `ctx.sessions.list()` (live-preferred, same merge `listDescendants` uses).
- For each **live** candidate, read `scheduleNext` from the projection registry (watermark is current).
- For each **cold** candidate, obtain `scheduleNext` via `SessionProjectionCache.coldSnapshot()` — not `cachedSnapshot()`. Register a tiny **`scheduleNext` projection unit** in `shres-schedule` itself: `{ nextDueAt: string | null, activeOneShots: number, activeEvery: number, effectiveApproval: 'ask' | 'never' }` (whole-value, `stateVersion: 1`). This is ~80 lines and gives every consumer — scheduler now, Agents View later — a due answer for cached sessions that is then made current by the tail refold.

**`scheduleNext` staleness story.** `cachedSnapshot` may lag the log end ("possibly stale, never wrong"). For a due-index that decides whether to start a model turn, under-counting `nextDueAt` (missing a just-appended reminder in the tail) would skip work; over-counting cannot happen because the unit is last-wins on the log. Therefore cold reads always go through `coldSnapshot()`. Between boots the index refreshes incrementally: live `session/event` subscriptions for mounted sessions; re-inspection for cold sessions whose **opaque revision from `listSnapshots()`** advances ([`session-persistence/src/index.ts:231-243`](../../../../packages/session/session-persistence/src/index.ts)). `SessionHeader` has no `updatedAt`.

Crash safety then costs nothing: after a crash the index is empty, boot rebuilds it from durable truth, and overdue work is simply *due*. The `every` catch-up semantics (latest-due occurrence, never replaying missed intervals) carry over unchanged because the scheduler consumes the identical fold.

**Dispatch protocol for a cold due session** (mirrors the continuable cold-resume path; no new machinery):

```
claim (bounded concurrent resumes, config maxConcurrentResumes)
→ ctx.agents.resume(sessionId) via a scheduler-owned activation scope
→ await idle boundary (same whenIdle() discipline as ScheduleRuntime)
→ runScheduleTransaction: refold → sample decision time
→ agent.followup(reminder framing)          // existing stable framing, deterministically rendered
→ append schedule/change dispatch           // same event, same validator
→ release: drainContinuableDescendants([agent]) → handle disposal
```

Goal rounds are **phase 2** and deliberately out of v1: the same skeleton works (resume → check `activation === armed && phase active && roundsStarted < maxGoalRounds` → submit one user message carrying `GoalMessageSource` attribution), but goal rounds are autonomous continuation, which multiplies the blast radius of every failure mode below. Ship reminders first; they are bounded, framed, and already treated as untrusted content.

**(c) Crash-safe catch-up.** Covered by (b) plus two explicit rules:

- *At-least-once, unchanged.* Queue-followup-before-dispatch-append keeps the existing narrow repeat window; the doc sentence "best-effort at-least-once rather than exactly-once delivery" stays true verbatim for cold dispatch.
- *Single-writer fence.* Two host processes sharing one persistence root (CLI open in another terminal + web app) could both fire. V1 answers with configuration honesty rather than locking: `enabled` defaults to `false`, and enabling is a per-deployment decision documented as "exactly one host process may enable the scheduler per persistence root." A cheap hard backstop — an advisory lock row in the SQLite backend or a `flock` on the JSONL project directory, held for the process lifetime, startup proceeds in observe-only mode if the lock is taken — is a contained follow-up (~1 day) and should land before any multi-window deployment, not before the feature.

**(d) Interaction with sandbox/approval.**

An unattended turn changes who can answer a question, and the approval seam already encodes the entire answer:

- Effective policy `'ask'` with no human answerer composed → every gated ask resolves `'unavailable'` → the tool result fails closed. This is **correct behavior, not a bug to route around**: a reminder turn still delivers its framing, the model does what needs no elevation, and gated tools refuse with a legible error. Nothing leaks.
- Policy `'never'` (the documented "CI, unattended runs" stance) deterministically rejects without paging anyone — the honest default posture for scheduled sessions.
- Permission presets remain the mechanism for pre-granted authority; an unattended deployment composes presets deliberately, per session, and the grant is visible in the session's own log.

Scheduler rules that follow:

1. The scheduler **never widens approval or sandbox policy**. No new outcome variant, no deferred-answer mailbox in v1, no bypass path. Landlock/Seatbelt/ACL resolution is per-call from session cwd and is untouched by attendance.
2. The `scheduleNext` unit gains `effectiveApproval: 'ask' | 'never'` so the Agents View can render "will fail closed if fired" *before* it fires (Part 2 consumes this).
3. A cold-resumed turn that exhausts its work hits the already-shipped guards: `maxStepsPerTurn` ([`packages/guard/step-budget`](../../../../packages/guard/step-budget) `agent/pre-step` plugin), repeat-tool veto, optional tool timeout (commit `3b2bc1b157`). Add one scheduler-owned ceiling: `maxTurnTokens` per dispatched turn, implemented as an **`agent/pre-step` plugin** in the host-scheduler package (same extension point as step-budget; "Plugins, not loop changes"). There is no loop budget hook. Default generous, config-declarable. Rationale: the process that would have been watching is not; the cost bound must be declarable, not assumed.
4. Misconfiguration fails loud at the resolvable point: a cordis.yml that enables the scheduler without mounting persistence is a composition error (static `inject` of `sessionPersistence` on the scheduler plugin), not a silent no-op. Persistence is **required** for the scheduler plugin (it cannot dispatch cold work without it). That is a different posture from Part 3's listing optionality.

**(e) Config (all validated, default-off):**

```ts
interface Config {
  /** Master switch. Default false: no scanning, no timers, no resumes. */
  readonly enabled: boolean
  /** Simultaneously cold-resumed sessions. Default 2. */
  readonly maxConcurrentResumes?: number      // positive safe integer
  /** Token ceiling applied to one dispatched unattended turn. Default 100_000. */
  readonly maxTurnTokens?: number             // positive safe integer
  /** Boot re-scan interval for cold index maintenance. Default 60_000 ms. */
  readonly rescanMs?: number                  // ≥ 5_000
}
```

Model-visible surface: none beyond the existing reminder framing (a cold dispatch produces the **deterministically rendered, same framing text** as a live `ScheduleRuntime` dispatch — [`renderReminderFraming` at `domain.ts:779-806`](../../../../packages/schedule/schedule/src/domain.ts)). No byte-sequence is reproduced across processes; the function is deterministic given the record. Snapshot coverage therefore rides the existing schedule snapshot harness plus a headless fixture asserting the cold path emits the same framing text.

**Non-trivial-change obligations:** Agent Note (this file), README, schedule.md subsection, persistence-catalog entry for `scheduleNext`.

### Effort and risk

- **Effort: ~2.5–3 engineer-weeks.** Projection unit + `coldSnapshot` helper ≈ 3 d; scheduler service, index, dispatch, teardown ≈ 7 d; config/validation/error taxonomy ≈ 2 d; tests (unit + invariant + snapshot fixture) ≈ 4 d; docs/notes ≈ 2 d. Advisory-lock backstop +1 d. Phase-2 goal rounds +1 wk.
- **Risk: HIGH (of the three parts)** — it is the only part that starts model turns with no human present.
  - Runaway unattended spend: mitigated (turn ceilings, step guards), residual medium.
  - Multi-process double dispatch: mitigated (default-off, documented exclusivity, lock backstop), residual medium-low.
  - Useless fail-closed turns annoying users: real but low-severity; Agents View surfaces `effectiveApproval` so it is legible.
  - Cold-resume bugs destabilizing the activation manager: low — the manager's cold resume is already product-tested for continuable children; the scheduler is one more caller through `ctx.agents.resume()`.

## Part 2 — Agents View (read-only forest)

### Problem statement

Prime Agent's Agents View shows the live family forest with per-node status and mailboxes. shres-code's web client already shows a flat session list with lineage fields and a per-parent expandable subagent catalog, but there is no single forest projection spanning roots → descendants, and cold (storage-only) grandchildren are invisible unless their parent is expanded through `listChildren`.

### Design

**Host read API — one new unary method**, `subagents.forest` in `packages/host/apiproxy` (alongside the existing `subagents.list`):

```
request:  { workspaceId }                    // or no payload: all known roots
response: { roots: SessionId[],
            nodes: ForestNode[],             // flattened pre-order; client links by parentId
            servedAt: string }

ForestNode = {
  id: SessionId
  parentId: SessionId | null                // null for roots
  depth: number
  // identity block, exactly SubagentListEntry's child/diagnostic discriminated union:
  // mode ('one-shot'|'continuable'), label?, activity ('running'|'inactive'),
  // hasChildren, diagnostic? ('corrupt'|'unsupported'|'unavailable')
  // plus, for ROOT rows: displayTitle/cwd mirrored from the session summary
  effectiveApproval?: 'ask' | 'never'       // from Part 1's projection unit when mounted
  pendingInteraction?: PendingInteractionStatus   // joined from the session list snapshot
  pendingMail?: number                      // from the bus projection when [WP2.2] lands
}
```

**Who synthesizes which rows (decision).** `listDescendants` returns only `origin === 'subagent'` rows ([`list-children.ts:142,235,324`](../../../../packages/subagent/subagent/src/list-children.ts)). It does not return intermediate ordinary sessions or the root enumeration corpus. Split:

- **Host `subagents.forest`:** for each requested root, emit the root row (identity from the session summary) plus every `listDescendants(rootId)` row. Roots are enumerated from the request (`workspaceId`) joined with `ctx.sessions.list()` and optional `ctx.sessionPersistence.list()` — the same live-preferred merge listing already uses — **not** from `listDescendants`.
- **Client:** builds parent→children maps from `sessions.list.getSnapshot()` (already has `parentId` / `origin` / `running` for everything the host listed). Intermediate **ordinary** sessions that sit between a root and a subagent (forks, user-created children with `origin !== 'subagent'`) come from that snapshot join. The client lazily fetches `subagents.forest` only for subtrees the snapshot cannot resolve cold (storage-only grandchildren).

Implementation of the host method is a thin loop over `ctx.subagents.listDescendants(rootId)` per root, with the same bounded-concurrency and cancellation discipline `listDescendants` already applies internally. **Read-only guarantee inherits for free:** `listDescendants` never loads or resumes an Agent. One-shot children appear as traversal nodes exactly as the seam already treats them. No new session events, no new durable state.

Refresh: client pulls on open and subscribes to the existing session-list mutation stream (`running` flips, upserts) for live deltas; full re-pull on forest-level invalidation. Do not invent a push frame in v1 — the manager's stale-refresh pattern (`catalogStale` trailing refresh) is the precedent for pull-plus-trailing-reconcile.

**Per-node status/mailbox — v1 vocabulary, honestly named:**

| Node state | Meaning | Source |
|---|---|---|
| `running` | logical record live, driver active | `activity` |
| `idle` | storage-only continuable child; resumable | continuable + `inactive` |
| `waiting-input` | pendingInteraction present (approval/question blocking) | session summary join |
| `inactive` | one-shot settled / cold non-resumable | mode + activity |
| `diagnostic` | corrupt/unavailable record | entry kind |

True mailbox depth is **deferred to [WP2.2](2026-08-26-beat-prime-agent-roadmap.md) / [WP3.1](2026-08-26-beat-prime-agent-roadmap.md)**: the bus note owns pending-mail counts. v1 renders the five-state vocabulary above and reserves a badge slot so adding mailbox counts later is additive, not a redesign. (This matches the mapping's verdict that family mailboxes are PARTIAL; the UI should not fake more than the seam says.)

**Client — new package `packages/client/ui-agents-view`**, cloned from the `ui-subagent` pattern:

- Empty host `apply()`; browser half via `shres.client` declaration; `inject: ['sessions', 'locale', 'slots']`.
- Tree component: snapshot join as above. Collapse/expand state per node; locale keys mirror `ui-subagent`'s existing `branch.collapse/expand`, `count.total`, `mode.*`, `activity.*` vocabulary — extend, don't fork, the `SubagentKey` namespace or register a sibling namespace reusing the strings.
- Node interaction v1: click navigates to the session (existing navigation); offline continuable child gets the existing read-only composer takeover. Attach/intervene (send_message / interrupt buttons gated on `parentAvailable`, using the already-shipped `subagents.prompt`/`subagents.interrupt` RPCs) is the declared **later phase** — the wire methods exist today, so it is UI work only.
- Mount point: a sidebar tab slot (ui-slots), not a route rewrite.

**Scale guard (UI constants, not Config).** Cap initial render at depth ≤ 8 and 500 nodes with an explicit "load more". These are render-safety constants in the client package (comment citing Prime Factorio 633 depth-one children: eager render of that forest would freeze the tab). They are not deployment-varying policy and do not belong on `Config`. Diagnostics render per-node, never hiding siblings (the `unavailable` retry-on-next-listing semantic comes along automatically).

**Obligations:** this is product-user-visible GUI behavior ⇒ the PR carries a GIF recorded from the real server/model flow (record-browser-gif skill), keyless snapshot coverage if any host-served output shape changes (it does: new RPC response), Agent Note for the read-API decision, api docs update.

### Effort and risk

- **Effort: ~1.5–2 engineer-weeks.** Host `forest` method + tests ≈ 3–4 d; client package (component, locales, tests, slots) ≈ 5–6 d; docs/snapshots/GIF ≈ 2 d. Attach/intervene phase +3–4 d later.
- **Risk: LOW-MEDIUM.**
  - Stale identity flicker between list snapshot and forest pull — solved pattern exists (`parentAvailableOverride` replay in the manager); reuse it.
  - Very large forests — capped rendering; host method is O(descendants) reads with bounded concurrency already proven in `listDescendants`.
  - Scope creep toward "intervene now" — explicitly phased; v1 PR is read-only and reviewable alone.

## Part 3 — Descendant token/cost roll-up

### Problem statement

`bench/schema/trial.js` declares `tokensIncludingDescendants`/`costIncludingDescendants` and the runner hard-fills `null` (`metrics.js`): the runner sees only the top-level session root. Prime Agent aggregates root + descendants (paper §2.6; METR [8] makes descendant-inclusive spend the eval stance). Without it, subagent arms are unpriceable — [MAPPING adoption shortlist item 2](../../../../MAPPING-prime-agent-2026-08-26.md).

### Design

**Three pieces: a service-side aggregator, a bench walker, a budget seam.**

**(a) Aggregator — new package `packages/subagent/accounting`** (`@shres-code/shres-code-subagent-accounting`).

**Inject posture (decision):** follow [`list-children.ts:209-213`](../../../../packages/subagent/subagent/src/list-children.ts). Static `inject` lists `subagents` and `sessionProjections`. `sessionPersistence` and `sessionProjectionCache` are obtained via runtime `ctx.get()` and are optional: an absent cache means every cold candidate takes the authoritative `inspect` rung; an absent persistence means only live sessions contribute (same as listing). Do not list persistence as a hard `inject` while calling it optional in prose.

```ts
interface TreeUsage {
  readonly root: SessionId
  /** Provider-reported buckets summed over the root session itself. */
  readonly rootUsage: TokenUsageProjection | null     // null: no usage ever reported
  /** Same buckets summed over every healthy session-backed descendant. */
  readonly descendantUsage: TokenUsageProjection
  /** Number of descendant sessions contributing; excludes diagnostics. */
  readonly countedSessions: number
  /** Per-descendant failures, mirroring SubagentListEntry diagnostics. */
  readonly diagnostics: readonly { id: SessionId; reason: 'corrupt' | 'unavailable' }[]
}

// ctx.subagentAccounting
usageIncludingDescendants(root: SessionId, signal?: AbortSignal): Promise<TreeUsage>
costOf(usage: TreeUsage, prices: PriceTable): UsdBreakdown | undefined
```

Mechanics: one `listDescendants(root)` call, then per node read its **`tokenUsage` projection value**:

- Live: registry watermark (current).
- Cold: `SessionProjectionCache.coldSnapshot()` when the cache is mounted; otherwise one bounded-concurrency `persistence.inspect()` refold. **Not** `cachedSnapshot()` — `tokenUsage` accumulates.

Sum disjoint buckets; never mix in heuristic estimates — provider-reported only.

**PriceTable (decision).**

```ts
/** USD per million tokens, four disjoint buckets. */
interface PriceRow {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/**
 * Keyed by the composed llm route id as it appears in the session's model
 * selection (cordis route name, e.g. `zai`, `ollama-cloud`) — not a free-form
 * provider string and not the run.json `model` field (that field can record
 * `deepseek-v4-flash` even on zai-tier runs; see the bench note).
 */
type PriceTable = Readonly<Record<string, PriceRow>>
```

No price table exists in-tree and none may be invented here (hardcoded tunables rule; pricing is deployment-varying and stale-prices-are-wrong). `PriceTable` is a validated Config field on the accounting package, optional; absent table ⇒ `costOf` returns `undefined` and the wire field stays null. Tokens ship regardless. Per-arm prices in the bench come from the run manifest `pricing` field (same table, keyed the same way).

Known honesty boundary, documented on the type: **remote providers (ACP/Codex/Claude Code backends) produce no session-backed child logs**, so their descendants are invisible and simply do not contribute — the same boundary `SubagentRun.id` already documents ("without a local child Session… absent from durable enumeration"). `countedSessions` makes coverage explicit so a report cannot silently equate "sum" with "everything."

**(b) Bench wiring — close the nulls.**

Extend [`bench/runner/session-layout.js`](../../../../bench/runner/session-layout.js) with a zero-dependency descendant walk (bench imports no workspace packages; it already re-implements the JSONL path encoding):

1. Locate the trial root log (existing `findSessionLog`).
2. Scan the trial arm's project directory (`projectKey(cwd)` — children inherit cwd, so they share it) reading **first lines only** (headers) of every `*.jsonl`, collecting `{ id, parentSession, origin, delegationDepth }`.
3. BFS from the trial root over `parentSession` edges; ignore seeded fixtures (`isSeededPriorSession` already exists). Depth>0 identification is the **header's** `parentSession` pointing into the trial tree, not directory position — this retires exactly the "fragile recursive walk" the schema comment feared ([`trial.js:31`](../../../../bench/schema/trial.js)), because the walk now keys on durable headers and runs once per completed trial against files that are closed.
4. Full-fold each reached log, **root included**, with token-meter semantics: `usageOf` from [`packages/llm/token-meter/src/usage-projection.ts:75-80`](../../../../packages/llm/token-meter/src/usage-projection.ts) (`assistant/chunk {type:'usage'}` then `assistant/message.usage` fallback). Extract a shared `foldUsage(lines)` helper in the bench runner rather than duplicating. Today's [`metrics.js:258-265`](../../../../bench/runner/metrics.js) reads **only** `assistant/message` usage; WP0.1 switches both root `inputTokens`/`outputTokens` and the descendant walk to `usageOf` so numerator and denominator stay symmetric. Until that switch, do not compare `tokensIncludingDescendants` to the old message-only root fields.
5. Fill `tokensIncludingDescendants` (= Σ input+output over descendants; the field's declared meaning) and `costIncludingDescendants` from an arm-configured price table in the run manifest (`bench/schema/run-manifest.js` gains optional `pricing`).

Add `descendantSessionCount` — justified: coverage honesty per (a). Do not add other new schema fields beyond making the two nulls real numbers.

**(c) Tree-wide budget enforcement point — subagent admission.**

The only correct chokepoint is where occupancy is already acquired synchronously: `SubagentRuntime.start()`/`startContinuable()` immediately before/at slot acquisition, beside the `CONCURRENCY_CAP` refusal. Placing it later (tool layer, provider, loop) admits children the tree already cannot afford.

Dependency-direction problem: accounting consumes `subagents` (for `listDescendants`), so subagent cannot import accounting. Solution — define the seam where it is consumed:

```ts
// packages/subagent/subagent — new abstract seam, optionally implemented:
interface SubagentTreeBudget {
  /** Tokens already spent by this root's tree, provider-reported. */
  spentIncludingDescendants(root: SessionId): number | undefined   // undefined: unknown ⇒ admit
}

// SubagentRuntime.Config gains:
/** Refuse new children once the root's tree exceeds this many billed tokens.
 *  Requires a mounted SubagentTreeBudget implementation; a configured cap
 *  without one is a load-time composition error (fail loud). Default 'unlimited'. */
readonly maxTreeTokensPerRoot?: number | 'unlimited'
```

Refusal is a typed `SubagentError('TREE_BUDGET_EXHAUSTED')` carrying `{ root, spent, cap }`; the delegation tool layer maps it to an `isError` tool result exactly as it maps `CONCURRENCY_CAP`. `undefined` (no usage yet, no accounting mounted at runtime despite valid composition) admits — budget enforcement is best-effort at admission granularity, and the doc says so; the hard stop for runaway remains Part 1's turn ceilings and the bench's `BUDGET_EXCEEDED` failure mode.

**Admission cache observation (decision).** There is no named `tokenUsage` change feed. The accounting package keeps a per-root spent cache and invalidates it when:

- a live session under that root appends an `assistant/chunk` usage chunk or `assistant/message` with usage (`session/event` subscription on mounted sessions), or
- the projection registry watermark for that session's `tokenUsage` unit advances.

Repeat queries after an invalidation re-read the live watermark (O(1)) or a coldSnapshot for cold nodes. This is the observation path; do not invent a new event type for it.

**Obligations:** Agent Note (derived-not-stored aggregation + admission chokepoint), subagent.md + token-meter.md cross-links, bench README un-null note, unit tests for ladder-miss paths (cache absent → inspect; corrupt child → diagnostic, partial sums still returned), runner tests with planted child fixtures (fixture style already exists for prior-session planting).

### Effort and risk

- **Effort: ~1.5–2 engineer-weeks.** Aggregator package + tests ≈ 4 d; budget seam + error mapping + validation ≈ 3 d; bench walk + manifest pricing + tests ≈ 4 d; docs/notes ≈ 2 d.
- **Risk: LOW** — additive everywhere, no lifecycle change, no model-visible surface, and it deletes a documented dishonesty (null spend) from the eval instrument.
  - Remote-backend blindness: documented, `countedSessions` exposes it.
  - Inspect-storm on huge cold trees: bounded concurrency inherited; cache makes repeat queries cheap.
  - Budget check racing concurrent spend: accepted and documented (admission-time sampling, not reservation); the cap is a guardrail, not an invoice.

## Ordering, totals, and the one thing to build first

**Recommended sequence: 3 → 2 → 1** (risk order). The [roadmap](2026-08-26-beat-prime-agent-roadmap.md) maps these to WP2.3, WP3.1, WP3.5, with WP1.2 as the shared foundation.

| Part | Effort | Risk | Why this order |
|---|---|---|---|
| 3 Accounting | ~1.5–2 wk | LOW | Pure additive; unblocks priced subagent-arm evaluation (w-class experiments) immediately; its `tokenUsage` reads are reused by Part 2's status column. |
| 2 Agents View | ~1.5–2 wk | LOW-MED | Consumes only shipped seams; becomes the observation surface Part 1 needs (blocked/unattended nodes visible). |
| 1 Host scheduler | ~2.5–3 wk | HIGH | Highest risk; benefits from both predecessors being shippable and observed. Phase-2 (goal rounds) follows separately. |

**Total: ~6–7 engineer-weeks** for all three v1 scopes, excluding the scheduler's phase-2 goal rounds (+1 wk) and Agents View attach/intervene (+~0.5 wk).

**Build first:** the `scheduleNext` projection unit + `tokenUsage` `coldSnapshot()` read helper. They are days of work, independently useful, de-risk the ladders both Part 1 and Part 3 lean on, and neither commits the repo to anything.

## Alternatives considered

**Adopting Prime's resident daemon process.** Rejected — host-scheduler-as-plugin achieves wake authority without a second long-lived binary, which fits the everything-is-a-plugin architecture.

**A Continual-Harness-style refine loop as part of this work.** Not adopted here. It is **deferred** pending [MAPPING adoption-shortlist item 8](../../../../MAPPING-prime-agent-2026-08-26.md) preconditions (a) least-privilege write targets, (b) refine cannot author charter/policy the executor trusts, (c) capability-floor measurement, and is designed in the [refinement-loop note](2026-08-26-beat-prime-agent-refinement-loop.md). Roadmap WP1.3 / WP2.4 sit behind w9/w10 verdicts.

**Using the identity ladder's `cachedSnapshot` for `scheduleNext` / `tokenUsage`.** Rejected — those units accumulate; a possibly-stale checkpoint under-counts due work and spend. `coldSnapshot()` is the cold-read API.

**A loop-owned `maxTurnTokens` hook.** Rejected — "Plugins, not loop changes." The extension point is `agent/pre-step`, same as [`packages/guard/step-budget`](../../../../packages/guard/step-budget).

**Hard-`inject` persistence on the accounting package while calling it optional.** Rejected — follow `list-children.ts` runtime `ctx.get()` optionality. (The scheduler plugin, by contrast, **does** require persistence: it cannot dispatch cold work without it.)

**Self-attested completion.** Rejected, consistent with [MAPPING §6](../../../../MAPPING-prime-agent-2026-08-26.md): executor-enforced charter stands.

**Putting Agents View depth/node caps on Config.** Rejected — they are render-safety UI constants, not deployment-varying policy.

## Acceptance criteria

- WP1.2: `scheduleNext` unit is registered; `coldSnapshot()` helper has unit tests that a tail event after a checkpoint is visible in the returned value and invisible in `cachedSnapshot`. `runScheduleTransaction` is exported from `@shres-code/shres-code-schedule`.
- WP2.3: `usageIncludingDescendants` returns partial sums plus diagnostics on a planted corrupt child; `costOf` returns `undefined` without a PriceTable; bench `tokensIncludingDescendants` is a number on a planted descendant fixture; root and descendant folds both use `usageOf`.
- WP3.1: `subagents.forest` returns roots from the listing corpus plus `origin === 'subagent'` descendants; a client snapshot join shows an intermediate ordinary session; GIF from the real server/model flow; keyless snapshot of the RPC response.
- WP3.5: default-off; enabling without persistence fails at load; a cold persisted reminder is dispatched with `renderReminderFraming` text matching a live dispatch of the same record; delegated set unmarks on fault; `maxTurnTokens` is an `agent/pre-step` plugin. Goal rounds are out of v1.
- `pnpm run test:coverage`, `pnpm run duplication`, `pnpm run doc-sync` pass. Product-user-visible GUI carries a GIF.

## Risks

1. **Runaway unattended spend.** Mitigated by `maxTurnTokens` (pre-step plugin) and `maxStepsPerTurn`; residual medium.
2. **Multi-process double dispatch.** Mitigated by default-off, documented exclusivity, lock backstop follow-up; residual medium-low.
3. **100% coverage on lifecycle/dispatch.** Certain cost. Smallest possible scheduler surface; reuse continuable cold-resume.
4. **Stale identity flicker in the forest.** Reuse `parentAvailableOverride`.
5. **Admission budget racing concurrent spend.** Documented: sampling, not reservation.
6. **Adoption of Agents View / scheduler.** Measured, not assumed; both default-off.

## Appendix: exact touch points

| File/package | Change |
|---|---|
| [`packages/schedule/schedule/src/index.ts`](../../../../packages/schedule/schedule/src/index.ts) | Export `runScheduleTransaction`; register `scheduleNext` unit |
| [`packages/schedule/schedule/src/transaction.ts`](../../../../packages/schedule/schedule/src/transaction.ts) | Existing function; public export |
| new `packages/schedule/host-scheduler` | `ctx.hostScheduler` Definition + Provider; delegated set; due-index; `maxTurnTokens` pre-step plugin |
| [`packages/session/session-projection-cache/src/index.ts`](../../../../packages/session/session-projection-cache/src/index.ts) | `coldSnapshot()` consumed, not extended |
| new `packages/subagent/accounting` | `usageIncludingDescendants`, `costOf`, PriceTable Config, tree-budget implementation |
| [`packages/subagent/subagent/src/index.ts`](../../../../packages/subagent/subagent/src/index.ts) | `SubagentTreeBudget` seam, `maxTreeTokensPerRoot`, `TREE_BUDGET_EXHAUSTED` |
| [`packages/host/apiproxy`](../../../../packages/host/apiproxy) | `subagents.forest` RPC |
| new `packages/client/ui-agents-view` | forest UI; depth/node constants |
| [`bench/runner/session-layout.js`](../../../../bench/runner/session-layout.js), [`metrics.js`](../../../../bench/runner/metrics.js) | descendant walk; `usageOf` for root and descendants |
| [`docs/subsystems/schedule.md`](../../../../docs/subsystems/schedule.md), [subagent.md](../../../../docs/subsystems/subagent.md) | scheduler subsection; accounting cross-links |
