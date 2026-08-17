# Agent Note: CLI agent bridges — subagent vs delegated completion

Status: implemented

## Problem

Product CLIs (Grok Build, Kimi Code, Codex, Claude Code) already exist as full agents with their own tools, approvals, and models. Shres Code can either delegate a task to one of those agents, or treat the same binary as a model route. Collapsing those two uses into one plugin would either hide harness tools (silent drop) or pretend the external CLI's tools go through Shres Code approval (they do not).

## Decision

Two packages, two honesty rules.

**Subagent providers** (`subagent-grok-cli`, `subagent-kimi-cli`, beside the existing `subagent-codex` and `subagent-claude-code`) are capability-honest delegation. The parent model calls `subagent_grok_cli` / `subagent_kimi_cli`. The child is a fresh process in the parent Session cwd. The parent sees only the final text or a structured failure. The provider advertises `NO_START_CAPABILITIES` and `inheritsParentContext: false`. An API key reaches the child only through an explicit `env` overlay; the subprocess seam scrubs credential-shaped ambient names.

**`llm-cli-bridge`** is delegated completion. Routes `claude-cli`, `codex-cli`, `grok-cli`, and `kimi-cli` register on `ctx.llm` from a settings section. `stream()` serializes `system` + `messages` to a prompt, spawns the configured binary, and emits `block-start` → `text-delta` → `block-end` → optional `usage` → `finish: stop`. There is no HTTP request, so `attributionHeaders()` does not apply. `resolveModel()` returns a conservative `contextWindow` / `defaultMaxTokens` and the efforts that CLI actually accepts. `stream()` forwards `GenerateOptions.model` and `GenerateOptions.reasoningEffort` through the per-route flag map (`--model` / `--effort`, kimi `--thinking`/`--no-thinking`, Codex `-c model_reasoning_effort=`). `shres models set grok-cli <model> --effort <level>` therefore validates through `resolveCallConfig()`.

Honesty gate: a non-empty `GenerateOptions.tools` without that route's `allowDelegatedTools: true` throws `LlmError` `UNSUPPORTED_OPTION`. Shipped routes set `allowDelegatedTools: true` because they exist to run the CLI as the conversation model; the picker and docs still mark them **delegated**. The CLI's own tool calls never enter harness approval.

Per-route settings: `binary`, `modelArg`, `effortArg` / `effortStyle`, `env`, `allowDelegatedTools`, and an advisory model list. Effort styles are `flag` (grok/claude `--effort`), `thinking-bool` (kimi), and `codex-config`.

## Alternatives considered

**One plugin that is both a subagent provider and an LLM adapter.** Rejected because the parent-visible contract differs: a subagent result is a tool result; a model route is the conversation completion. Mixing them would let a loop request look like it still owns tools.

**Silently drop harness tools on a CLI route.** Rejected: the loop would believe the model can call `bash` / `fs` while the CLI ignores those schemas.

**Require `allowDelegatedTools: false` by default and fail every loop turn.** Rejected as the shipped default because the picker entries exist to be selected; the delegated mark plus docs carry the approval warning. A deployment can still set the flag false.

**HTTP attribution on the spawned CLI.** Rejected: there is no harness HTTP request. The child CLI owns its own User-Agent.

## Consequences

Copy a preset and remove `disabled` from `tool-subagent-grok-cli` / `tool-subagent-kimi-cli` to expose those tools; mount the matching provider plugin on the host. Select `grok-cli` / `kimi-cli` / `claude-cli` / `codex-cli` from the Models page or `shres models set` to run the conversation through that CLI. Selectors show a Delegated tag. Keyless specs cover argv (including selected model + effort), the tools honesty gate, and signal teardown; real-binary e2e mounts a `sessions` provider with a workspace cwd and self-skips when the executable is absent.

The spawned CLIs remain unsandboxed and grok/kimi still pass `--always-approve` / `--yolo`. That is accepted for these opt-in delegated packages: containment is the subprocess env scrub, session cwd, and stdin-ignore. A `SubprocessSpawnSpec` sandbox field that routes through `ctx.sandbox.confine` is a later seam, not the shipped default.
