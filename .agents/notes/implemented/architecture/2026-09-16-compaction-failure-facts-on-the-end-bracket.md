# Agent Note: Failed compaction attempts record their summarization call facts

Status: implemented

## Problem

A successful compaction records the summarization call's provider, model, cap, and usage on `compaction/summary`. A failed one recorded only an error string on `compaction/end`, so the log could not answer which route was asked, how much input it sent, or how the stream ended. That asymmetry made a production wedge undiagnosable from the session log alone: the same `CONTEXT_WINDOW_EXCEEDED` text arrives from an adapter-reported provider error, from pi-ai's usage heuristic, and from a zero-output truncation, and the failed attempt kept none of the facts that separate them. The message was all a reader had.

## Decision

`compaction/end` gains an optional `failure` payload: the summarizer's provider and model, its provider-reported usage when the stream emitted one, the terminal harness finish kind that failed the attempt, that finish's failure code, and the 1-based attempt index within the compaction. The text `error` stays as the human-facing chain; the facts are what a reader matches on.

`SummarizationFailureError` carries them out of `summarizeWithLlm` and keeps the underlying finish's message and `code` on itself, so every existing consumer of a summarization failure reads what it read before. The transaction stage attaches the attempt index, which is why `CompactionEngine.compactRegion` takes an optional `attempt`: the retry index belongs to the backend's policy loop, while the bracket that records it is written by the shared transaction.

The field is optional and additive on an existing event, so no `SESSION_FORMAT_VERSION` bump applies ([one integer, an upgrade chain](2026-08-10-session-log-version-mechanism.md)). The compaction invariant rejects an inconsistent combination — facts without an error, an unknown terminal kind, a non-positive attempt, or malformed usage — and accepts an absent field for the commit-stage failures and pre-change logs that carry none.

## Alternatives considered

**Record the facts on `compaction/summary`.** Rejected: a failed attempt never appends one, which is exactly the case that needs them.

**Carry the pi-ai stop reason instead of the harness finish kind.** Rejected: the replay envelope is adapter-private, and this package holds no pi-ai vocabulary. The finish kind plus the code already separates an error, an abort, and a token-cap truncation, and the usage beside them separates a usage-based reclassification from a provider error.

**A dedicated `compaction/failure` event.** Rejected: the failure already has a bracket to close, and a new event type would need the unknown-type marker or a version bump for readers that predate it.

**Keep the error string and parse it.** Rejected: the same three causes share one message, and text parsing at the consumer is the coupling the terminal-finish protocol removed.

**Log the facts from the summary stage only.** Rejected: the transaction owns the bracket, and it is also the only place that knows an attempt ended without a replacement.

## Consequences

A failed compaction is now diagnosable from the log: the route, the input it reported, the terminal kind, the code, and which attempt died. The cost is one more optional field in a log-only event and a class of failure facts that a backend-provided summarizer must either supply or leave absent; the invariant keeps the present-but-malformed case loud.

## Testing

`compaction-basic.spec.ts` drives the real one-shot summarizer over a scripted terminal overflow finish and asserts both the error's facts and the durable `compaction/end.failure` envelope, including the attempt index a caller assigns. `compaction/tests/invariant.spec.ts` accepts a valid envelope and rejects facts without an error, an unknown terminal kind, a zero attempt, and negative usage.
