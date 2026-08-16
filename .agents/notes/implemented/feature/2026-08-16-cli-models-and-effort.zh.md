# Agent Note: CLI 模型／提供方与会话内 /model

Status: implemented

[English](2026-08-16-cli-models-and-effort.md) | 中文

## 问题

Web 的 Settings → Models 页面已经写入 `agent-default-model`、`llm-pi-ai` 路由和凭据引用。产品 CLI 可以启动 profile 或运行首次选择器，但不能列出、设置、发现或添加这些相同路由；进行中的会话也不能用用户发出的命令切换提供方、模型或推理强度。

第二份配置文件或 argv 中的 API 密钥会拆分存储，并把秘密泄漏到 shell 历史。

## 决策

`roos models` 与 `roos providers` 启动由 settings-file、credentials-local、llm、llm-pi-ai 和 llm-deepseek 组成的最小组合，然后调用 Models 页面到达的同一组服务（`llm.providers` / `listConfigurableProviders`、`llm.models` / `listModels`、`llm.discoverModels`、`agentDefaultModel.saveSelection`、`credentials.set`）。设置热重载使两个界面保持同步。

`--effort` 在 `resolveCallConfig` 接受适配器 `LlmReasoningEffortInfo` 中的该 id 后，把 `reasoningEffort` 写入 `agent-default-model` 分节。未知强度会在写入前失败。`--purpose compaction|session-title` 写入 `purposes[purpose]`，并保留会话默认值。

API 密钥绝不是 argv 值。命令在隐藏的 TTY 行上提示或读取 stdin，然后通过 `ctx.credentials.set`（`0600`）存储秘密。设置中只携带 `credential-ref` 名称。

当组合了命令注册表时，`agent-default-model` 在 `ctx.commands` 上注册 `/model`，模式与 `/permission` 的可选子功能相同。带参数时通过 `selectionFor(agent)`（`agent/request` waterfall）写入会话 `ModelSelection`，并同时 `saveSelection()` 把该配对写成后续会话的进程级默认值。不带参数时打印当前选择和已公布的推理强度。`command/run` 始终记录 `source: { kind: 'user' }`；命令平面不是模型工具。子代理会话上的 `/model` 会被拒绝。即使适配器物化了 `defaultEffort`，省略的 `--effort` 也不会被持久化。

Web 的 `/model` popup 是该宿主命令的 `commandUi.decorate`，因此名称不会冲突。

压缩与会话标题调用 `ctx.llm.stream()` 并设置 `purpose`，从不进入 `agent/request`。按用途覆盖会被存储和列出；这些消费方尚未读取 `selectionForPurpose`。

## 考虑过的替代方案

**单独的仅 CLI 配置文件。** 否决，因为 Settings → Models 已经拥有该存储，并行文件会在热重载时失步。

**argv 上的 `--api-key`。** 否决，因为秘密会进入 shell 历史。隐藏提示或 stdin 是唯一写入路径。

**新的 `command-model` 包。** 否决，因为 `/permission` 位于领域服务上；`agent-default-model` 已经拥有 `ModelSelection`。

**通过 `agent/request` 路由按用途覆盖。** 否决，因为压缩和标题不使用该 waterfall。应用它们需要改那些调用方；存储映射才是便宜的部分。

## 后果

CLI 与 Web 共享一个默认值、一个提供方目录和一个凭据存储。会话中途的 `/model` 由用户发出，在下一轮组装的请求上生效，并同时更新进程级默认值。按用途覆盖存在于磁盘上，但尚未重定向辅助的 `llm.stream()` 调用。

快照工具没有 CLI 子命令或会话中途 `/model` 的 fixture；包测试钉住 list/set/add 文本记录以及 `/model` 会话日志，包括 `command/run` 的 source `user`。

## 测试

`apps/cli` 规格在临时 `$ROOS_HOME` 上覆盖 `models list|set|discover` 与 `providers add|list|remove`，包括 `--effort`、`--purpose`、提示输入的密钥、未知强度失败、省略 `--effort` 时的持久化、ollama-cloud `--add` 保留 pinned 容量、随附路由 remove，以及 CLI 目录 id 与基础组合一致。`agent-default-model` 规格覆盖 `/model` 解析／列出／切换、用户发出的 `command/run`、`selectionFor` 优先级、按用途持久化、剥离物化默认强度，以及拒绝子代理。`ui-model-selection` 规格覆盖 `/model` decoration。
