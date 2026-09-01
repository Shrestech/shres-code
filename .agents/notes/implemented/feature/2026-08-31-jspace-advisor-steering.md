# Agent Note: jspace-advisor parent identity and steering

Status: implemented

## Problem

The standing advisor ([persistent-reviewer note](./2026-08-31-jspace-advisor-persistent-reviewer.md)) judged from a digest that omitted the parent session id and labeled tool lines only `ok write` / `ok bash`. `session_event_read` without `session_id` reads the caller, so the reviewer inspected its own log when a delta named a parent seq. Human prompts reached it only on the next 8-step `drift-check`, so a second main-chat message lagged. The persona forbade session hunting after an earlier review burned a whole turn exploring; that left no legal way to verify one parent event. The main session had no trusted rule to consult the advisor or to send deep review to Ward.

## Decision

Keep the standing-child / one-shot-consult split. Give the reviewer enough address to steer, not a second transcript.

- **Parent identity in every digest and delta.** Render `Main session id` and the folded seq range. Those seqs belong to that session. The spawn child already shares `cwd` and `parentSession` on its header; session-query authorizes a same-cwd target, so `session_event_read({ session_id, seq })` is enough. The digest is the address; the reviewer does not hunt.
- **Seq-labeled tool window with a bounded argument excerpt.** Each line is `ok|FAIL name seq=N` plus a truncated `command` / `file_path` / `path` / `url` / `query` / `question` (config `maxArgChars`, default 80). A path is enough to steer most of the time; the one allowed `session_event_read` verifies a listed seq.
- **`user-intent` trigger.** A source-`user` `user/message` wakes the standing child immediately. Plugin and subagent notices do not. After a review settles, if a newer human message exists than `lastSeq`, one catch-up delta runs even if `suppressReview` would block cadence — that is the in-flight second-message case. `drift-check` remains for silent work. User-intent always runs after a failed review, like epoch and charter.
- **Persona and main-session rules.** The child persona states the job (steer to the user goal), the tools (wiki plus one parent `session_event_read`), the self-read trap, token frugality, and that code review is a main-session `ward` call. The parent `jspace:advisor` section always prints trusted rules while armed and a card is open: consult with `jspace_consult` when unsure; treat framed advice as untrusted; deep review via `ward`. Latest verdict, when present, stays in the untrusted frame underneath.

## Alternatives considered

**Live-mirroring the parent transcript.** Would let the advisor see every tool result, at the cost of a second full context window. The digest plus one named `session_event_read` is the cheaper steer.

**Adding `session_search` to the default reviewer filter.** Recreates the session-hunting failure: the reviewer spends the turn discovering ids instead of judging. The digest now names the parent; search is not required.

**Giving the advisor bash or write tools.** Turns it into a second agent. Steering stays advice-only; edits and code review stay on the main session (`ward`).

**Putting consult/Ward rules in `jspace-prompt`.** Those tools exist only while the advisor is armed. The trusted block belongs on `jspace:advisor`, which is empty when the plugin is off.

## Consequences

- A deployment that wants the one parent read must still mount `tool-session-query` and add `session_event_read` to `reviewerTools`. Wiki-only remains the shipped default.
- Catch-up bypasses `suppressReview` only for human messages newer than the last fold, so an ignored redirect still does not re-nag until the user speaks.
- Direct chat in the Advisor pane is a separate inbox and is unchanged.

## Verification

Digest specs pin parent id, `seq=N` tool lines, and argument excerpts. Review specs pin the persona contract, `user-intent` classification, and `latestHumanUserSeqAfter`. The invariant accepts a source-`user` pointer and rejects a plugin-sourced one. The apply harness: a human message wakes a review without eight extra steps; a second message during a hung first turn is delivered as a catch-up delta; a card-open assembly prints the trusted consult/Ward rules before any advice exists.
