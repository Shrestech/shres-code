# Agent Note: CLI models/providers and in-session /model

Status: implemented

## Problem

The Web Settings → Models page already writes `agent-default-model`, `llm-pi-ai` routes, and credential references. The product CLI could boot a profile or run the first-run picker, but it could not list, set, discover, or add those same routes, and a live session could not switch provider, model, or reasoning effort with a user-authored command.

A second config file or an argv API key would split the store and leak secrets into shell history.

## Decision

`shres models` and `shres providers` boot a minimal composition of settings-file, credentials-local, llm, llm-pi-ai, and llm-deepseek, then call the same services the Models page reaches (`llm.providers` / `listConfigurableProviders`, `llm.models` / `listModels`, `llm.discoverModels`, `agentDefaultModel.saveSelection`, `credentials.set`). Settings hot-reload keeps the two surfaces in sync.

`--effort` writes `reasoningEffort` on the `agent-default-model` section after `resolveCallConfig` accepts that id against the adapter's `LlmReasoningEffortInfo`. An unknown effort fails before the write. `--purpose compaction|session-title` writes `purposes[purpose]` and leaves the conversation default in place.

API keys are never argv values. The command prompts on a hidden TTY line or reads stdin, then stores the secret through `ctx.credentials.set` (`0600`). Settings carry only the `credential-ref` name.

`/model` is registered on `ctx.commands` by `agent-default-model` when that registry is composed, the same optional-child pattern as `/permission`. With arguments it writes the session `ModelSelection` through `selectionFor(agent)` (the `agent/request` waterfall) and also `saveSelection()`s that pair as the process-wide default for future sessions. Without arguments it prints the current selection and advertised efforts. `command/run` always records `source: { kind: 'user' }`; the command plane is not a model tool. `/model` is refused on a subagent session. An omitted `--effort` is not persisted even when the adapter materializes `defaultEffort`.

The Web `/model` popup is a `commandUi.decorate` of that host command so the names do not collide.

Compaction and session-title call `ctx.llm.stream()` with `purpose` and never enter `agent/request`. Purpose overrides are stored and listed; those consumers do not yet read `selectionForPurpose`.

## Alternatives considered

**A second CLI-only config file.** Rejected because Settings → Models already owns the store, and a parallel file would desync on hot-reload.

**`--api-key` on argv.** Rejected because the secret would land in shell history. Hidden prompt or stdin is the only write path.

**A new `command-model` package.** Rejected because `/permission` lives on the domain service; `agent-default-model` already owns `ModelSelection`.

**Route purpose overrides through `agent/request`.** Rejected because compaction and title do not use that waterfall. Applying them would require changing those callers; the stored map is the cheap part.

## Consequences

CLI and Web share one default, one provider directory, and one credential store. Mid-session `/model` is user-authored, takes effect on the next assembled turn, and also updates the process-wide default. Purpose overrides exist on disk but do not yet redirect auxiliary `llm.stream()` calls.

The snapshot harness has no CLI-subcommand or mid-session `/model` fixture; package tests pin the list/set/add transcripts and the `/model` session log, including `command/run` source `user`.

## Testing

`apps/cli` specs cover `models list|set|discover` and `providers add|list|remove` against a temp `$SHRES_HOME`, including `--effort`, `--purpose`, prompted keys, unknown-effort failure, omitted-effort persistence, ollama-cloud `--add` pin survival, shipped-route remove, and CLI catalog ids matching the base bundle. `agent-default-model` specs cover `/model` parse/list/switch, user-authored `command/run`, `selectionFor` precedence, purpose persistence, materialized-default stripping, and subagent refusal. `ui-model-selection` specs cover the `/model` decoration.
