# @roos-code/roos-code-agent-default-model

[English](README.md) | 中文

该部署默认值供入口在创建尚无会话级模型选择的 Agent 时使用。`AgentDefaultModelConfig` 提供 `ctx.agentDefaultModel`；`roos --profile headless` 这类直接入口与 ApiProxy 这类由 Host 支撑的入口读取同一服务，而不是分别持有平行的提供方／模型默认值。

插件配置必须提供 `{ provider, model }`。该组合配置项构成 Settings 中 `agent-default-model` 分节的基础层；挂载的设置提供方在其上叠加用户选择，更改会在下一次调用 `currentSelection()` 时可见。`reasoningEffort` 属于该 Settings 分节，但特意不属于插件配置：完整保存的选择必须能在下一个选定模型没有推理（reasoning）强度时清除旧值，而组合配置值会再次被继承。

- `ctx.agentDefaultModel.currentSelection()` 返回一份独立的 `{ provider, model, reasoningEffort? }` 选择，供新创建的 Agent 使用。
- `ctx.agentDefaultModel.saveSelection(selection, { purpose? })` 保存会话默认值，或将 `compaction` / `session-title` 覆盖写入 `purposes`。未挂载设置提供方时，此调用不执行任何操作，组合配置项仍为当前值。
- `ctx.agentDefaultModel.selectionFor(agent)` 在该 Agent 的 `agent/request` waterfall 上安装会话级 `ModelSelection`。`/model` 写入同一引用，因此会话中途切换在下一轮组装的请求上生效。
- `ctx.agentDefaultModel.selectionForPurpose(purpose)` 读取已存储的按用途覆盖（若存在）。

当组合了命令注册表时，该服务注册 `/model [<provider> <model>] [--effort <level>]`。不带参数的调用打印当前选择以及已公布模型和对应推理强度。带参数的调用对照适配器元数据（`LlmReasoningEffortInfo`）校验推理强度，并写入会话选择。`commands.execute` 将 `command/run` 记录为 `source: { kind: 'user' }`；命令平面不是模型工具。

该服务不校验目录成员关系。提供方路由可以服务未在目录中公布的模型；实际发起模型请求的消费方负责可用性诊断。

## 模型体验

通过提供给入口的提供方／模型选择间接影响；模型可见请求由请求组装与适配器负责。

#### KV Cache 影响

更改默认值只影响之后从该默认值解析选择的 Agent。请求日志已经指明选择的现有会话仍沿用该选择，因此本服务不会使其已建立的前缀失效。

## 已知限制与暂缓事项

- 压缩与会话标题调用通过 `ctx.llm.stream()` 并设置 `purpose`，不进入 `agent/request`，因此在这些消费方读取 `selectionForPurpose` 之前，已存储的按用途覆盖不会被应用。
- 未挂载设置提供方时，`saveSelection()` 无法保留选择供后续 Agent 使用。
