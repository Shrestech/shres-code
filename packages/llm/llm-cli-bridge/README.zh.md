# @roos-code/roos-code-llm-cli-bridge

[English](README.md) | 中文

委派补全适配器：`stream()` 把 `system` 和 `messages` 序列化成提示，通过 [`roos-subprocess`](../../subprocess/subprocess/README.md) 启动产品 CLI，并按 `block-start` → `text-delta` → `block-end` → 可选 `usage` → `finish: stop` 发射。没有 HTTP 请求，因此不适用 `attributionHeaders()`。

四条已交付路由是 `claude-cli`、`codex-cli`、`grok-cli` 和 `kimi-cli`。它们在 `providerInfo()` 和可配置提供方目录上标为 `kind: 'delegated'`。该 CLI 自带的工具会绕过 harness 审批；Models 选择器显示 Delegated 标签。见 [CLI agent bridges](../../../.agents/notes/implemented/architecture/2026-08-16-cli-agent-bridges.md) 说明。

## 诚实检查

当 `GenerateOptions.tools` 非空且该路由没有 `allowDelegatedTools: true` 时，抛出 `LlmError` `UNSUPPORTED_OPTION`。已交付路由将该标志设为 true，以便所选 CLI 能服务会话循环。若部署只想把该路由用于无工具的辅助调用，可将标志设为 false。

## 模型与强度

`stream()` 通过每路由标志映射转发 `GenerateOptions.model` 与 `GenerateOptions.reasoningEffort`。`resolveModel()` 公布保守的 `contextWindow` / `defaultMaxTokens` 以及该 CLI 接受的强度，因此 `roos models set grok-cli <model> --effort <level>` 会经过 `resolveCallConfig()` 校验。

| 路由 | 二进制 | 模型标志 | 强度 |
|---|---|---|---|
| `grok-cli` | `grok` | `--model` | `--effort`（`low`/`medium`/`high`/`xhigh`） |
| `kimi-cli` | `kimi` | `--model` | `--thinking` / `--no-thinking`（`high` / `off`） |
| `claude-cli` | `claude` | `--model` | `--effort`（`low`/`medium`/`high`/`max`） |
| `codex-cli` | `codex` | `-m` | `-c model_reasoning_effort=`（`minimal`/`low`/`medium`/`high`/`xhigh`） |

## 配置

可选的 `llm-cli-bridge` settings 分节覆盖组合条目。每条路由接受 `binary`、`modelArg`、`effortArg`、`effortStyle`、`env`、`allowDelegatedTools` 以及一份建议 `models` 列表。API 密钥只有通过该路由的 `env` 覆盖才会到达子进程。

## Model Experience

### 模型看到什么

外部 CLI 看到一份序列化提示（系统文本，然后是 `user` / `assistant` / `tool` 分段）。除非 `allowDelegatedTools` 为 true，否则它看不到 harness 工具 schema；即便为 true，它运行的仍是**自己的**工具，而不是 harness 目录。

### Token 影响

子 CLI 支付自己的上下文。当 CLI 报告用量时，适配器发射 `usage` 分片；否则流中没有用量。

### KV Cache 影响

与 harness HTTP 请求缓存无关。没有提供方回放状态。

## Known Limitations and Deferred Work

- **委派工具绕过 harness 审批** — 写在选择器与本 README 中。
- **没有 HTTP attribution** — 子 CLI 拥有自己的 User-Agent。
- **没有实时 token 流** — 适配器在进程退出后把最终文本作为一次 delta 发射。
- **由主机管理二进制** — 缺少 `grok` / `kimi` / `claude` / `codex` 是 spawn 错误。
- **无密钥委派路由不会结束首次运行** — `kind: 'delegated'` 与组合中的本机 Ollama 一样，不计入 onboarding 可用。
- **spawn 工作目录是会话工作区** — 请求没有会话 header cwd 时 `stream()` 失败。
