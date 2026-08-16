# 从 CLI 管理模型

[English](models.md) | 中文

`roos models` 与 `roos providers` 读写的就是 **Settings → Models** 使用的 `$ROOS_HOME/settings.yaml` 与 `$ROOS_HOME/.credentials.yaml`。不存在第二条配置路径；任一界面上的更改会在下一次设置热重载后对另一界面可见。

[提供方指南](./providers.md) 负责首次运行选择、自定义路由字段和图像输入声明。本页是 CLI 命令参考。

## 列出提供方和模型

```sh
roos models list
```

输出会打印当前 `agent-default-model` 默认值、任何已存储的按用途覆盖，以及每个可配置提供方及其公布的模型。默认配对会被标记。若某条路由命名了尚未存储的 `apiKeyEnv` 凭据，会被标为 `unusable until keyed`。

`roos providers list` 打印相同输出。

## 设置默认模型

```sh
roos models set ollama-local llama3.2
roos models set deepseek-official deepseek-v4-pro --effort max
roos models set --purpose compaction ollama-local llama3.2
```

`set` 写入 `agent-default-model` 分节。`--effort` 在适配器元数据（`LlmReasoningEffortInfo`）接受该模型的该级别后存储 `reasoningEffort`；省略 `--effort` 时只写入 `{ provider, model }`，不会持久化适配器默认强度。未知强度会在写入前失败。`--purpose compaction` 或 `--purpose session-title` 写入按用途覆盖，并保留会话默认值。

压缩与会话标题请求通过 `ctx.llm.stream()` 并设置 `purpose`，不进入会话的 `agent/request` waterfall，因此在这些调用方读取之前，已存储的按用途覆盖不会被应用。

## 发现模型

```sh
roos models discover ollama-local
roos models discover ollama-local --base-url http://127.0.0.1:11434/v1 --add
```

`discover` 使用与 Models 页面相同的 `GET /v1/models` 路径。`--add` 会把公布的 id 追加到该路由已存储的模型列表。

## 添加或移除提供方

```sh
roos providers add --template ollama-local
roos providers add --template openai
roos providers add --template custom --provider acme-gateway --base-url https://gateway.example/v1 --model acme-large
roos providers remove acme-gateway
```

`--template` 为 `ollama-local`、`ollama-cloud`、`openai`、`anthropic`、`xai`、`moonshotai`、`openrouter`、`groq` 或 `custom` 之一。省略的 flag 会在 TTY 上提示。对脚本而言，完全由 flag 驱动的调用是有效的。

API 密钥绝不会作为 argv 值。命令在隐藏的 TTY 行上提示，或读取一行 stdin，然后通过 `ctx.credentials.set` 以 `0600` 存储。设置中只保留 `credential-ref` 名称（`apiKeyEnv`）。

`remove` 会取消设置用户拥有的 `llm-pi-ai` 路由。移除 `openai` 这类随附模板只会清除用户覆盖，随附路由仍然保留。像 `deepseek-official` 这样由组合拥有的路由不能在此移除。

## 在会话中途切换

在组合了命令注册表的会话中，`/model` 会打印当前选择以及已公布的推理强度。`/model <provider> <model> [--effort <level>]` 会写入会话的 `ModelSelection`，供下一轮组装的请求使用，并同时通过 `saveSelection()` 把该配对写成进程级默认值，供后续会话和 Settings → Models 使用。该手势由用户发出：`command/run` 记录 `source: { kind: 'user' }`，模型不能把它当作工具调用。子代理会话上的 `/model` 会被拒绝，以免子会话切换改写根默认值。
