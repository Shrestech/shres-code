# Manage models from the CLI

English | [中文](models.zh.md)

`roos models` and `roos providers` read and write the same `$ROOS_HOME/settings.yaml` and `$ROOS_HOME/.credentials.yaml` stores as **Settings → Models**. There is no second configuration path; a change on either surface is visible to the other after the next settings hot-reload.

The [provider guide](./providers.md) owns first-run picking, custom route fields, and image-input claims. This page is the CLI command reference.

## List providers and models

```sh
roos models list
```

The transcript prints the current `agent-default-model` default, any stored purpose overrides, then every configurable provider and its advertised models. The default pair is marked. A route that names an `apiKeyEnv` whose credential is not stored is flagged `unusable until keyed`.

`roos providers list` prints the same transcript.

## Set the default model

```sh
roos models set ollama-local llama3.2
roos models set deepseek-official deepseek-v4-pro --effort max
roos models set --purpose compaction ollama-local llama3.2
```

`set` writes the `agent-default-model` section. `--effort` stores `reasoningEffort` after the adapter metadata (`LlmReasoningEffortInfo`) accepts that level for the chosen model; an unknown effort fails before anything is written. `--purpose compaction` or `--purpose session-title` writes a purpose override and leaves the conversation default in place.

Compaction and session-title requests call `ctx.llm.stream()` with `purpose` set and do not enter the conversation `agent/request` waterfall, so a stored purpose override is not applied until those callers read it.

## Discover models

```sh
roos models discover ollama-local
roos models discover ollama-local --base-url http://127.0.0.1:11434/v1 --add
```

`discover` asks the same `GET /v1/models` path the Models page uses. `--add` appends advertised ids to that route's stored model list.

## Add or remove a provider

```sh
roos providers add --template ollama-local
roos providers add --template openai
roos providers add --template custom --provider acme-gateway --base-url https://gateway.example/v1 --model acme-large
roos providers remove acme-gateway
```

`--template` is one of `ollama-local`, `ollama-cloud`, `openai`, `anthropic`, `xai`, `moonshotai`, `openrouter`, `groq`, or `custom`. Omitted flags are prompted on a TTY. A fully flag-driven invocation is valid for scripts.

An API key is never an argv value. The command prompts on a hidden TTY line or reads one stdin line, then stores it through `ctx.credentials.set` at `0600`. Settings keep only the `credential-ref` name (`apiKeyEnv`).

`remove` unsets a user-owned `llm-pi-ai` route. Composition-owned routes such as `deepseek-official` cannot be removed here.

## Switch mid-session

In a session that composes the command registry, `/model` prints the current selection and advertised efforts. `/model <provider> <model> [--effort <level>]` writes the session `ModelSelection` for the next assembled turn. The gesture is user-authored: `command/run` records `source: { kind: 'user' }`, and the model cannot invoke it as a tool.
