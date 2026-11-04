# Agent Note: the models CLI serves the cursor route and states each provider's real blocker

Status: implemented

## Problem

`shres models list` and `shres models set` boot a hand-built composition in `apps/cli/src/models-cli.ts`. It mounted deepseek, pi-ai, the CLI bridge, grok, codex, claude, and xai-apikey, but never `llm-cursor-session`, which the base bundle does mount. The CLI therefore omitted `cursor-session` entirely and refused `shres models set cursor-session gpt-5.2` with `unknown provider`, while the Web Models page listed the route and its catalog.

Two readiness defects sat next to it. `providerUsable()` returned `false` for every `kind: 'delegated'` route and `formatProviderList()` had one reason string, `unusable until keyed`, so a delegated route always read as if it needed a stored key — `llm-cli-bridge` documents the key as optional because the CLI's own login can supply the credential — and a binary missing from PATH, which is the failure that actually stops the spawn, went unstated.

The same mount would have exposed a third defect. Selection was refused for a chat-gated route only in the Host's `sessions.selectModel`; `validateSelection` in `agent-default-model`, which `shres models set` and the `/model` command both call, knew efforts and model ids but not `chatGated`, so either surface could persist a default that refuses every turn.

## Decision

`bootModelsCli()` mounts `llm-cursor-session`, so the route, its catalog, and its directory entry reach both commands. It does not mount `cursor-credential`: the adapter reads the credential engine only in `stream()`, which the models commands never call, and the CLI mounts none of the sibling credential engines either.

Readiness is a per-row blocker with a reason instead of a boolean. `providerBlocker()` reports `does not serve chat turns` for a `chatGated` directory entry, `binary "<name>" not on PATH` for a delegated route whose `binaryFound` is false, and `unusable until keyed` for a non-delegated route whose profile names an `apiKeyEnv` with no stored credential. A delegated route with its binary present carries no blocker even when its `apiKeyEnv` is unstored, because its own login can supply the credential.

`validateSelection()` refuses a chat-gated provider after `resolveCallConfig` succeeds and before anything is persisted, with the Host's sentence: the provider "lists models but does not serve chat turns; select a serving route". Resolution runs first, so an unknown model still reports as unknown ahead of the gate. Both the CLI write path and `/model` inherit the refusal from the one operation that performs the selection.

## Alternatives considered

**Derive the CLI composition from `packages/bundle/base/cordis.patch.yml`.** Rejected: the models commands need settings, credentials, and provider adapters only; loading the shipped bundle would boot sessions, tools, and host services into a process that prints a table. The hand-built list stays, and a new provider route must be added to both places.

**Share the readiness rule with `packages/client/ui-settings-models`.** Rejected: the client export discipline forbids importing another UI plugin's symbols outside slots and ctx services, and the two rules answer different questions — the Models page decides whether a row already counts as set up, while the CLI must name the blocker a user can act on.

**Keep the boolean and add the missing flag as a second field.** Rejected: every pair of booleans admits a state the surfaces cannot produce (usable and blocked, or neither), and the flag vocabulary would drift from the check that produces it.

**Refuse a delegated route whose binary is absent.** Rejected: the Web Models card reports found / not on PATH without disabling the row, a missing binary is environmental and can change after the selection is written, and `llm-cli-bridge` already states the spawn failure at request time. A second refusal authority in the CLI would also disagree with the Host, which accepts that selection.

**Gate inside `resolveCallConfig` so every caller inherits the refusal.** Rejected for the reason the [chat-gated directory fact](2026-09-15-chat-gated-directory-fact.md) records: resolution is how configuration surfaces interrogate a gated route's catalog. `validateSelection` is the selection operation, so the guard belongs there rather than in each caller.

## Consequences

`shres models list` and the Web Models page now agree on which routes exist and why a route cannot serve. A deployment that hand-declares the `cursor-cli` overlay sees it flagged `binary "cursor-agent" not on PATH` when the Cursor installer's `~/.local/bin` is absent from the harness PATH, which is the actionable fact for that overlay; the shipped CLI routes are retired, so that row exists only after the declaration.

The selection path refuses a chat-gated route in the Host, in `shres models set`, and in `/model`. The first-run picker writes `saveSelection` directly rather than through `validateSelection`, but it offers only template routes and local Ollama, so it cannot produce a gated selection.

The readiness judgment now has three homes — the Models join, first-run setup, and `providerBlocker` — and `apiKeyEnvOf` has three implementations: first-run setup, the Models join's store, and this CLI. That duplication predates this change; `providerBlocker` reuses the CLI's existing helper rather than adding a fourth, and folding the three into a shared module reaches the Web join and first-run setup, which is a separate change with its own note.

`binaryFound` is a boot-time PATH probe, so the flag reflects the PATH the process started with. The removed `apps/cli` `providerUsable()` printed `unusable until keyed` for a dormant keyless route; the `dormant` flag already carries that fact. A delegated route with no directory entry cannot report a missing binary, because `binary` and `binaryFound` live on the directory row; `llm-cli-bridge` publishes both for every registered route, so that gap is unreachable today.

## Testing

`apps/cli/tests/models-cli.spec.ts` pins the cursor route's listing with its catalog and blocker flag, the refusal to store it through both the default and `--purpose compaction` with the stores left untouched, a delegated route flagged by an absent binary and still selectable, and a delegated route with an unstored `apiKeyEnv` left unflagged when its binary resolves. `packages/core/agent-default-model/tests/command.spec.ts` pins the same refusal through `/model`, including that the stored default is unchanged.

The transcript has no assembled-snapshot tier. The CLI snapshot files under `apps/cli/tests/*.snapshot.ts` run Loader assembly smokes rather than command transcripts, and the interactive-terminal suite that `docs/testing.md` still names under `apps/cli/tests/snapshots/` is not in this tree. A replayable fixture would also have to pin PATH and the credential store, because both change the flags. The CLI spec pins the transcript rows instead.
