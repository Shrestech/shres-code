# Agent Note: Researcher harness — long-horizon autonomous research mode

Status: proposed

## Problem

shres-code sessions live minutes to hours. Research programs — gorakh v1/v2 training, evaluation sweeps, replication studies — run days to months. Today the harness cannot host that work: it has no client for the experiment infrastructure those programs already use, its task memory is session-scoped ([jspace](../../../../packages/jspace/README.md) holds one card per session, `ship` writes no durable state, closed cards are recoverable only by raw log replay), it has no budget or compute awareness in the loop, and its checkpoints are self-reported — a single model grades its own evidence with a keyword vocabulary.

The human is also the bottleneck. Approvals gate escalations, steering is synchronous, and nothing runs overnight unattended. The requirement this note answers: agents run experiments with no human in the loop inside declared limits, and contested claims are challenged *inside the harness* — the architect and reviewer seats debate the researcher before compute is spent and after evidence lands — so the human attends a periodic ship gate, not the loop.

Three external systems already exist and are live; the harness can neither read nor write them:

1. **Git run-records** — binding truth for every experiment (the eval law).
2. **shrestech-tracker** — FastAPI + Postgres derived index; `POST /api/runs` rejects a run without `decision_rule`, `data_version`, `git_sha`; per-lane scoped bearer tokens; bulk `/api/sync` with per-row quarantine; a migration CLI can rebuild the index from git.
3. **modelstore** — artifact store; every artifact addressed by a `modelstore://` URI.

No run is done without all three legs. The tracker is derived and rebuildable, so it can never become a liability — except that release promotion currently fails closed on tracker provenance, which makes a Postgres outage a promotion outage; the plan keeps a git-only fallback path proven.

## Prior art and what each contributes

- **Faraday / Replica** (Inherent, [paper](https://inherentlabs.ai/research/training-to-replicate), [arXiv 2608.13331](https://arxiv.org/html/2608.13331)): budget-constrained scale-down is a first-class scientific skill; their judge reads the full rollout trace and git history and can re-execute code; gains over prompting are real but judge-relative. Take: budget as loop context, verification over *process* not output, and healthy suspicion of any verifier that shares a skull with the executor.
- **AI Scientist-v2** (Sakana, [arXiv 2504.08066](https://arxiv.org/abs/2504.08066), [code](https://github.com/SakanaAI/AI-Scientist-v2)): a staged experiment manager (preliminary → hyperparameter → agenda → ablation) with explicit per-stage stopping criteria, tree search over experiment nodes, seeded best-node carry-forward, and replication nodes for error bars. Take: stages with stopping criteria as card phases.
- **Agent Laboratory** (AMD/JHU, [site](https://agentlaboratory.github.io/), [arXiv 2501.04227](https://arxiv.org/abs/2501.04227)): co-pilot mode outscored autonomous mode (+0.58 overall NeurIPS-style score); checkpoint saves resume interrupted runs. Take: the human sits at gates and digests, not in the loop.
- **Co-Scientist** (Google, [Nature](https://www.nature.com/articles/s41586-026-10644-y), [post](https://research.google/blog/accelerating-scientific-breakthroughs-with-an-ai-co-scientist/)): specialized agents — generate, reflect, rank, evolve, meta-review — debate hypotheses in a tournament; a supervisor allocates asynchronous workers; quality rises with test-time compute; their ablation found reflection *with tool access* is what prevented hallucinated novelty. Take: the debate protocol shape and tool-grounded reflection.
- **Letta / MemGPT** ([memory hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/), [sleep-time compute](https://www.letta.com/blog/sleep-time-compute/)): small editable in-context memory blocks, large queryable archival store, and a separate sleep-time agent that reorganizes memory off the hot path. Take: the two-tier memory split and background consolidation.
- **autoresearch** (karpathy, [repo](https://github.com/parthmstech/autoresearch)): fixed 5-minute budget, one metric (`val_bpb`), agent edits `train.py`, human edits `program.md`. Take: the tight measurable loop and the human-authored program layer as the steering surface.

## Proposal

A researcher composition built entirely from plugins — four capability seams, two guard consumers, one preset, one debate protocol. No change to `packages/core/agent-loop`; everything attaches at documented events, per [plugins-not-loop-changes](../../../../docs/architecture.md) and the [capability-seam definition](../../../../docs/glossary.md#capability-seam) (Service Definition / Provider / Consumer, complete, never one role).

### The researcher cycle

A researcher session holds a project card and repeats: **hypothesis → debate → experiment → evidence → verdict → next**. The hypothesis is attacked by the architect and reviewer seats before compute is spent; the experiment runs in delegated execution children (the existing subagent seam already admits in-process, fork, ACP, Claude Code, Codex, and SDK children as siblings); evidence lands as a tracker run plus `modelstore://` artifacts; the verdict is a ledger entry citing that evidence; the card advances. The human reads the ship digest on a cadence and holds the ship gate.

### Seam 1 — experiment tracking (`packages/tracker/`)

Service Definition `shres-tracker` (`ctx.tracker`): `logRun({experiment, hypothesis, decisionRule, dataVersion, gitSha, metrics?, artifacts?}) → TrackerRunId`, `logMetrics(runId, metrics[])`, `queryRuns(filter)`. Failure taxonomy (`auth`, `unreachable`, `quarantined-row`) surfaces verbatim to the model. Request/spec split follows `shres-shell`: an explicit `resolve(request): Spec` step owns defaulting.

Providers: `shres-tracker-shrestech` (HTTP client; lane token through a `ctx.credentials` reference, never raw config; `Config` fields `baseUrl`, `lane`, `credentialRef`, and `spoolOnly`) and `shres-tracker-git` (writes and reads the binding git run-record; exposes `rebuildIndex()`).

Offline posture is a mode, not an error path: with no `credentialRef`, or with the tracker unreachable, the git run-record is still written and the post is held in a durable local spool that syncs through the migration-CLI path on reconnect. Rented GPU pods run exactly this way by policy — they never hold tokens; their records sync on return. Promotion may fail closed on tracker provenance, and a tested git-only fallback resolves it when the index is rebuildable.

Consumer tools: `experiment_log_run`, `experiment_log_metrics`, `experiment_query`. The required `decision_rule` encodes the ritual in the API itself — a threshold change is a new experiment, not an edit.

### Seam 2 — project research memory (`packages/jspace/`, v2)

Cards gain project scope: branded `JspaceCardId` keyed by `WorkspaceId`, states `open → shipped → archived`, durable authority in a `ctx.storageDomain` form, full-history query (`list({state, since, goalSubstring})`). The session log remains the record of what each session saw; the project store is the cross-session truth. `ship` becomes a durable state transition. A new archive tool `project_recall` reads history back into context. Copy-on-fork gives children a native snapshot under the same `JspaceCardId`.

Duration is emergent, never declared: opening a card fixes only which store its events live in (session log or workspace store), and the terminal transitions (`ship`, archive) are explicit acts — no timer expires a card. A two-day program and a three-month program are the same card.

Concurrent-writer policy, fixed up front: per-workspace last-wins, with a conflict line surfaced on the card when a session other than the last writer reads it. History is preserved by the store, so last-wins loses nothing permanently.

Card-carried program bindings make the card the complete durable unit a new session needs — working memory and program configuration travel together. `jspace_open` accepts them at creation; `jspace_note` swaps them with the same departing/incoming discipline as Core. Three bindings:

- `tracker`: `{ provider, lane?, credentialRef? }` — which mounted tracker provider and lane this program posts to. Values name mounted providers; the card never loads plugins. `provider: 'git-spool'` is the rented-pod posture: git run-records plus local spool, no tracker posts, no token.
- `artifacts`: `{ store: 'modelstore', namespace, uriPrefix }` — where run artifacts are pushed; every `artifacts[]` entry a run logs must carry the prefix, so `modelstore://` URIs are consistent program-wide.
- `promotion`: the policy that elevates a run to a release candidate — required ledger decision (`accepted`), minimum seed count, tracker provenance (with the tested git-only fallback), and whether the human ship gate is mandatory.

Bindings hold references, never secrets: `credentialRef` resolves through `ctx.credentials`; tokens never appear on a card, which is model-visible. The card declares policy; guards and the ship gate enforce it, so a model reading its own card cannot relax its promotion bar.

Two precedence laws keep bindings from duplicating existing configuration planes. **Config declares inventory; the card selects**: which lanes exist and their endpoints live in deployment config, the program's pick lives on the card, and a card naming an unmounted provider fails loud at first use — the card is a request resolved against mounted capability, per resolve(request):Spec. **Deployment floors bound card policy**: guards reject a promotion binding looser than deployment config (a card may be stricter, never weaker), the same separation that keeps plan-mode guidance from relaxing sandbox enforcement. Bindings carry selection and policy values only; behavior toggles belong to presets or plan mode, never to bindings.

Checkpoint verification splits its dimensions. **Evidence-exists** stays mechanical — the `evidence` callId must resolve to a completed non-error tool call in the log, enforced through the executor so denial is real. **Evidence-covers-goal** becomes a reviewer verdict (see the debate protocol) recorded on the check line; `jspace_ship` refuses a Goal with zero evidence-backed checks for the current Goal epoch (the existing `goalOpenedSeq` anchor, extended).

### Seam 3 — decision ledger (`packages/ledger/`)

Service Definition `shres-ledger` (`ctx.ledger`): `record({hypothesis, decision: accepted|rejected|deferred, evidence: TrackerRunId[] + gitSha + modelstore URIs, rationale}) → LedgerEntryId`, `query({decision, hypothesisSubstring, since})`. Storage mirrors the tracker's authority split: a git-committed ledger file is authoritative, the store is the queryable derived index. Consumer tools `ledger_record_decision`, `ledger_query`. Every accepted or rejected hypothesis cites run ids that must resolve — a ledger entry citing an unresolvable run fails validation.

### Seam 4 — budget and compute context (`packages/budget/`)

Service Definition `shres-budget` (`ctx.budget`): `declare({scope, limits: {costUsd?, tokens?, wallClockMs?, runCount?}})`, `consume(...)`, `snapshot() → {spent, remaining, exhaustedKinds}`. Metering listens to existing events only — `assistant/message` usage payloads, `tool/execute` durations, tracker run counts — so no loop change. The provider is durable and project-scoped; budgets survive restarts. Metering reads provider-reported usage, never model self-report.

The model sees budget as a logged injected `user/message` per goal round (remaining time, tokens, run count, and the experiment-cost history from `experiment_query`), so scale-down decisions are made with numbers — the Faraday skill — and the model-visible ⟺ logged invariant holds through an existing event kind.

### The debate protocol (seats as counterparties)

The harness already runs architect (`aegis`), worker (`stride`), and reviewer (`ward`) seats as subagents. The researcher preset composes them into two mandatory challenges and one optional tournament; every seat turn is its own session, and only digests enter the parent as tool results, so the log invariant holds unchanged.

**Design defense (pre-compute):** a hypothesis with its experimental design goes to the architect seat for feasibility under the declared budget; the reviewer seat then attacks it — confounds, missing baselines, seed counts, whether the metric supports the claim. Disagreements become Open questions on the card. An unresolved challenge downgrades the run to a smaller probe experiment sized to answer the challenge, not the hypothesis.

**Evidence review (post-run):** the reviewer seat reads the session log, the tracker run, and artifact URIs, and returns a verdict per claim — supported, unsupported, or contaminated — with the same evidence-exists/evidence-covers-goal split as card checks. The verdict becomes the ledger entry's rationale. A disputed verdict loops once more with a stronger reviewer model, then escalates to the human as an Open question rather than resolving by assertion.

**Hypothesis tournament (optional, config-gated off):** when multiple hypotheses compete for one budget, pairwise reviewer verdicts rank them (an Elo-lite score kept in the ledger); budget flows to the winner. The Co-Scientist ablation result predicts the load-bearing detail: the reviewer must have tool access to the tracker and artifacts — reflection without grounding is how hallucinated novelty survives.

The seats should not share one provider where alternatives exist; per-seat model choice is a preset field. A reviewer that shares a skull with the executor inherits its blind spots.

### The autonomy model

Authority replaces approval. Inside a declared budget envelope the researcher acts freely — no approval prompts. On envelope exhaustion the turn stops and the goal pauses with a policy code; escalation is always pause-with-code, never silent skip, never a hang. Outside the envelope, the escalation ladder is fixed: model → seat debate → pause-with-code → human ship gate.

Unattended operation: `goal-round-driver` gains a fail-loud `autoRearmOnResume` config (default false) so a restarted researcher continues without a human keypress only where explicitly configured; a stall detector in `guard` compares surface-progress fingerprints across goal rounds and pauses after a configured threshold of no change; schedule follow-ups cover time-delayed re-checks. The human cadence is one ship digest per cycle plus immediate blocker notifications.

### Session-log implications

New log-only events, all written `{ ignorable: true }` (the jspace precedent): `tracker/run {runId, experiment, decisionRule, gitSha, callId}`, `tracker/metrics {runId, metrics}`, `ledger/decision {entryId, hypothesis, decision, evidence[]}`, `budget/state {scope, spent, remaining, exhaustedKinds}` per goal round. `jspace/card` extends in place (pre-release stance: rename freely, update every reader together). Model-visible surfaces remain exactly tools and injected messages, so `SESSION_FORMAT_VERSION` stays `0` per the [session-log version mechanism](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md).

### Long-horizon runtime

Durable authority moves to the project stores — cards, ledger, git run-records — so the session log compacts aggressively through the existing compaction seam, made recallable by [recallable compaction](../feature/2026-07-06-recallable-compaction.md); the shipped card and ledger entries are the distilled state a post-compaction model still sees. A sleep-time consolidation pass (the Letta pattern) re-reads closed cards, ledger entries, and tracker trends on a schedule and refreshes the project memory block; its output is model-visible as the next round's injected message. Crash recovery rides the existing per-request durability checkpoint. Cross-session researcher cycles additionally depend on [headless session fork for automation](../feature/2026-08-18-headless-session-fork-for-automation.md) for phase-to-phase card carry without interactive resume.

### Rejected framing: not a Cordis fork

Recorded to close a wrong claim made during review: the framework layer is vendored, not forked. `vendor/README.md` pins every package directly at its canonical upstream — `cordis` and the cordis plugins at `cordiverse/cordis` (`packages/<name>`), `cosmokit` at `shigma/cosmokit`, `schemastery` at `shigma/schemastery` — the repository URLs the packages' own npm metadata declares, with vendored versions matching the upstream releases (cosmokit 1.8.1, schemastery 3.18.0). Earlier manifest rows pointed at `parthmstech/*` mirror names that were rebrand artifacts, not existing repositories; they are repointed, keeping the same pinned SHAs, so a future sync no longer depends on `deepseek-ai/deepseek-harness` or any intermediate mirror. All local modifications live as the in-tree ledger, applied on sync, never as commits in a fork repository. Residual exposure is narrower than a fork: sync-time re-application effort. (One line in `vendor/README.md` item 7 says "upstreamed to the fork" — loose vocabulary inherited from upstream; vendor files are excluded from prose edits by policy, so it stands as-is.)

## Alternatives considered

### Why not a dedicated research-loop package?

A loop package owns control flow the plugin system already exposes. Goal rounds drive continuation, guards stop and pause, tools carry the ritual. Violates plugins-not-loop-changes and buys a second loop to maintain.

### Why not the tracker as source of truth?

Git run-records are binding; the tracker is a derived, rebuildable index. This is the same authority split as the session log (log authoritative, projections derived), and it is what makes the offline-spool posture safe.

### Why not extend `todo` into project memory?

`todo_write` is a whole-list session snapshot with no item identity, no states, no archive. jspace already owns the card vocabulary, the fold, and the ship gate.

### Why not human approvals everywhere?

Approvals do not scale to weeks and they do not compose with sleep. A declared budget envelope is a stronger guarantee than a remembered promise: it is metered from provider-reported usage and enforced by a guard that cannot be talked down. The Co-Scientist and Agent Laboratory results both point the same way — human input belongs at gates and digests.

### Why not one judge model instead of seat debate?

A single judge re-creates the self-report weakness one level up. The debate protocol pits seats with different models and tool-grounded evidence against each other, and the Co-Scientist ablation (reflection with tool access preventing hallucinated novelty) is direct evidence for that shape. Cost is the trade, managed by model tiering: cheap reviewers for routine verdicts, strong models only on dispute.

### Why not per-metric session events?

One `tracker/run` plus one batched `tracker/metrics` per run keeps replay bounded; per-metric events multiply log size for no replay benefit.

### Why not a hand-rolled project store?

The `storage-domain` family already exists with json and sqlite backends; dependencies over hand-rolling is repo policy.

## Delivery stages

Each stage ships per-file 100% tests with invariant companions, a real-composition test booting a `cordis.yml` through the Loader with external services mocked, a keyless snapshot through a runnable example, README and catalog regeneration, and its own implemented Agent Note.

1. **Tracker seam** — proves a model-logged run with `decision_rule` + `git_sha` round-trips to the tracker and the git record rebuilds the index; proves spool-then-sync on outage.
2. **J-Space v2 project scope** — proves two sessions share one card, `ship` is durable, archive queries return history, and evidence-exists denial is enforced through the executor.
3. **Decision ledger** — proves every decision cites resolvable run ids and git shas.
4. **Budget seam + guards** — proves an exhausted budget mid-goal stops the turn, pauses the goal with a code, and the model saw the remaining-budget message in the log.
5. **Debate protocol + researcher preset** — proves a hypothesis survives reviewer challenge before a run launches and a verdict lands in the ledger after; keyless snapshot of one full micro-cycle (hypothesis → debate → mocked run → verdict → ledger → ship digest).
6. **Autonomy week-one** — proves a 7-day unattended mock run survives restart with `autoRearmOnResume`, stalls pause with codes, a tracker outage spools with zero lost run-records, and the human receives exactly one ship digest.

## Acceptance criteria

- A researcher session completes hypothesis → debate → experiment → verdict → ledger with zero human input inside a declared budget envelope, evidenced by a keyless snapshot.
- No run reaches the tracker without `decision_rule`, `data_version`, `git_sha`; no ledger entry cites an unresolvable run id; no card ships without an evidence-backed check for the current Goal epoch.
- A tracker outage spanning a run's final hour loses zero run-records; promotion resolves through the git-only fallback.
- A 7-day unattended mock survives restart, pauses on stall with a code, and produces exactly one ship digest.
- Removing any one seam's plugin leaves the harness booting and the remaining seams functional — no privileged core.

## Risks

- **Debate cost**: two seat challenges per cycle roughly doubles token spend per hypothesis. Mitigation: tiered models per seat, probe-sized runs for unresolved challenges, tournament off by default.
- **Seat collusion**: seats sharing a provider inherit blind spots. Mitigation: per-seat model choice in the preset; measure disagreement rates and sample adversarially where the protocol is expected to fail — the same discipline the Faraday paper applies to its own judge, on the pattern of the [jspace W0 benchmark suite](../../implemented/testing/2026-08-18-jspace-w0-benchmark-suite.md).
- **Budget gaming**: a model may structure work to dodge metering. Metering reads provider usage and tool durations, never self-report; the envelope is enforced in `guard`, outside the model's reach.
- **Goal drift**: a card rewritten toward easy evidence. The `goalOpenedSeq` anchor already prevents stale checkpoints from satisfying a rewritten Goal; stage boundaries add the same anchor per phase.
- **Scope**: four seams, two guards, one preset, one protocol is a quarter of work at current pace. The stages gate merges; each leaves the harness shippable.

## Open questions

- Ledger durable form: git-committed file authoritative with the storage-domain store as index, or store-authoritative with git as export? The tracker precedent (git binding, derived index) argues the former.
- Does the tournament earn its tokens at single-researcher scale, or is it a multi-researcher feature from day one?
- Sleep-time consolidation trigger: idle detection, schedule, or goal-round boundaries?
- Multi-researcher workspaces: are workspace-scoped cards sufficient, or do concurrent researchers need per-researcher lanes with a shared ledger?
