# 把任务委派给产品 CLI

[English](subagents.md) | 中文

Roos Code 既可以把任务交给另一个编码智能体，也可以把同一个智能体当作会话模型来运行。这是两种不同的约定。

## Subagent 工具

`subagent`、`subagent_fork` 以及可选的产品工具（`subagent_codex`、`subagent_claude_code`、`subagent_grok_cli`、`subagent_kimi_cli`）是能力诚实的委派。父模型调用一个工具。子进程是会话工作区中的全新进程。父级只看到子级的最终文本或结构化失败。

`code`、`standard` 和 `cordis` 预设以 `disabled: true` 交付 Grok 与 Kimi 工具行。复制预设，去掉 `disabled`，并在 host 上挂载对应的提供方插件：

```yaml
- id: subagent-grok-cli
  name: '@roos-code/roos-code-subagent-grok-cli'
  config:
    env:
      XAI_API_KEY: !!js process.env.XAI_API_KEY
```

只有 `env` 写出 API 密钥时，子进程才能拿到它。子进程 seam 会去掉凭据形态的环境变量。请自行把 Grok Build（`grok`）或 Kimi Code CLI（`kimi`）装到 `PATH`；插件不负责安装或登录。

## 委派模型路由

`claude-cli`、`codex-cli`、`grok-cli` 和 `kimi-cli` 是模型选择器路由。选中其中一条，会话补全就由该 CLI 完成，而不是 HTTP 适配器。Models 页和 `roos models list` 将它们标为 `delegated`。

```sh
roos models set grok-cli grok-4 --effort high
roos models set kimi-cli k2 --effort high
```

`--effort` 会对照该 CLI 公布的强度校验（`grok-cli`：`low`/`medium`/`high`/`xhigh`；`kimi-cli`：`off`/`high`）。该 CLI 自带的工具不会经过 Roos Code 审批。这就是 Delegated 标签的含义。

[CLI 模型指南](./models.md) 负责 `roos models` / `/model`。[CLI agent bridges](../../../.agents/notes/implemented/architecture/2026-08-16-cli-agent-bridges.md) 说明负责 subagent 与路由的划分。
