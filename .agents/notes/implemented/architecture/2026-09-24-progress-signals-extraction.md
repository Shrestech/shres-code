# Agent Note: Progress-signal folds live in their own package

Status: implemented

## Problem

The five stuck-trigger folds (`errorBurst`, `attemptCount`, `repeatRunLength`, `stepBudgetExhausted`, `turnFailureStreak`), the numbers-first progress facts that measure the same runs, and the trailing tool window lived inside `packages/team/worker-escalation`. The folds are pure log reads with no Team, judgment, or settings dependency, but their only home was a plugin whose manifest peer-depends on the Team, jspace, judgment, settings, and user-questions packages. A second consumer was designed: the [model-routing redesign](../../proposed/feature/2026-09-17-jev-judgment-routing-and-compaction.md) exits a downgrade on a verification signal, and it reads the same triggers over the events after its streak's entry. That consumer had two options: depend on the worker ladder, or copy the folds and let the two copies' trigger semantics drift.

## Decision

`packages/team/progress-signals` (`@shres-code/shres-code-progress-signals`) owns the folds and their vocabulary as a library: no `ctx`, no registration, no state, and no events of its own.

- It exports `foldEscalationTriggers`, `foldProgressFacts`, `triggerSatisfiedAt`, `foldToolWindow`, `probeInFlight`, `callChainKey`, `canonicalizeArguments`, `isSandboxDenial`, and `ESCALATION_TRIGGERS`, with the types `EscalationTrigger`, `EscalationTriggerOutcome`, `ResolvedEscalationTrigger`, `ResolvedEscalationTriggers`, `ProgressFacts`, and `ToolWindowEntry`.
- The folds take the trigger rows (`ResolvedEscalationTriggers`, one `{ enabled, threshold }` row per trigger) and a caller-supplied exclusive `epochAnchorSeq`, not one consumer's resolved configuration. Defaults, validation, and the choice of anchor stay with each consumer: worker-escalation resolves its rows from its own config and passes the jspace card's `goalOpenedSeq`.
- The `Escalation*` names are kept. The two worker-prefixed names become `ProgressFacts` and `ToolWindowEntry`, because the facts and the window describe any session.
- The trigger semantics, the durable-failure taxonomy, the sandbox-denial carriers, and the progress floor are documented once, in the [package README](../../../../packages/team/progress-signals/README.md). The worker-escalation README keeps its config mapping and links there.
- The package's `./invariant` companion is an explained empty installer: the package owns no event stream. A consumer that logs a verdict owns the relation that checks it; worker-escalation's companion checks each `escalation/decision` through `triggerSatisfiedAt`.

worker-escalation keeps what reads its own `escalation/decision` events: `foldEscalationAging` and `foldEscalationCooldown` in `src/fold.ts`, plus `composeProgressState`, the digest, and the config. It consumes the new package as a peer dependency, and its sandbox dependency moves with the folds.

The library carries a package-private `assertNever` instead of importing jspace's. Its jspace edge is therefore type-only, the declaration merge that types the `jspace/charter-*` events the folds read, so a consumer of the folds never loads the jspace plugin package at runtime.

## Alternatives considered

**Keep the folds in worker-escalation and import them from there.** Rejected: a routing consumer would take a package-graph edge to the worker ladder, and through its manifest to the Team, judgment, settings, and user-questions packages, to reach code that needs none of them.

**Copy the folds into model-router.** Rejected: two homes for one trigger contract. The durable-failure taxonomy is already restated once, in model-router's private route-failure predicate, and a second full copy would let the stuck verdicts of the two consumers disagree on the same log.

**Move the folds into `packages/core/session`.** Rejected: the folds read jspace charter events, `step-budget/exhausted`, and sandbox denial markers, and putting that knowledge in the core session package would make the spine depend on feature packages.

**Keep re-exports in worker-escalation for compatibility.** Rejected under the pre-release stance: nothing outside the package imported the moved exports, and a re-export would give each fact two import paths.

**Import `assertNever` from jspace or llm.** Rejected: either choice makes a pure fold library load a plugin or capability package at runtime for a four-line exhaustiveness helper. The repository already keeps per-package copies of that helper, one in jspace and one in llm.

## Consequences

- A consumer reads the same verdicts, facts, and tool window without depending on the Team packages. Every fold stays a pure function of the log it is given, so replay determinism carries over to any consumer.
- worker-escalation's behavior is unchanged. Its suites pass unchanged except for the tests that moved with the code: the trigger, probe, progress-fact, and window cases, and the two direct `triggerSatisfiedAt` cases formerly in its invariant spec, all now in `packages/team/progress-signals/tests`.
- The fold call contract changed from a resolved worker-escalation configuration to the trigger rows. worker-escalation passes `config.triggers`.
- One more workspace package exists. The durable-failure taxonomy is still restated between this package and model-router's private predicate; the package README records that limitation.
