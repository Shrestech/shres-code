# Agent Note: Grok Build CLI headless spike

Status: implemented

English | [中文](2026-08-16-grok-cli-headless-spike.zh.md)

## Problem

Roos Code needed a capability-honest way to delegate a one-shot task to the official xAI Grok Build CLI, and a model-picker route that can select that CLI's model and reasoning effort. The harness cannot invent a wire protocol; the product CLI's documented headless flags decide whether a spawn is usable.

## Decision

The official product is **Grok Build** (`grok`), installed from [xAI Build](https://docs.x.ai/build/overview) (`grok update` after first install). Authentication is `grok login` or an explicit `XAI_API_KEY` overlay; the subprocess seam scrubs credential-shaped names, so a key reaches the child only when the composition writes it into `env`.

Headless mode is first-class: `grok -p "<prompt>"` (`--single`) runs one prompt and exits. `--output-format json` emits one JSON object at the end; `--output-format streaming-json` emits NDJSON events; `plain` is human text. `--always-approve` (alias `--yolo`) auto-approves the CLI's own tools. `--no-auto-update` skips background update checks in scripts.

Model and effort are CLI flags: `-m` / `--model <MODEL>` and `--effort <LEVEL>`. Documented effort levels are `low`, `medium`, `high`, and `xhigh` (Grok 4.6 adds `xhigh`; older models reject an unsupported level). Exit status is 0 on success and non-zero on failure; a non-zero exit or an error payload is a structured failure, never a fake success.

Parse mode for both the `grok-cli` subagent and the `grok-cli` llm-cli-bridge route is **one-shot JSON** (`--output-format json`): collect stdout, require exit 0, extract the final text from `result` / `text` / `message`. Streaming-json is unused because the harness only needs the final answer. ACP (`grok agent stdio`) is a separate product surface and is not this provider.

## Alternatives considered

**Speak ACP over `grok agent stdio`.** Rejected for this package because the existing product-subagent pattern for a one-shot CLI is spawn + final text, and ACP already has `subagent-acp`.

**Use the unofficial `superagent-ai/grok-cli` (`--format json`).** Rejected because it is not the official xAI binary; the shipped executable name is `grok` from Grok Build.

**Fall back to the Phase 4 `xai` HTTP route.** Not needed: Grok Build has a documented, usable headless mode.

## Consequences

`subagent-grok-cli` spawns `grok -p … --output-format json --always-approve --no-auto-update` through `ctx.subprocess`. `llm-cli-bridge` forwards `GenerateOptions.model` as `--model` and `GenerateOptions.reasoningEffort` as `--effort`, and `resolveModel()` advertises `low` / `medium` / `high` / `xhigh` so `roos models set grok-cli <model> --effort <level>` validates before write. The CLI's own tools bypass harness approval; that limit is stated on the picker and in the user guide.
