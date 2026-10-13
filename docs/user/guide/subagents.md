# Delegate to product CLIs

Shres Code can hand a task to another coding agent, or it can run that same agent as the conversation model. Those are two different contracts.

## Subagent tools

`subagent`, `subagent_fork`, and the optional product tools (`subagent_codex`, `subagent_claude_code`, `subagent_grok_cli`, `subagent_kimi_cli`) are capability-honest delegation. The parent model calls a tool. The child is a fresh process in the session workspace. The parent sees only the child's final text or a structured failure.

The `code`, `standard`, and Cordis plugin-development presets ship the Grok and Kimi tool rows with `disabled: true`. Copy the preset, remove `disabled`, and mount the matching provider plugin on the host:

```yaml
- id: subagent-grok-cli
  name: '@shres-code/shres-code-subagent-grok-cli'
  config:
    env:
      XAI_API_KEY: !!js process.env.XAI_API_KEY
```

An API key reaches the child only when `env` names it. The subprocess seam strips credential-shaped ambient variables. Install Grok Build (`grok`) or Kimi Code CLI (`kimi`) on `PATH` yourself; the plugin does not install or log in.

## Delegated model routes

A delegated route makes the conversation completion an external CLI, not an HTTP adapter. Shres Code ships no delegated routes: one appears in the model picker when declared as an overlay route in the `llm-cli-bridge` settings section — the [CLI bridge README](../../../packages/llm/llm-cli-bridge/README.md) owns the declaration fields and a worked `cursor-cli` example. The Models page and `shres models list` mark these routes `delegated`.

Once declared, the route is selected like any other:

```sh
shres models set grok-cli grok-4.6 --effort high
```

`--effort` is validated against the efforts the route's declaration advertises. The CLI's own tools do not go through Shres Code approval. That is the meaning of the Delegated tag.

The [CLI models guide](./models.md) owns `shres models` / `/model`. The CLI agent bridges note owns the subagent-versus-route split.
