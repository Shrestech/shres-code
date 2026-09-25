# Agent Note: A degraded replay-history message is reported once

Status: implemented

## Problem

A pi-ai replay envelope version change makes every assistant message in an older session log unusable as native replay. Each request rebuilds pi-ai history from the session's durable messages, so every such message degrades to provider-neutral history on every request. `toPiAssistant` called the adapter's degrade observer each time, and every plugin built on the shared `PiAiAdapter` logged one warning per call: `llm-pi-ai`, `llm-claude-session`, `llm-codex-session`, `llm-grok-session`, and `llm-xai-apikey`. A long resumed session therefore wrote one warning per degraded message on every request.

## Decision

`PiAiAdapter` calls its `onReplayDegrade` hook once per degraded message, the first time the message degrades. The degrade observer now receives the degraded message, and the adapter records the message's model source in a `WeakSet` before calling the hook. The plugins' hooks still log one line per call, so no plugin changes.

The key is the model source object. `Session.deriveMessages()` returns the durable event's own frozen message on every call, and a shallow request copy keeps its source, so every request built from one session's history shares these objects. Because the set holds its keys weakly, a disposed session's history stays collectable, and a long-running host accumulates nothing. The tracking is per adapter instance, so a message that degrades on two routes is reported once per route.

The degraded conversion is deterministic. Identical history converts to identical request bytes for the completions, Responses, and Anthropic Messages protocols, and a longer history keeps the earlier prefix, so only the first request after a resume misses the prompt cache.

## Alternatives considered

**A session-keyed map released on `session/disposed`.** Rejected: each of the five plugins would wire a disposal listener. A request without a session id, such as a direct `ctx.llm.stream()` call over history, would also need a bucket that nothing ever releases. Weak identity releases with the history itself.

**One module-level set shared by every adapter.** Rejected: it is state no plugin owns, and it would suppress the report for a route that first sees a message after another route already reported it.

**Deduplicating in each plugin's hook.** Rejected: five copies of the same state, and the hook would need the message identity it does not receive.

## Consequences

A resumed session logs exactly one warning per degraded message. A later request that brings a previously unseen degraded message into history still reports that message. Replacing an adapter instance, which happens when a plugin remounts, starts a new tracking set, so each message may be reported once more. Nothing changes the degraded bytes, which were already stable.

## Testing

- `packages/llm/llm-pi-ai/tests/replay-degrade.spec.ts` checks the shared adapter:
  - two version-2 messages over three requests report twice;
  - a degraded message that first appears on a later request is reported then;
  - after the history is released, a WeakRef to a reported source is collected;
  - the degraded request bytes are identical across requests on all three protocols;
  - the pi-ai plugin logs two warnings over three requests.
- The Claude, Codex, Grok, and xAI plugin tests check that two degraded messages over three requests log exactly two warnings.
- Negative controls. Removing the once-only guard fails all six once-only tests. A strong `Set` in place of the `WeakSet` fails the release test.
