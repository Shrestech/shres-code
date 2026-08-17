# Agent Note: Kimi Code CLI headless spike

Status: implemented


## Problem

Shres Code needed a capability-honest one-shot delegate to Moonshot's Kimi terminal agent, plus a model-picker route that can name that CLI's model and thinking control. Without a documented headless mode the only honest fallback is the Phase 4 `moonshotai` HTTP route.

## Decision

The current official product is **Kimi Code CLI** (`kimi`), installed from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) (`curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`). Authentication is the product login flow or an explicit `MOONSHOT_API_KEY` overlay; the subprocess seam scrubs credential-shaped names, so a key reaches the child only when the composition writes it into `env`.

Headless mode is `kimi -p "<prompt>"` (`--prompt`). `--output-format stream-json` (used with `--prompt`) emits a JSON event stream; default output is `text`. `--yolo` (`-y`) auto-approves ordinary tool calls. The older MoonshotAI/kimi-cli binary uses `--print` instead of `-p` and the same `--output-format stream-json`; the shipped default argv is Kimi Code CLI's `-p`. Deployments that still have the older binary override `executable` / extra argv.

Model is `-m` / `--model <alias>`. There is no `--effort` ladder: thinking is a boolean pair `--thinking` / `--no-thinking`. The adapter therefore advertises only `off` (maps to `--no-thinking`) and `high` (maps to `--thinking`) and rejects any other effort id. Permanent failures exit 1.

Parse mode is **stream-json last result**: collect stdout, require exit 0, take the last event whose `result` / `text` / `message` / `content` is non-empty assistant text. `--final-message-only` is unused so usage-bearing events remain available when present. ACP (`kimi acp`) is not this provider.

## Alternatives considered

**Speak ACP over `kimi acp`.** Rejected for this package: one-shot spawn + final text matches the grok sibling, and ACP already has `subagent-acp`.

**Fall back to the Phase 4 `moonshotai` HTTP route.** Not needed: both Kimi Code CLI and the older kimi-cli have a usable non-interactive print mode.

**Advertise a full effort ladder and drop unknown values.** Rejected: the CLI has only a thinking on/off switch; silent substitution would disagree with `resolveCallConfig()`.

## Consequences

`subagent-kimi-cli` spawns `kimi -p … --output-format stream-json --yolo` through `ctx.subprocess`. `llm-cli-bridge` forwards `GenerateOptions.model` as `--model` and maps `off`/`high` onto `--no-thinking`/`--thinking`. `shres models set kimi-cli <model> --effort high` validates against that two-value list. The CLI's own tools bypass harness approval; that limit is stated on the picker and in the user guide.
