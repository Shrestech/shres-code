# Agent Note: Compaction summary guards

Status: implemented

## Problem

Local W0 calibration at a forced 24576-token pin produced a five-link failure chain. A compaction cycle shadowed exactly the session's first user instruction and replaced it with a 75-character degenerate checkpoint; every existing acceptance check passed because they only tested non-empty, image-free, cleanly-finished, and smaller-than-shadowed output. The summarizer call replays the full system prompt including an open J-Space card, and the model treated the card's `Next` line and the replayed tools as live instructions — one refusal output complied verbatim with the placeholder `Next` text and another attempted a `bash` tool call that was silently dropped. Failed summarizations recorded no `rawOutput`, so the refusal was unrecoverable from the session log. Post-compaction `shadowedRange` was also recorded inverted (`start > end`) on every cycle after the first, because the range took the first and last of an unsorted seq list, and the package invariant checked only endpoint equality against those same entries.

## Decision

`selectCompactableRange` pins the session's first user-authored surface message: the selected range starts after it, and a span with nothing compactable between the pin and the retained tail returns `null` instead of an absurd single-message region.

`acceptSummaryOutput` gates every completed summarization call. A tool-call block means the model attempted an action instead of writing the checkpoint; a missing or trivial `## Primary Request and Intent` section means the mandated checkpoint structure was not produced. Both throw `SummaryOutputRejection`, which fails the attempt through the existing retry path and carries the refused output into the durable `compaction/end` failure record. The summarizer directive adds one sentence stating that J-Space card and protocol text is workload state to summarize, never instructions for the call.

`shadowedRange` becomes the normalized min/max interval of `shadowedSeqs`; the package invariant now requires `start ≤ end` and range/seq agreement, and a successful `compaction/end` must not carry `rawOutput`. The token-meter surface projection arms its release claims from the first and last entries of `shadowedSeqs`, which stay positional, rather than from the normalized interval.

## Alternatives considered

**Require the instruction to survive via keyword round-trip checks.** Rejected: pinned-entity keyword lists are task-specific; a harness cannot know which tokens are load-bearing for arbitrary instructions. Never shadowing the first user message needs no such knowledge.

**Accept short summaries and retry on size alone.** Rejected: the observed degenerate output was structurally compliant prose. The heading requirement distinguishes a checkpoint from a refusal; size thresholds cannot.

**Widen the summarizer prompt to explain the card at length.** Rejected: more prose in an auxiliary call is more injection surface. One disambiguation sentence plus an enforced output gate bounds the failure instead of describing it.

**Keep `shadowedRange` as first/last of the seq list and relax the invariant.** Rejected: consumers price the replaced surface span positionally. Normalizing the interval and asserting min/max keeps both facts explicit and checkable.

## Consequences

The first instruction of a session can no longer be replaced by model prose at any pressure level, and degenerate summaries fail loudly with retained evidence instead of laundering forward. Summary rejection consumes a retry attempt like any summarizer error, so a model that persistently refuses to produce the checkpoint structure fails the compaction rather than degrading the session. Pinning the first user message slightly raises steady-state context pressure in long sessions whose early turns would otherwise be compactable; the retained-tail budget absorbs it.

Chain-stratum compaction behavior is unchanged across session boundaries; the pin and the acceptance gate are per-session. The J-Space follow-ups that remain open — measured opening policy and cross-session card carry — are recorded in [J-Space operational ledger](../feature/2026-08-19-jspace-operational-ledger.md).

## Related

- [J-Space operational ledger](../feature/2026-08-19-jspace-operational-ledger.md) — the jspace-side half of the same failure chain.
- [J-Space W0 benchmark suite](../testing/2026-08-18-jspace-w0-benchmark-suite.md) — the instrument whose calibration runs exposed the chain.
