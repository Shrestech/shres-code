# Agent Note: Kimi Code CLI headless spike

Status: implemented

[English](2026-08-16-kimi-cli-headless-spike.md) | 中文

## Problem

Roos Code 需要一种能力诚实的一次性委派，把任务交给 Moonshot 的 Kimi 终端智能体，并需要一条可命名该 CLI 模型与思考开关的模型选择器路由。若没有已文档化的无头模式，唯一诚实的回退是 Phase 4 的 `moonshotai` HTTP 路由。

## Decision

当前官方产品是 **Kimi Code CLI**（`kimi`），从 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) 安装（`curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`）。鉴权是产品登录流程或显式的 `MOONSHOT_API_KEY` 覆盖；子进程 seam 会清洗凭据形态的环境名，因此只有组合把密钥写入 `env` 时，子进程才能拿到密钥。

无头模式是 `kimi -p "<prompt>"`（`--prompt`）。与 `--prompt` 一起使用时，`--output-format stream-json` 输出 JSON 事件流；默认输出是 `text`。`--yolo`（`-y`）自动批准普通工具调用。较旧的 MoonshotAI/kimi-cli 二进制使用 `--print` 而不是 `-p`，并使用同样的 `--output-format stream-json`；已交付的默认 argv 是 Kimi Code CLI 的 `-p`。仍使用旧二进制的部署可覆盖 `executable` / 额外 argv。

模型是 `-m` / `--model <alias>`。没有 `--effort` 阶梯：思考是布尔对 `--thinking` / `--no-thinking`。因此适配器只公布 `off`（映射到 `--no-thinking`）和 `high`（映射到 `--thinking`），并拒绝任何其他强度 id。永久性失败以退出码 1 结束。

解析模式是 **stream-json 最后一条结果**：收集 stdout，要求退出码 0，取最后一条 `result` / `text` / `message` / `content` 为非空助手文本的事件。不使用 `--final-message-only`，以便在存在用量事件时仍能读取。ACP（`kimi acp`）不是本提供方。

## Alternatives considered

**通过 `kimi acp` 讲 ACP。** 对本包拒绝：一次性 spawn + 最终文本与 grok 兄弟包一致，且 ACP 已有 `subagent-acp`。

**回退到 Phase 4 的 `moonshotai` HTTP 路由。** 不需要：Kimi Code CLI 与较旧的 kimi-cli 都有可用的非交互 print 模式。

**公布完整强度阶梯并丢弃未知值。** 拒绝：该 CLI 只有思考开/关；静默替换会与 `resolveCallConfig()` 不一致。

## Consequences

`subagent-kimi-cli` 通过 `ctx.subprocess` 启动 `kimi -p … --output-format stream-json --yolo`。`llm-cli-bridge` 把 `GenerateOptions.model` 转成 `--model`，并把 `off`/`high` 映射到 `--no-thinking`/`--thinking`。`roos models set kimi-cli <model> --effort high` 会对照这个二值列表校验。该 CLI 自带的工具会绕过 harness 审批；该限制写在选择器与用户指南中。
