# Agent Note: Grok Build CLI headless spike

Status: implemented

[English](2026-08-16-grok-cli-headless-spike.md) | 中文

## Problem

Roos Code 需要一种能力诚实的方式，将一次性任务委派给官方 xAI Grok Build CLI，并需要一条可选择该 CLI 模型与推理强度的模型选择器路由。Harness 不能发明协议；产品 CLI 已文档化的无头标志决定 spawn 是否可用。

## Decision

官方产品是 **Grok Build**（`grok`），从 [xAI Build](https://docs.x.ai/build/overview) 安装（首次安装后可用 `grok update`）。鉴权是 `grok login` 或显式的 `XAI_API_KEY` 覆盖；子进程 seam 会清洗凭据形态的环境名，因此只有组合把密钥写入 `env` 时，子进程才能拿到密钥。

无头模式是一等能力：`grok -p "<prompt>"`（`--single`）发送一次提示并退出。`--output-format json` 在结束时输出一个 JSON 对象；`--output-format streaming-json` 输出 NDJSON 事件；`plain` 是人类可读文本。`--always-approve`（别名 `--yolo`）自动批准该 CLI 自带的工具。`--no-auto-update` 在脚本中跳过后台更新检查。

模型与强度是 CLI 标志：`-m` / `--model <MODEL>` 以及 `--effort <LEVEL>`。已文档化的强度为 `low`、`medium`、`high` 和 `xhigh`（Grok 4.6 增加 `xhigh`；较旧模型会拒绝不支持的级别）。退出码 0 表示成功，非零表示失败；非零退出或错误载荷都是结构化失败，绝不当作假成功。

`grok-cli` subagent 与 `grok-cli` llm-cli-bridge 路由的解析模式都是**一次性 JSON**（`--output-format json`）：收集 stdout，要求退出码 0，从 `result` / `text` / `message` 提取最终文本。不使用 streaming-json，因为 harness 只需要最终答案。ACP（`grok agent stdio`）是另一条产品面，不是本提供方。

## Alternatives considered

**通过 `grok agent stdio` 讲 ACP。** 对本包拒绝：现有一次性 CLI 产品 subagent 模式是 spawn + 最终文本，且 ACP 已有 `subagent-acp`。

**使用非官方 `superagent-ai/grok-cli`（`--format json`）。** 拒绝：那不是官方 xAI 二进制；已交付的可执行文件名是 Grok Build 的 `grok`。

**回退到 Phase 4 的 `xai` HTTP 路由。** 不需要：Grok Build 有已文档化、可用的无头模式。

## Consequences

`subagent-grok-cli` 通过 `ctx.subprocess` 启动 `grok -p … --output-format json --always-approve --no-auto-update`。`llm-cli-bridge` 把 `GenerateOptions.model` 转成 `--model`，把 `GenerateOptions.reasoningEffort` 转成 `--effort`，并且 `resolveModel()` 公布 `low` / `medium` / `high` / `xhigh`，因此 `roos models set grok-cli <model> --effort <level>` 会在写入前完成校验。该 CLI 自带的工具会绕过 harness 审批；该限制写在选择器与用户指南中。
