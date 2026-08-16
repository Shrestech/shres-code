# Agent Note: CLI agent bridges — subagent vs delegated completion

Status: implemented

[English](2026-08-16-cli-agent-bridges.md) | 中文

## Problem

产品 CLI（Grok Build、Kimi Code、Codex、Claude Code）本身已是带自有工具、审批与模型的完整智能体。Roos Code 既可以把任务委派给其中一个智能体，也可以把同一二进制当作模型路由。若把这两种用途压进一个插件，要么会隐藏 harness 工具（静默丢弃），要么会假装外部 CLI 的工具经过了 Roos Code 审批（实际上没有）。

## Decision

两个包，两条诚实规则。

**Subagent 提供方**（`subagent-grok-cli`、`subagent-kimi-cli`，与已有的 `subagent-codex`、`subagent-claude-code` 并列）是能力诚实的委派。父模型调用 `subagent_grok_cli` / `subagent_kimi_cli`。子进程是父会话 cwd 中的全新进程。父级只看到最终文本或结构化失败。提供方公布 `NO_START_CAPABILITIES` 且 `inheritsParentContext: false`。API 密钥只有通过显式 `env` 覆盖才会到达子进程；子进程 seam 会清洗凭据形态的环境名。

**`llm-cli-bridge`** 是委派补全。路由 `claude-cli`、`codex-cli`、`grok-cli`、`kimi-cli` 从 settings 分节注册到 `ctx.llm`。`stream()` 把 `system` + `messages` 序列化成提示，启动配置的二进制，并按 `block-start` → `text-delta` → `block-end` → 可选 `usage` → `finish: stop` 发射。没有 HTTP 请求，因此不适用 `attributionHeaders()`。`resolveModel()` 返回保守的 `contextWindow` / `defaultMaxTokens`，以及该 CLI 实际接受的强度。`stream()` 通过每路由标志映射转发 `GenerateOptions.model` 与 `GenerateOptions.reasoningEffort`（`--model` / `--effort`，kimi 的 `--thinking`/`--no-thinking`，Codex 的 `-c model_reasoning_effort=`）。因此 `roos models set grok-cli <model> --effort <level>` 会经过 `resolveCallConfig()` 校验。

诚实检查：当 `GenerateOptions.tools` 非空且该路由没有 `allowDelegatedTools: true` 时，抛出 `LlmError` `UNSUPPORTED_OPTION`。已交付路由设置 `allowDelegatedTools: true`，因为它们的用途就是把 CLI 当作会话模型；选择器与文档仍将其标为 **delegated**。该 CLI 自带的工具调用从不进入 harness 审批。

每路由 settings：`binary`、`modelArg`、`effortArg` / `effortStyle`、`env`、`allowDelegatedTools`，以及一份建议模型列表。强度风格是 `flag`（grok/claude 的 `--effort`）、`thinking-bool`（kimi）和 `codex-config`。

## Alternatives considered

**一个插件既当 subagent 提供方又当 LLM 适配器。** 拒绝：父级可见约定不同——subagent 结果是工具结果，模型路由是会话补全。混在一起会让循环请求看起来仍拥有工具。

**在 CLI 路由上静默丢弃 harness 工具。** 拒绝：循环会以为模型仍能调用 `bash` / `fs`，而 CLI 会忽略那些 schema。

**默认要求 `allowDelegatedTools: false` 并让每一轮循环失败。** 作为已交付默认值拒绝，因为选择器条目就是为了被选中；Delegated 标记与文档承担审批警告。部署仍可将该标志设为 false。

**给被启动的 CLI 加 HTTP attribution。** 拒绝：没有 harness HTTP 请求。子 CLI 拥有自己的 User-Agent。

## Consequences

复制一份预设并去掉 `tool-subagent-grok-cli` / `tool-subagent-kimi-cli` 上的 `disabled`，即可暴露这些工具；在 host 上挂载对应的提供方插件。从 Models 页或 `roos models set` 选择 `grok-cli` / `kimi-cli` / `claude-cli` / `codex-cli`，即可让会话走该 CLI。选择器显示 Delegated 标签。无密钥规格覆盖 argv（包括所选模型与强度）、工具诚实检查和信号拆除；真实二进制 e2e 在可执行文件缺失时自行跳过。
