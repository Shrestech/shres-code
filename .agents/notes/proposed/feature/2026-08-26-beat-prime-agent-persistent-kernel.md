# Agent Note: Opt-in persistent session-scoped execution kernel (RLM L2)

Status: proposed

## Problem

Prime Agent's L2 is a persistent REPL whose retained values live outside the context window until selected; the paper describes "agentic garbage collection" as the model creating, retaining, summarizing, and deleting values and children. [PRO-LONG](https://arxiv.org/abs/2607.20064) prices the largest single step of that family at **+11.1 pp** (read-only 23.1 → +Python-over-log 38.3 on their tool ladder). Our session-query Consumer covers grep/read of typed events but is not a programmatic kernel over retained state — [MAPPING technique inventory items 2 and 11](../../../../MAPPING-prime-agent-2026-08-26.md) record the gap as PARTIAL (structured query, not a REPL over the log) and NOT STARTED / DELIBERATELY DIVERGED as default (no collapse of typed tools into one Python tool).

Two house facts shape every choice below:

1. **Presence-only state fails here.** w4–w8: offer-based capture cost 1.6–2.9× tokens with zero pass-rate lift; session-query recorded 0 spontaneous calls across 100+ of those trials ([MAPPING](../../../../MAPPING-prime-agent-2026-08-26.md) technique inventory item 2). [`sq-adopt-2026-08-26`](../../implemented/testing/2026-08-26-session-query-adoption-experiment.md) then showed **16/16 success on both arms** (`sq-only` 1–2 calls, `sq-driver` 2) when the prompt named a prior-session recording — "The driver line is indistinguishable at ceiling" ([W0 eval note](../testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md), Session-query adoption result). The adoption verdict is that prompts naming a prior-session recording get used without a nudge. The kernel still includes a `kern-driver` contrast as a **conservative design choice**: kernel is a new program surface (not a mounted query tool whose schema already names the verbs), so spontaneous adoption of `state.*` is unmeasured; the driver arm isolates that variable rather than copying the sq-adopt result.
2. **Everything model-visible must be reconstructable from the log** ([reconstructable-requests note](../../implemented/architecture/2026-07-05-reconstructable-requests.md): anyone holding the log reconstructs every loop request byte-for-byte, enforced by the agent-loop invariant companion). Retained kernel values influence later tool results, so they must be durably referenced too. The attachments precedent — immutable content-addressed objects the log references — is the in-tree pattern this design reuses.

## Proposal

Build an **opt-in, default-off, per-session persistent execution kernel** as a new sibling capability seam `ctx.codeKernel` (Service Definition `shres-code-kernel`, Provider `shres-code-kernel-worker-thread`, Consumers in `shres-tools` plus a caps/log policy). Keep typed tools intact: collapsing them into one REPL tool is rejected ([MAPPING technique inventory item 11](../../../../MAPPING-prime-agent-2026-08-26.md); prior-session verdict stands). Satisfy model-visible ⟺ logged. Measure on the existing W0 bench with a pre-registered paired arm, including a conservative `kern-driver` contrast.

The recommended sequencing is [WP1.1](2026-08-26-beat-prime-agent-roadmap.md) (extract worker-shared plumbing) then [WP2.1](2026-08-26-beat-prime-agent-roadmap.md) (minimal kernel slice, default-off, driver bench arm).

## Lifecycle

### Scope identity

One kernel scope per **SessionId**, created lazily on the first kernel-mode run. Keyed by session id — no separate incarnation id — matching continuable children ("one Session has at most one live Activation"). A scope handle (`Branded<'KernelScopeId'>`) is minted from the SessionId; programs never see raw strings cross-boundary (opaque-branded-ids rule). Whether `kernelId` on events is this branded id or a plain string is an [open decision](#open-decisions).

### Resident worker

The kernel provider runs ONE long-lived worker thread per scope instead of one per run:

- Created on first use with the worker-thread runtime's proven hardening: `env: {}`, `execArgv: []`, `resourceLimits.maxOldGenerationSizeMb`, hostile-peer port parsing (`parseWorkerMessage`-style rebuild), null-prototype globals.
- Survives steps: the worker stays resident between tool calls across turns. The agent loop never touches it; only the tool consumer does, through the service.
- Idle TTL (config `idleTtlMs`, default 300_000): a timer disposes to quiescence (terminate + await) exactly like the current teardown contract.
- Session end / goal close / plugin unload disposes; drain mirrors the continuation manager's child-first disposal pattern.

### Recycle-and-rehydrate (crash/restart safety)

**Kernel memory is the slot table.** Everything durable lives in named slots backed by content-addressed artifacts ([State model](#state-model)). The resident worker holds only a materialized cache of slots plus in-flight locals. Consequences:

- Any worker death (OOM, timeout kill, recycle policy, process restart) loses nothing durable: rehydrate = fold `kernel/*` events from the log for slot metadata, lazily load artifact bytes on first access, verify each SHA-256, fail loud on mismatch. Loud digest refusal matches [attachment-local `store.ts:189-193`](../../../../packages/attachment/attachment-local/src/store.ts), not subagent-descriptor listings: descriptor corruption is a contained `corrupt` diagnostic ([`list-children.ts:267-268,394-406`](../../../../packages/subagent/subagent/src/list-children.ts)).
- Recycle policy is **`recycleAfterRuns`** (validated config; restart the worker transparently between runs to bound leak damage). A bytes-watermark alternative is recorded under [Alternatives considered](#alternatives-considered). Cold resume after a host restart starts an empty worker and hydrates on demand — resume drift is attributable because slot refs are logged events (corollary #3 of the reconstructability note).
- Serialization format v0: lossless JSON per slot (the existing `CodeJsonValue` boundary). Functions, class instances, live handles are rejected loud at `set` time with guidance to store data, not closures. Structured-clone extension deferred.

### Relation to continuable subagents

- Each continuable child session gets its own independent scope on first use; parent and child never share slots. Cross-agent data moves through the existing channels: `report`/`send_message` payloads, or spill/kernel artifacts reachable by locator.
- Fork inheritance follows the spill rule: forked sessions inherit artifacts referenced by seeded-log events; they are not copied or re-owned; post-fork writes land under the child's namespace. The fold rule for inherited `kernel/*` events (ignore / remap / read-only) is an [open decision](#open-decisions).
- Deliberately deferred: `inheritKernel` slot-subset spawning at delegation time. It couples two seams for unproven value; revisit only if a bench arm shows parent→child data handoff dominating token cost.

## State model

### What persists

A flat named-slot table per scope:

| Slot record | Field | Notes |
|---|---|---|
| name | program-chosen identifier | validated portable identifier |
| ref | `{ sha256, bytes, encoding: 'json' \| 'text' }` | content-addressed artifact |
| reprHead | bounded head-of-repr string | what `peek` shows without loading bytes |
| createdAtSeq | log seq of the `kernel/slot-set` event | provenance |

Persisted values: lossless JSON structures and text blobs (datasets, parsed tables, scraped docs, computed summaries). Not persisted: functions, non-JSON objects, anything over `maxSlotBytes`.

### Program surface (injected bindings, no source rewrite)

Programs are still bodies of async functions (unchanged strip-wrap). Persistence is an injected global, so the seam stays language-portable:

```ts ignore-check
// run_code (kernel flavor) — cell semantics
const rows = await tools.read_file({ path })        // nested dispatch, logged as today
state.docs = parse(rows)                             // persist a slot
const stats = summarize(state.docs)                  // locals die with the run
return { n: stats.count }                            // only print/return reaches the model
```

`state.get/set/has/list/del` are thin async bindings bridged to the host owner; `peek(name, opts)` returns the bounded head/tail repr (reuse `shres-output-retention`) inside the run's logs.

Python binding names (`state` on a persistent globals dict) are a **forward-looking portability target**. Only the TypeScript worker has a published CodeRuntime backend ([`packages/code-runtime/code-runtime/src/index.ts:69-70`](../../../../packages/code-runtime/code-runtime/src/index.ts)). A Python kernel backend is not in-tree.

Whether `state` is a provider-injected binding or a consumer-owned global, and whether it joins `RESERVED_BINDING_GLOBALS` ([`index.ts:40-43`](../../../../packages/code-runtime/code-runtime/src/index.ts)), is an [open decision](#open-decisions).

### Surfacing into context — on demand only

Nothing enters context automatically except a fixed small footer on every kernel-mode result: `kernel: N slots, M/MiB cap used`. Inspection is model-driven:

- `peek()` inside a program (cheapest, composable), or
- a read-only `kernel_list` control tool listing names, bytes, reprHeads — generic render intent, declared up front per the adding-a-tool cookbook. Permission preset for `kernel_list` is an [open decision](#open-decisions).

This is Prime's "retained values outside context until selected", made explicit and priced.

### Model-driven slot deletion with harness-enforced caps

- The model deletes: `state.del(name)` / overwrite-in-place. Optional `state.summarizeInto(dst, src)` is model-computed summary stored over a slot — no LLM judge, no harness-side distillation (PRO-LONG: notes-as-store nearly worthless once the log is queryable; we do not add a second lossy store).
- Caps (validated config, fail loud, never silent eviction — misconfiguration-fails-loud and no-hidden-defaults rules):
  - `maxSlots` (default 64), `maxSlotBytes` (default 8 MiB), `totalBytesBudget` (default 64 MiB), `maxInlineSlotBytes` (threshold at which `kernel/slot-set` inlines `value` rather than artifact-only; default 4 KiB).
  - Recycle: `recycleAfterRuns` (positive integer; default 32).
  - Over-cap `set` resolves a typed failure (`KERNEL_BUDGET`) carrying current usage table + drop guidance, so the model can self-correct — the failure taxonomy gains one kernel-local kind behind the service boundary; `CodeRunFailure` itself is untouched.
- Every kernel result footer repeats usage so deletion decisions are informed without a peek round-trip.

## Retained values and the model-visible ⟺ logged invariant

### Where the invariant actually bites

The invariant governs what reaches **model requests**: derived messages + `EpochHeader`. Kernel values reach requests only through `tool/result` text (logged, like every tool result). Strictly, then, unlogged kernel memory would not violate the letter of the invariant. Three consequences force durability anyway:

1. **Resume/fork drift** must be attributable; a resumed session silently losing kernel state is unattributable drift.
2. **Replay/bench analysis** needs the log to explain behavior (which slots existed when the model chose to peek).
3. **Compaction interplay**: compacted-away tool results stay in the log; kernel slots referencing data parsed from them must outlive the shadowed surface range — they do, because log-only events survive compaction (jspace precedent).

So: **event-sourced slot metadata + content-addressed artifact payloads** — the same split the reconstructable-requests note records for image attachments (log, referenced attachment objects, pinned code version).

### Event vocabulary sketch

Merged into `SessionEventMap` by the kernel package (declaration merging, jspace/* pattern; all log-only, all `{ ignorable: true }`; no new `SurfaceEventType`; no `SESSION_FORMAT_VERSION` bump since the format gains merge-extensible members only):

```ts
/** Proposed `SessionEventMap` members; branded ids at the seam. */
interface BeatPrimeKernelEventMap {
  'kernel/open': { kernelId: string }
  'kernel/exec': {
    kernelId: string
    callId: string
    language: 'typescript' | 'python'
    program: string
    outcome: 'ok' | 'error'
    errorKind?: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit' | 'budget'
    reads: string[]
    writes: string[]
  }
  'kernel/slot-set': {
    kernelId: string
    name: string
    ref: { sha256: string; bytes: number; encoding: 'json' | 'text' }
    reprHead: string
    value?: unknown
  }
  'kernel/slot-drop': { kernelId: string; names: string[]; freedBytes: number }
  'kernel/close': { kernelId: string; reason: 'idle-ttl' | 'disposed' | 'recycled' | 'session-end' }
}
```

`language: 'python'` on `kernel/exec` is reserved for a future backend; v1 events always carry `'typescript'`.

Ordering rule: `kernel/exec` lands when the run settles; its `slot-set`/`slot-drop` events follow immediately as one transactional batch applied only on a successful settle. A failed/timed-out run commits nothing — all-or-nothing per run, which also answers mid-run termination. Torn-batch fold (log ends between `kernel/exec` and its slot-set batch) is an [open decision](#open-decisions). `kernel/open` append timing versus lazy creation is also open.

### Artifact store

Kernel-owned private store combining two in-tree precedents:

- **spill-local mechanics** ([`packages/spill/spill-local/src/store.ts`](../../../../packages/spill/spill-local/src/store.ts)): 0700 root, session subdirectory derived from `sha256(sessionId)` (`sessionDir` at lines 73–75), exclusive `open('wx', 0o600)` writes (lines 109–113; symlink-proof).
- **attachment-local naming** ([`packages/attachment/attachment-local/src/store.ts:39-40`](../../../../packages/attachment/attachment-local/src/store.ts)): content-addressed object paths `objects/<sha256[0:2]>/<sha256>`.

Rehydration verifies digests; corrupt/missing is a loud refusal, matching attachment-local (`store.ts:189-193`). Artifact-store root config and orphan/refcount policy after slot-drop are [open decisions](#open-decisions). Alternative considered and deferred: generalizing `ctx.attachments` beyond images — bigger blast radius, no need yet.

### Why this reconciles cleanly

- Transcript reconstruction: unchanged — tool results were always logged; kernel mode adds no new model-visible channel.
- State reconstruction: log + artifact dir + pinned code ⇒ byte-exact slot table at any seq (fold `slot-set`/`slot-drop` last-wins per scope).
- Token meter: untouched. Slots cost zero surface tokens until peeked; peeks are paid where they appear (tool-result text). The compaction/prune shadow-price protocol needs no extension because no surface replace is involved.
- Compaction: `compaction/*` shadows surface ranges only; `kernel/*` are log-only and immune, so slots parsed from pre-compaction content remain valid — this is the RLM property that compaction retains originals for REPL retrieval, already native to the event-sourced log.

## Security and budget

Same containment stance as the shipped runtime: containment, not a security boundary; `isolation` stays a diagnostic label.

- **Cancellation**: caller `AbortSignal` bridges as today. Hard stop = terminate worker (only way to break a sync hot loop), auto-recycle, rehydrate, report `'abort'` with the committed-slot state intact (nothing commits mid-run). Abort-path ordering versus the transactional batch is an [open decision](#open-decisions).
- **Timeouts**: reuse ELU busy-time metering (`computeMs`) + wall-clock backstop (`maxWallMs`) + per-run output ledger (`maxOutputBytes`). All three are measured-busy, ungameable, already tested patterns.
- **Lifetime budgets**: `totalComputeMsPerScope`, slot caps ([caps](#model-driven-slot-deletion-with-harness-enforced-caps)); enforcement resolves typed failures with usage tables.
- **Leak bounds**: `recycleAfterRuns` restarts workers; durable state survives by construction.
- **Permission/approval**: nested `tools.*` dispatches go through registry `execute` — approvals, guards, spill policy, and dispatch-log waterfall all apply unchanged (code-mode precedent). Kernel packages add no bypass.
- **Sandbox reuse**: Landlock (`node-addon-landlock-run`) and permission presets compose at the same layer they do for bash; container isolation remains available as a substrate swap behind the same Service Definition.
- **Hostile-peer discipline carried over**: port traffic rebuilt field-by-field; binding names treated as own-properties; reserved-global set reused so namespaces stay portable across backends.

## Migration path

### Shared plumbing extraction (prerequisite, mechanical)

The duplication gate would trip on copying worker bootstrap/protocol/output-ledger. Extract `worker-json`, `output-json`, protocol parsing, and the ELU/wall timers into internal `packages/code-runtime/code-runtime-worker-shared` consumed by both `-worker-thread` and the new kernel provider. Behavior-preserving refactor first, kernel second ([roadmap WP1.1](2026-08-26-beat-prime-agent-roadmap.md)).

### Consumers and config

- `run_code` grows a kernel flavor keyed off the mounted kernel service: same schema plus documented `state` global; description changes only when the kernel is mounted (schema-emission-time resolution, `resolveFlavor` pattern).
- Optional `kernel_list` control tool (generic render; permission-gated like other controls).
- Config (cordis.yml, `!!js` allowed): `enabled: false` default; caps/TTL/recycle fields:

| Field | Role | Default |
|---|---|---|
| `enabled` | master switch | `false` |
| `idleTtlMs` | worker idle dispose | 300_000 |
| `recycleAfterRuns` | worker restart period | 32 |
| `maxSlots` | slot-count cap | 64 |
| `maxSlotBytes` | per-slot cap | 8 MiB |
| `totalBytesBudget` | sum-of-slots cap | 64 MiB |
| `maxInlineSlotBytes` | inline `value` vs artifact-only | 4 KiB |
| `totalComputeMsPerScope` | lifetime busy-time cap | config-required when set |

Shipped profiles mount nothing new; the stateless `run_code` path is byte-identical when the kernel is absent.

- Default-off arm: a `--patch` overlay inserts the kernel service. The `kern-driver` overlay additionally adds a system-prompt line naming the kernel — a conservative contrast, not a copy of the sq-adopt result (see [house fact 1](#problem)).

## Open decisions

Pinned here so implementation PRs cannot silently pick:

1. **`state` binding ownership.** Provider vs consumer; whether `state` joins `RESERVED_BINDING_GLOBALS` in [`packages/code-runtime/code-runtime/src/index.ts`](../../../../packages/code-runtime/code-runtime/src/index.ts). Joining the reserved set would forbid user bindings named `state` on every backend, including the stateless runtime.
2. **`kernelId` branding.** Plain string on events vs the branded `KernelScopeId` relationship (opaque-ids rule). Recommendation: brand the handle; store the SessionId-derived value as `KernelScopeId`.
3. **`kernel/open` append timing vs lazy creation.** Append on first `run_code` kernel flavor, or on worker construction, or on first successful `slot-set`.
4. **Torn-batch fold rule.** Log ends between `kernel/exec` and its slot-set batch: treat as uncommitted (ignore the exec), or refuse the log (required-on-read would already refuse if these events were not `ignorable`; they are ignorable, so the fold must define the rule).
5. **Fork fold rule for inherited `kernel/*` events.** Ignore (child starts empty), remap into the child's scope id, or expose read-only.
6. **Artifact-store root config + orphan/refcount policy after slot-drop.** Where the store root lives (under SHRES_HOME vs session persistence dir); whether dropping a slot unlinks the blob immediately or waits for a refcount of zero across forks.
7. **Abort-path ordering.** Terminate-then-skip-batch vs attempt-batch-then-terminate; the contract is "nothing commits mid-run" but the race with `AbortSignal` needs one order.
8. **`kernel_list` permission preset.** Which shipped preset includes it; default deny outside an explicit grant.
9. **Bench task set.** History-dependent aggregation that is not a file-on-disk sufficient statistic ([MAPPING prior-session lesson 8](../../../../MAPPING-prime-agent-2026-08-26.md)); exact task ids are unpicked.
10. **Snapshot fixture target.** Which real example (headless profile) hosts the keyless kernel snapshot.

## Test and bench plan

### Unit seams

- Worker-shared extraction: existing `-worker-thread` suite must pass untouched (refactor safety net).
- Kernel service: slot CRUD under caps; transactional commit-on-success; digest verification failure; recycle + rehydrate equivalence (state before == after); TTL disposal races; hostile-port traffic; budget failures carry usage.
- Events: append validation (JSON-only payloads, ignorable envelope); fold reconstruction at arbitrary seqs; compaction coexistence (shadowed ranges do not affect slots).
- Consumer: flavor emission with/without kernel mounted; footer rendering; `kernel_list` presentation purity (function of args); permission collapse unchanged.

Coverage: the CI gate demands per-file 100% on `packages/*/*/src`.

### Snapshot lane (keyless)

Add a keyless snapshot fixture through the real headless example: scripted flow where run #1 stores `state.stats` and run #2 consumes it; expected outputs include the footer, the second result, and the fixture asserts `kernel/exec` + `kernel/slot-set` presence in the replayed log. Satisfies the testing-policy requirement (non-trivial model-visible change ⇒ keyless snapshot through a real example, same PR). Fixture target is [open](#open-decisions).

### Bench W-arm

Reuse the W0 harness unchanged (arms are overlays). Owned as [roadmap WP3.4](2026-08-26-beat-prime-agent-roadmap.md).

- Arms: `off` (existing control) vs `kern` (kernel mounted, no driver) vs `kern-driver` (+ prompt line naming the kernel). Optionally `kern-nogc` (`maxSlots` / `totalBytesBudget` set to a non-binding high watermark) to isolate the cost of cap-aware deletion versus unbounded retention.
- The `kern-driver` arm is a conservative contrast: sq-adopt showed 16/16 on both driven and undriven query arms when the prompt named a prior-session recording. Kernel `state.*` is a new program surface; the driver arm measures whether naming it changes adoption, rather than assuming the sq-adopt ceiling repeats.
- Tasks: data-heavy, history-dependent shapes where intermediates are NOT files on disk ([MAPPING lesson 8](../../../../MAPPING-prime-agent-2026-08-26.md): files are sufficient statistics; gains should vanish there): e.g. cross-file aggregation > context window forcing compaction mid-task; multi-tool join tasks; a forced-compaction overlay variant reusing `bench/pressure`.
- Metrics: verifier-passed pass@1 (primary), best@k, input/output tokens, steps, kernel telemetry (sets/peeks/drops, adoption rate), paired McNemar with pre-registered n via `w9-power.js` machinery; token-ratio caps like prior arms; report both arms' spend including descendants once [WP0.1](2026-08-26-beat-prime-agent-roadmap.md) lands.
- Pre-register the decision rule: if `kern-driver` ties or loses at powered n AND input-token ratio exceeds the cap, retire (do not ship) the kernel — same retirement honesty as w9/jspace.

## Effort estimate

Engineer-days, focused:

| Slice | Days |
|---|---|
| Extract worker-shared plumbing (behavior-preserving, gates green) | 1.5–2 |
| Kernel worker provider (residency, txn commits, recycle/rehydrate, budgets) | 4–5 |
| Service Definition + event vocabulary + artifact store + persistence-catalog regen | 2–2.5 |
| Consumers: run_code kernel flavor, kernel_list, presentation, config | 2–3 |
| Tests to the 100% per-file coverage gate incl. concurrency/lifecycle paths | 3–4 |
| Docs (subsystem page, README/JSDoc), Agent Note, snapshot fixture | 1.5–2 |
| Bench arm overlay + runner glue + powered run + analysis | 1.5–2.5 |
| **Total** | **~16–20** |

Minimal credible slice (service+provider+consumer, inline-only small slots, no artifact store, unit tests + snapshot, bench arm): **~7–9 days**. Recommended sequencing: shared extraction PR → minimal slice behind default-off → bench → decide before building artifact-store scale features.

## Alternatives considered

**A. Extend `CodeRunRequest` with optional scope; per-mode contract in `code-runtime`.** Reword "runs isolated from each other" to "runs sharing no scope handle"; long-lived-worker lifecycle inside `-worker-thread`. Rejected as primary: destabilizes the stateless seam code-mode depends on, entangles two lifecycles in one class, and forces every future backend to implement residency.

**B. New sibling capability seam `ctx.codeKernel`.** New packages; reuse `CodeBindingNamespace`, `CodeJsonValue`, failure-taxonomy types from `shres-code-runtime`. **Accepted** — capability-seam rule: split when roles evolve independently; kernel has its own lifecycle, state, and events.

**Collapsing typed tools into one REPL tool.** Rejected — [MAPPING technique inventory item 11](../../../../MAPPING-prime-agent-2026-08-26.md); prior-session verdict stands. Permission, render intent, and replay of typed tools are not forfeit.

**Generalizing `ctx.attachments` beyond images** as the kernel artifact store. Deferred: bigger blast radius, no need yet. The kernel store copies spill-local write mechanics and attachment-local content-addressed naming instead.

**Bytes-watermark recycle (`recycleAfterBytes`) instead of `recycleAfterRuns`.** Rejected for v1: a run-count policy is one integer, independently testable, and does not require the worker to report a second live byte total that can disagree with the slot table. A bytes watermark remains a follow-up if leak-vs-restart evidence shows run-count is the wrong axis.

**`inheritKernel` slot-subset spawning at delegation time.** Deferred: couples kernel and subagent seams for unproven value.

## Acceptance criteria

Observable at merge of the implementation PRs (not this note):

- `packages/code-runtime/code-runtime-worker-shared` exists; the existing `-worker-thread` suite passes unchanged; `pnpm run duplication` is green on the extraction.
- `ctx.codeKernel` is a complete seam (Definition + Provider + Consumer); shipped profiles do not mount it; `enabled` defaults false.
- Slot CRUD under caps; over-cap `set` returns typed `KERNEL_BUDGET` with a usage table; a failed/timed-out run appends no `kernel/slot-set`.
- Digest mismatch on rehydrate refuses loud (attachment-local analog), not a contained listing diagnostic.
- Keyless snapshot through a real example: run #1 stores a slot, run #2 reads it; replayed log contains `kernel/exec` + `kernel/slot-set`.
- Pre-registered `off` / `kern` / `kern-driver` bench arm exists; retire-if-tie is written in the same PR as the arm.
- `pnpm run test:coverage`, `pnpm run duplication`, and `pnpm run doc-sync` pass on the kernel packages.
- Config lists `maxInlineSlotBytes` and `recycleAfterRuns`; no second recycle policy is wired.

## Risks

1. **Adoption risk — high likelihood, high impact.** w6–w8 recorded 0 spontaneous session-query calls in 100+ trials; sq-adopt then showed 16/16 on **both** undriven and driven arms when the prompt named a prior-session recording, so a driver line is not a proven requirement for a tool the prompt already makes relevant. Kernel `state.*` is a new surface whose spontaneous use is unmeasured. Mitigation: ship default-off; include `kern-driver` as a conservative contrast; adoption telemetry; retire-if-unadopted at powered n.
2. **Token-cost regression — medium-high.** jspace arms cost 1.6–2.9× for no lift at ordinary scale. Kernel slots are cheap (zero surface tokens until peeked) but program verbosity and footers add up; token-cap gate in the pre-registration.
3. **100% coverage gate on lifecycle/concurrency code — certain cost, medium schedule risk.** Smallest possible worker surface; reuse tested timer/teardown patterns from `-worker-thread`.
4. **Long-lived-worker leaks/hangs — medium.** `recycleAfterRuns` plus everything-durable-lives-in-slots makes worst case a wasted restart, not data loss.
5. **Invariant friction — low.** Log-only ignorable events are established (jspace/*, hook/*); no surface change; catalog regen is mechanical.
6. **Duplication-gate trip — certain if copied naively; eliminated by doing the extraction first.**
7. **Scope creep toward one Python REPL tool — deliberate non-goal; typed tools, permission, render intent preserved throughout.**

## Appendix: exact touch points

| File/package | Change |
|---|---|
| new `packages/code-runtime/code-runtime-worker-shared` | Extracted worker bootstrap, protocol parse, output ledger, ELU/wall timers |
| `packages/code-runtime/code-runtime-worker-thread` | Consume shared plumbing (behavior-preserving) |
| new `packages/code-runtime/code-kernel` | Service Definition `ctx.codeKernel` |
| new `packages/code-runtime/code-kernel-worker-thread` | Resident-worker Provider |
| `packages/core/tools` (code-mode / run_code consumer) | Kernel flavor + `state` binding when mounted |
| new `kernel_list` plugin | Read-only listing tool |
| `scripts/gen-persistence-catalog` output | `kernel/*` in `KNOWN_SESSION_EVENT_TYPES` |
| `docs/subsystems/code-runtime.md` | Kernel subsection |
