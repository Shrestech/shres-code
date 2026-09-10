# Manage models from the CLI

`shres models` and `shres providers` read and write the same `$SHRES_HOME/settings.yaml` and `$SHRES_HOME/.credentials.yaml` stores as **Settings → Models**. There is no second configuration path; a change on either surface is visible to the other after the next settings hot-reload.

The [provider guide](./providers.md) owns first-run picking, custom route fields, and image-input claims. This page is the CLI command reference.

## List providers and models

```sh
shres models list
```

The transcript prints the current `agent-default-model` default, any stored purpose overrides, then every configurable provider and its advertised models. The default pair is marked. A route that names an `apiKeyEnv` whose credential is not stored is flagged `unusable until keyed`.

`shres providers list` prints the same transcript.

## Set the default model

```sh
shres models set ollama-local llama3.2
shres models set deepseek-official deepseek-v4-pro --effort max
shres models set --purpose compaction ollama-local llama3.2
```

`set` writes the `agent-default-model` section. `--effort` stores `reasoningEffort` after the adapter metadata (`LlmReasoningEffortInfo`) accepts that level for the chosen model; omitting `--effort` writes only `{ provider, model }` and does not persist an adapter default. An unknown effort fails before anything is written. Delegated CLI routes (`grok-cli`, `kimi-cli`, `claude-cli`, `codex-cli`, `cursor-cli`) advertise the efforts that CLI actually accepts, so `shres models set grok-cli grok-4.6 --effort high` is the same write path. `--purpose compaction` or `--purpose session-title` writes a purpose override and leaves the conversation default in place.

The [product CLI guide](./subagents.md) owns the subagent-versus-delegated-route split and the approval warning on those routes.

Compaction and session-title requests call `ctx.llm.stream()` with `purpose` set and do not enter the conversation `agent/request` waterfall, so a stored purpose override is not applied until those callers read it.

## Discover models

```sh
shres models discover ollama-local
shres models discover ollama-local --base-url http://127.0.0.1:11434/v1 --add
```

`discover` asks the same path the Models page uses: `GET /v1/models`, and on an Ollama route `POST /api/show` for vision and context. `--add` appends advertised ids (and any declared `input` or window) to that route's stored model list. Existing rows are not rewritten.

## Add or remove a provider

```sh
shres providers add --template ollama-local
shres providers add --template openai
shres providers add --template custom --provider acme-gateway --base-url https://gateway.example/v1 --model acme-large
shres providers remove acme-gateway
```

`--template` is one of `ollama-local`, `ollama-cloud`, `openai`, `anthropic`, `xai`, `moonshotai`, `openrouter`, `groq`, `zai`, or `custom`. Omitted flags are prompted on a TTY. A fully flag-driven invocation is valid for scripts.

An API key is never an argv value. The command prompts on a hidden TTY line or reads one stdin line, then stores it through `ctx.credentials.set` at `0600`. Settings keep only the `credential-ref` name (`apiKeyEnv`).

`remove` unsets a user-owned `llm-pi-ai` route. Removing a shipped template such as `openai` only clears a user override; the shipped route remains. Composition-owned routes such as `deepseek-official` cannot be removed here.

## Switch mid-session

In a session that composes the command registry, `/model` prints the current selection and advertised efforts. `/model <provider> <model> [--effort <level>]` writes the session `ModelSelection` for the next assembled turn and also `saveSelection()`s that pair as the process-wide default used by future sessions and Settings → Models. The gesture is user-authored: `command/run` records `source: { kind: 'user' }`, and the model cannot invoke it as a tool. `/model` is refused on a subagent session so a child switch cannot change the root default.
