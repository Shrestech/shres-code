# Agent Note: Headless session fork for automation

Status: proposed

## Problem

The J-Space card's decisive experiment is a **card-carry chain**: phase 2 of a task starts with the card from phase 1 and nothing else, while the control arm starts cold. That isolates the card as the sole memory channel across a session boundary — the exact value proposition. It cannot run today. Automation entries are fresh-only by design ([acp-demo README](../../../packages/examples/acp-demo/README.md): "resume and human interaction belong to other entry points"), the SDK server exposes no session resume/fork over the wire, and the [chain benchmark machinery](../testing/2026-08-18-jspace-chain-gym-and-report-v2.md) therefore ships cold-carry-only, with `Trial.phases[].resumedFrom` always `null`. The underlying machinery already exists: sessions carry `parentSession` + seed lineage ([shres-session](../../../packages/core/session/src/index.ts)), persistence round-trips fork lineage, and the [jspace seat](../../../packages/jspace/jspace/README.md) performs copy-on-fork (inherited parent card → native copy at `seq` 1). What is missing is an entry point that reaches it.

## Proposal

Add a minimal fork entry to the automation surface: `shres --profile headless --fork-from <session-ref>` (and the SDK equivalent, if the SDK grows session lifecycle methods) that

1. loads the referenced session's persisted tail through the existing persistence restore path (`seedSource: 'persistence'`),
2. creates the new session with `meta.parentSession` set and the parent's relevant tail as seed events — the jspace seat's copy-on-fork then writes the native card copy itself, so no jspace-specific code joins the entry point,
3. runs the single task argument and exits, exactly like a fresh headless run otherwise.

The bench then registers a `card` carry mode on the `on` arm (phase roots shared, each phase forked from the previous phase's session id) and populates `resumedFrom`; the `off` arm stays cold. No other harness behavior changes; resume (continuing the *same* session) stays with the interactive entries.

## Alternatives considered

**Resume instead of fork.** Continuing the same session keeps the full transcript and lets compaction mediate length — it measures "card vs compaction," not "card as the only memory." Compaction-stress tasks already cover that axis single-session; fork is the missing one.

**Runner-side seed transplant (copy the prior log into a fresh persistence root).** Rejected: foreign writes after a native origin are exactly what the jspace fold faults on, and bypassing the creation path would counterfeit the mechanism under test.

**Prompt-level handoff (inject phase-1 findings into phase-2 text).** Rejected: measures prompt engineering, not the product; the intervention must be the mounted machinery.

**Drive forks through the interactive TUI entry.** Rejected: needs a terminal, cannot run in CI/bench subprocesses, and mixes measurement with interaction surfaces.

**Do nothing.** Rejected: W0's long-horizon stratum and both deployment reviews gate the default-on decision on evidence; without fork, the strongest evidence class stays unmeasurable.

## Acceptance criteria

- `shres --profile headless --fork-from <session-id>` (with a persistence root that holds the parent) runs one task in a child session whose header carries `parentSession`; without jspace mounted, behavior is indistinguishable from a fresh run.
- With the jspace seat active, the child session log shows a native card copy (`seq` 1, child `sessionId`) and the model can act on inherited checkpoints without seeing the parent transcript.
- The bench `on` arm runs chain tasks with `carry: card`; trials record populated `resumedFrom`; the arm-integrity audit verifies the fork lineage (child `parentSession` == prior phase session id).
- Keyless snapshot coverage for the forked headless run; `SESSION_FORMAT_VERSION` stays `0` (seed/parentSession are existing header fields); docs/architecture.md and the acp-demo freshness note are updated in the same PR.

## Risks

- **Automation surface widens**: forked automation sessions inherit decisions (approvals, goal state) whose fresh-only assumption is baked into the headless profile; the seed must be scoped to what fork semantics actually promise (card + declared lineage), not the whole parent state.
- **Restore trust**: persistence restore assumes the referenced session is well-formed; a bench-supplied session-ref needs fail-loud validation, not partial restore.
- **Concept confusion**: fork vs resume vs continue must be named precisely in CLI help and docs, or users will automate against the wrong semantics.
- **What it gives up**: nothing user-visible changes for existing flows; the cost is one more entry-point flag with lifecycle semantics to maintain.
