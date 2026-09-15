# Agent Note: CLI bridge streams stream-json turns live

Status: implemented

## Problem

A delegated CLI turn was a black box until process exit: the adapter collected stdout, awaited `child.done`, and emitted the whole reply as one text block. For cursor-agent runs of a minute or more the composer showed nothing — no streaming text, no reasoning, no tool activity — and the first byte arrived only with the process's last.

## Decision

`llm-cli-bridge` maps stream-json transcripts incrementally. When a route's `parseMode` is `stream-json`, the adapter polls the subprocess seam's incremental `readFrom(offset)` every `STREAM_POLL_MS` (100ms) and feeds complete NDJSON lines to `CliStreamMapper`, which emits chunks as events arrive: `thinking` deltas form one reasoning block, each assistant message forms one text block (a same-call snapshot that only grew extends its open block, keyed by `model_call_id` or the claude-style `message.id`), each `tool_call` started/completed pair forms a `server-tool-call` block built through `toServerToolCallBlock` (never dispatched by the agent loop — the CLI ran it), and the `result` object supplies usage plus a text fallback when no assistant event streamed. An error payload throws as soon as its line arrives. A transcript with no recognized events (`hadContent === false`) falls back to whole-transcript `parseCliOutput`, so codex item envelopes and other foreign shapes keep the collect-at-exit behavior; `parseMode: 'json'` is unchanged.

The mapping is generic over the two observed stream-json dialects (cursor-agent `type`-tagged events, kimi `role`-tagged events); events with a non-assistant `role` are ignored so kimi's trailing meta events cannot overwrite the reply.

## Alternatives considered

**Extend the subprocess seam with push-based output callbacks.** Rejected: `readFrom` already supports incremental reads on a running child; a poll at 100ms meets UI latency without widening the seam's contract.

**Emit `tool-call` chunks so the loop tracks delegated tools.** Rejected: the agent loop would dispatch them as harness tools; `server-tool-call` is the block designed for provider-side execution — logged and rendered, never executed.

## Consequences

A cursor-agent turn renders thinking, reply text, and shell calls while the CLI runs (verified against the live binary: reasoning and the tool-call block arrive mid-turn, usage and finish at exit). Turn footers and token counters update at settlement as before. The `cursor-cli` overlay example uses `--output-format stream-json` / `parseMode: stream-json`; a deployment on `json` keeps the old behavior by choosing it.
