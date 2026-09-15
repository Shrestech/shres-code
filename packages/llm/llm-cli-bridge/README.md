# @shres-code/shres-code-llm-cli-bridge

Delegated-completion adapter for hand-declared CLI routes: `stream()` serializes `system` plus `messages` into a prompt, spawns the route's binary through [`shres-subprocess`](../../subprocess/subprocess/README.md), and emits `block-start` → `text-delta` → `block-end` → optional `usage` → `finish: stop`. There are no shipped routes: the shipped CLI delegations (`claude-cli`, `codex-cli`, `cursor-cli`, `grok-cli`, `kimi-cli`) were retired in favor of the subscription-session routes `codex-session`, `grok-session`, and `cursor-session`, and this adapter now registers custom routes declared in the `llm-cli-bridge` settings section only. Registered routes are marked `kind: 'delegated'` on `providerInfo()` and in the configurable-provider directory, so the Models picker shows a Delegated tag. There is no HTTP request, so `attributionHeaders()` does not apply.

## Live streaming

A route with `parseMode: 'stream-json'` streams while the CLI runs: the adapter polls incremental stdout reads and maps recognized transcript events to chunks as they arrive — `thinking` deltas become a reasoning block, each assistant message becomes a text block (a same-call snapshot that only grew extends its open block), and each `tool_call` started/completed pair becomes a `server-tool-call` block recorded for rendering and never dispatched by the agent loop. The final `result` object supplies usage, and its text is the reply only when no assistant event streamed. An error payload throws as soon as its line arrives. A transcript with no recognized events falls back to whole-transcript parsing at process end, so foreign stream-json shapes keep the collect-at-exit behavior. `parseMode: 'json'` always collects and parses at exit.

## Honesty gate

A non-empty `GenerateOptions.tools` without that route's `allowDelegatedTools: true` throws `LlmError` `UNSUPPORTED_OPTION`. The flag opts a route in to serving a conversation loop through the CLI's own tools; `CUSTOM_ROUTE_TEMPLATE` defaults it to false, so an overlay must opt in, and a deployment that wants the route only for tool-free auxiliary calls leaves it false.

## Model and effort

Each route declares its own flag map, and `stream()` forwards `GenerateOptions.model` and `GenerateOptions.reasoningEffort` through it: `modelArg` receives the model id, `promptStyle` places the serialized prompt behind `promptArg` or as the trailing positional, and `effortStyle` selects the effort dialect — `flag` sends `<effortArg> <id>`, `thinking-bool` sends `--thinking` / `--no-thinking` (for `high` / `off`), and `codex-config` sends `-c <effortArg>=<id>` with the key defaulting to `model_reasoning_effort`. An effort outside the route's advertised `efforts` throws `UNSUPPORTED_OPTION`, and a route that advertises no efforts resolves with no reasoning metadata. `resolveModel()` advertises the route's `contextWindow`, `defaultMaxTokens`, and efforts, so `shres models set <route> <model> --effort <level>` validates through `resolveCallConfig()`.

## Configuration

The optional `llm-cli-bridge` settings section overlays the composition entry; both carry the same named route dict, and every route needs `displayName` and `binary`. Unspecified fields start conservative from `CUSTOM_ROUTE_TEMPLATE`: `modelArg: '--model'`, `promptArg: '-p'`, `parseMode: 'json'`, no efforts, no extra args, no delegated tools, `contextWindow` 128000, and `defaultMaxTokens` 8192. Each route accepts `modelArg`, `effortArg`, `effortStyle`, `efforts`, `extraArgs`, `promptStyle`, `promptArg`, `parseMode`, `env`, `apiKeyEnv`, `allowDelegatedTools`, `contextWindow`, `defaultMaxTokens`, an advisory `models` list, and `enabled` (default true); an empty effort or model id throws at resolve time. `enabled: false` keeps the route in the Models directory but withdraws it from the live adapter registry, so the composer picker no longer offers it. Directory entries carry the resolved `binary` and whether that command is on PATH, which Models shows as found / not on PATH. An API key is optional (the CLI's own login can be enough) and is stored write-only through the credentials seam under `apiKeyEnv` when typed; the adapter injects the resolved secret into spawn env after the subprocess scrub. `env` values, if present, are `role('secret')` and are not written by the Models card. The advisory `models` list feeds the picker only; unlisted model ids still resolve.

### Worked example: a `cursor-cli` overlay

The `cursor-session` route lists Cursor subscription models but refuses chat turns; this declaration is the serving path for Cursor completions, running the `cursor-agent` binary:

```yaml
# $SHRES_HOME/settings.yaml
llm-cli-bridge:
  routes:
    cursor-cli:
      displayName: Cursor Agent CLI (delegated)
      binary: cursor-agent
      modelArg: --model
      effortStyle: flag
      extraArgs: [-p, --output-format, stream-json, --force]
      promptStyle: trailing
      parseMode: stream-json
      apiKeyEnv: CURSOR_API_KEY
      allowDelegatedTools: true
      contextWindow: 128000
      defaultMaxTokens: 8192
      models:
        - { id: gpt-5.2, name: GPT-5.2 }
        - { id: claude-4.5-sonnet, name: Sonnet 4.5 }
        - { id: cursor-grok-4.6-high, name: Grok 4.6 (high) }
        - { id: cursor-grok-4.6-high-fast, name: Grok 4.6 (high, fast) }
        - { id: claude-fable-5-1-thinking-high, name: Fable 5.1 Thinking (high) }
        - { id: gemini-3.8-flash-high, name: Gemini 3.8 Flash (high) }
```

`-p` is cursor-agent's print flag, not a prompt flag, so the prompt rides as the trailing positional; `--output-format stream-json` emits one NDJSON event per line that the adapter maps live (thinking, assistant text, and tool calls render as the turn runs); `--force` auto-approves the CLI's own tools in headless mode. cursor-agent validates model ids server-side against its prefixed, effort-suffixed catalog, so the advisory list names those exact ids. The template defaults already supply `modelArg`, `effortStyle`, `contextWindow`, and `defaultMaxTokens`; they are spelled out here so the route survives a template change.

## Model Experience

### Delegated CLI prompt

#### What the model sees

The external CLI sees one serialized prompt (system text, then `user` / `assistant` / `tool` sections). It does not see harness tool schemas unless `allowDelegatedTools` is true, in which case it still runs **its own** tools, not the harness catalog.

#### Token effect

The child CLI pays for its own context. When the CLI reports usage, the adapter emits a `usage` chunk; otherwise the stream has none.

#### KV Cache effect

Independent of harness HTTP request cache. There is no provider replay state.

## Known Limitations and Deferred Work

- **No shipped routes** — every route is hand-declared; the shipped CLI delegations were retired in favor of the subscription-session routes (`codex-session`, `grok-session`, `cursor-session`).
- **Delegated tools bypass harness approval** — stated in the picker and this README.
- **No HTTP attribution** — the child CLI owns its User-Agent.
- **No live token streaming** — the adapter emits the final text as one delta after the process exits.
- **Host-managed binaries** — a missing declared binary is a spawn error; nothing installs it.
- **Keyless delegated routes do not complete first-run** — `kind: 'delegated'` is not usable for onboarding, same as composed local Ollama.
- **Spawn cwd is the session workspace** — `stream()` fails if the request has no session header cwd.
