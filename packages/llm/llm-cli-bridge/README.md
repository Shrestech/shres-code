# @roos-code/roos-code-llm-cli-bridge

Delegated-completion adapter: `stream()` serializes `system` plus `messages` into a prompt, spawns a product CLI through [`roos-subprocess`](../../subprocess/subprocess/README.md), and emits `block-start` → `text-delta` → `block-end` → optional `usage` → `finish: stop`. There is no HTTP request, so `attributionHeaders()` does not apply.

The four shipped routes are `claude-cli`, `codex-cli`, `grok-cli`, and `kimi-cli`. They are marked `kind: 'delegated'` on `providerInfo()` and in the configurable-provider directory. The CLI's own tools bypass harness approval; the Models picker shows a Delegated tag. See the [CLI agent bridges](../../../.agents/notes/implemented/architecture/2026-08-16-cli-agent-bridges.md) note.

## Honesty gate

A non-empty `GenerateOptions.tools` without that route's `allowDelegatedTools: true` throws `LlmError` `UNSUPPORTED_OPTION`. Shipped routes set the flag true so a selected CLI can serve the conversation loop. A deployment that wants the route only for tool-free auxiliary calls sets the flag false.

## Model and effort

`stream()` forwards `GenerateOptions.model` and `GenerateOptions.reasoningEffort` through the per-route flag map. `resolveModel()` advertises conservative `contextWindow` / `defaultMaxTokens` and the efforts that CLI accepts, so `roos models set grok-cli <model> --effort <level>` validates through `resolveCallConfig()`.

| Route | Binary | Model flag | Effort |
|---|---|---|---|
| `grok-cli` | `grok` | `--model` | `--effort` (`low`/`medium`/`high`/`xhigh`) |
| `kimi-cli` | `kimi` | `--model` | `--thinking` / `--no-thinking` (`high` / `off`) |
| `claude-cli` | `claude` | `--model` | `--effort` (`low`/`medium`/`high`/`max`) |
| `codex-cli` | `codex` | `-m` | `-c model_reasoning_effort=` (`minimal`/`low`/`medium`/`high`/`xhigh`) |

## Configuration

The optional `llm-cli-bridge` settings section overlays the composition entry. Each route accepts `binary`, `modelArg`, `effortArg`, `effortStyle`, `apiKeyEnv`, `allowDelegatedTools`, and an advisory `models` list. An API key is stored write-only through the credentials seam under `apiKeyEnv`; the adapter injects the resolved secret into spawn env after the subprocess scrub. `env` values, if present, are `role('secret')` and are not written by the Models card.

## Model Experience

### What the model sees

The external CLI sees one serialized prompt (system text, then `user` / `assistant` / `tool` sections). It does not see harness tool schemas unless `allowDelegatedTools` is true, in which case it still runs **its own** tools, not the harness catalog.

### Token effect

The child CLI pays for its own context. When the CLI reports usage, the adapter emits a `usage` chunk; otherwise the stream has none.

### KV Cache effect

Independent of harness HTTP request cache. There is no provider replay state.

## Known Limitations and Deferred Work

- **Delegated tools bypass harness approval** — stated in the picker and this README.
- **No HTTP attribution** — the child CLI owns its User-Agent.
- **No live token streaming** — the adapter emits the final text as one delta after the process exits.
- **Host-managed binaries** — a missing `grok` / `kimi` / `claude` / `codex` is a spawn error.
- **Keyless delegated routes do not complete first-run** — `kind: 'delegated'` is not usable for onboarding, same as composed local Ollama.
- **Spawn cwd is the session workspace** — `stream()` fails if the request has no session header cwd.
