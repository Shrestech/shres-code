# Delegate to product CLIs

Roos Code can hand a task to another coding agent, or it can run that same agent as the conversation model. Those are two different contracts.

## Subagent tools

`subagent`, `subagent_fork`, and the optional product tools (`subagent_codex`, `subagent_claude_code`, `subagent_grok_cli`, `subagent_kimi_cli`) are capability-honest delegation. The parent model calls a tool. The child is a fresh process in the session workspace. The parent sees only the child's final text or a structured failure.

The `code`, `standard`, and Cordis plugin-development presets ship the Grok and Kimi tool rows with `disabled: true`. Copy the preset, remove `disabled`, and mount the matching provider plugin on the host:

```yaml
- id: subagent-grok-cli
  name: '@roos-code/roos-code-subagent-grok-cli'
  config:
    env:
      XAI_API_KEY: !!js process.env.XAI_API_KEY
```

An API key reaches the child only when `env` names it. The subprocess seam strips credential-shaped ambient variables. Install Grok Build (`grok`) or Kimi Code CLI (`kimi`) on `PATH` yourself; the plugin does not install or log in.

## Delegated model routes

`claude-cli`, `codex-cli`, `grok-cli`, and `kimi-cli` are model-picker routes. Selecting one makes the conversation completion that CLI, not an HTTP adapter. The Models page and `roos models list` mark them `delegated`.

```sh
roos models set grok-cli grok-4.6 --effort high
roos models set kimi-cli kimi-code/k3 --effort high
```

`--effort` is validated against the efforts that CLI advertises (`grok-cli`: `low`/`medium`/`high`/`xhigh`; `kimi-cli`: `off`/`high`). The CLI's own tools do not go through Roos Code approval. That is the meaning of the Delegated tag.

The [CLI models guide](./models.md) owns `roos models` / `/model`. The [CLI agent bridges](../../../.agents/notes/implemented/architecture/2026-08-16-cli-agent-bridges.md) note owns the subagent-versus-route split.
